import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Keyboard, Platform, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { markdownSearchPageSize, searchMarkdownFile, type MarkdownSearchOptions } from "../shared/contracts";
import { Control, ReaderInput, type Theme } from "./controls";
import { messages } from "./messages";
import { bindReaderFind, focusWebReader } from "./web";

type SearchTarget = Pick<RpcInput<typeof searchMarkdownFile>, "workspaceId" | "path">;
export type MarkdownMatch = RpcOutput<typeof searchMarkdownFile>["hits"][number];
const emptyMatches: MarkdownMatch[] = [];
const emptyResults: never[] = [];

type FindActions = Omit<Parameters<typeof bindReaderFind>[2], "focusReader">;

export function useReaderFindVisibility() {
  const [findOpen, setFindOpen] = useState(false);
  const showFind = useCallback(() => setFindOpen(true), []);
  const hideFind = useCallback(() => {
    if (Platform.OS !== "web") Keyboard.dismiss();
    setFindOpen(false);
  }, []);
  return { findOpen, showFind, hideFind };
}

export function useReaderFindShortcuts(root: RefObject<View | null>, testID: string, enabled: boolean, actions: FindActions,
  viewport?: RefObject<View | null>) {
  const current = useRef(actions);
  current.current = actions;
  useEffect(() => {
    if (!enabled) return;
    return bindReaderFind(root.current, testID, {
      open: () => current.current.open(), close: () => current.current.close(),
      move: (step) => current.current.move(step), isOpen: () => current.current.isOpen(),
      focusReader: viewport ? () => focusWebReader(viewport.current) : undefined,
    });
  }, [root, testID, enabled, viewport]);
}

export function useFindCriteria(open: boolean) {
  const [criteria, setCriteria] = useState({
    query: "", options: { matchCase: false, wholeWord: false, regex: false },
  });
  const [settled, setSettled] = useState(criteria);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!open || settled === criteria) return;
    const timeout = setTimeout(() => setSettled(criteria), 180);
    return () => clearTimeout(timeout);
  }, [criteria, open, settled]);
  const ready = open && !!settled.query && criteria === settled;
  return {
    criteria, settled, ready, index, setIndex,
    changeQuery: (query: string) => {
      if (query === criteria.query) return;
      setIndex(0);
      setCriteria((prior) => ({ ...prior, query }));
    },
    toggle: (option: keyof MarkdownSearchOptions) => {
      setIndex(0);
      setCriteria((prior) => ({ ...prior, options: { ...prior.options, [option]: !prior.options[option] } }));
    },
  };
}

export function useMarkdownFind(target: SearchTarget, fileKey: readonly unknown[], open: boolean) {
  const search = useRpc(searchMarkdownFile);
  const { criteria, settled, ready, index, setIndex, changeQuery, toggle } = useFindCriteria(open);
  const queryPage = (offset: number) => ({
    queryKey: [...fileKey, "find", settled, offset],
    queryFn: () => search({ ...target, ...settled, offset }),
    staleTime: Infinity,
    gcTime: 30_000,
    retry: false,
  });
  const first = useQuery({ ...queryPage(0), enabled: ready });
  const total = ready ? first.data?.total ?? 0 : 0;
  const selected = Math.min(index, Math.max(0, total - 1));
  const offset = Math.floor(selected / markdownSearchPageSize) * markdownSearchPageSize;
  const later = useQuery({ ...queryPage(offset), enabled: ready && !!offset });
  const page = offset ? later : first;
  const hits = ready ? page.data?.hits ?? emptyMatches : emptyMatches;
  return {
    ...criteria, hits, active: hits[selected - offset], index: selected, total,
    changeQuery, toggle,
    move: (step: number) => {
      if (total && !page.isFetching) setIndex((prior) => (Math.min(prior, total - 1) + step + total) % total);
    },
    error: ready && page.isError,
    invalid: ready && first.data?.invalidPattern === true,
    pending: !!criteria.query && (!ready || first.isPending || page.isPending),
    retry: () => { void page.refetch(); },
  };
}

type FindCriteria = { query: string; options: MarkdownSearchOptions };
type FindResults<Match> = { matches: Match[]; limited: boolean; invalidPattern: boolean };

export function useFindResults<Match>(fileKey: readonly unknown[], open: boolean,
  search: (criteria: FindCriteria) => Promise<FindResults<Match> | null>) {
  const { criteria, settled, ready, index, setIndex, changeQuery, toggle } = useFindCriteria(open);
  const result = useQuery({
    queryKey: [...fileKey, "find", settled],
    queryFn: () => search(settled),
    enabled: ready, staleTime: Infinity, gcTime: 30_000, retry: false,
  });
  const matches = ready ? result.data?.matches ?? emptyResults : emptyResults;
  const total = matches.length;
  const selected = Math.min(index, Math.max(0, total - 1));
  return {
    ...criteria, matches, active: matches[selected], index: selected, total,
    changeQuery, toggle, reset: () => setIndex(0),
    move: (step: number) => {
      if (total) setIndex((prior) => (Math.min(prior, total - 1) + step + total) % total);
    },
    limited: ready && result.data?.limited === true,
    invalid: ready && result.data?.invalidPattern === true,
    error: ready && result.isError,
    pending: !!criteria.query && (!ready || result.isPending),
    retry: () => { void result.refetch(); },
  };
}

export function ReaderFindPopup({ theme, testID, children }: {
  theme: Theme; testID?: string; children: ReactNode;
}) {
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", top: 4, left: 4, right: 4, zIndex: 2 }}>
      <View testID={testID} style={{
        alignSelf: "flex-end", width: "100%", maxWidth: 520,
        backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1,
        padding: 4, borderRadius: 6, gap: 4,
      }}>{children}</View>
    </View>
  );
}

export function ReaderFindBar({ find, theme, compact, close, testID, option, placeholder, textOptions = true }: {
  find: Omit<ReturnType<typeof useMarkdownFind>, "hits" | "active"> & { limited?: boolean };
  theme: Theme; compact: boolean; close: () => void; testID: string;
  option?: ReactNode; placeholder?: string; textOptions?: boolean;
}) {
  const { t } = useTranslation(messages);
  const web = Platform.OS === "web";
  const status = !find.query ? "" : find.invalid ? t("invalidPattern") : find.error ? t("findFailed")
    : find.pending ? t("searching") : !find.total ? t(find.limited ? "findLimited" : "noMatches") : "";
  return (
    <ReaderFindPopup theme={theme} testID={testID}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 3, flexWrap: "wrap" }}>
        <View style={{ flexBasis: 178, flexGrow: 1, flexShrink: 1, flexDirection: "row", alignItems: "center",
          borderWidth: 1, borderColor: find.invalid ? theme.colors.statusDanger : theme.colors.border, borderRadius: 4 }}>
          <ReaderInput theme={theme} value={find.query} onChangeText={find.changeQuery} autoFocus={web}
            autoCorrect={false} autoCapitalize="none" selectTextOnFocus
            accessibilityLabel={t("find")} placeholder={placeholder ?? t("searchPlaceholder")}
            returnKeyType="search" submitBehavior="submit" onSubmitEditing={() => find.move(1)} maxLength={256}
            style={{ borderWidth: 0, minWidth: 48, paddingHorizontal: 6, minHeight: 28, fontSize: 13 }} />
          <Control title={t("matchCase")} label="Aa" theme={theme} compact={compact} small
            selected={textOptions && find.options.matchCase} disabled={!textOptions} onPress={() => find.toggle("matchCase")} />
          <Control title={t("wholeWord")} label="ab" theme={theme} compact={compact} small
            selected={textOptions && find.options.wholeWord} disabled={!textOptions} onPress={() => find.toggle("wholeWord")} />
          <Control title={t("useRegex")} label=".*" theme={theme} compact={compact} small
            selected={textOptions && find.options.regex} disabled={!textOptions} onPress={() => find.toggle("regex")} />
          {option}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2, marginLeft: "auto" }}>
          {find.total > 0 && (
            <Text testID={`${testID.replace(/-find$/, "")}-match-count`} accessibilityLiveRegion="polite" numberOfLines={1}
              style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"], paddingHorizontal: 4 }}>
              {find.index + 1} / {find.total}{find.limited ? "+" : ""}
            </Text>
          )}
          <Control title={t("previousMatch")} icon="ArrowUp" theme={theme} compact={compact} small
            disabled={!find.total || find.pending || find.error} onPress={() => find.move(-1)} />
          <Control title={t("nextMatch")} icon="ArrowDown" theme={theme} compact={compact} small
            disabled={!find.total || find.pending || find.error} onPress={() => find.move(1)} />
          <Control title={t("closeFind")} icon="X" theme={theme} compact={compact} small onPress={close} />
        </View>
      </View>
      {!!status && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 3 }}>
          <Text accessibilityLiveRegion="polite" style={{ flex: 1, fontSize: 12,
            color: find.invalid || find.error ? theme.colors.statusDanger : theme.colors.foregroundMuted }}>{status}</Text>
          {find.error && <Control title={t("retry")} onPress={find.retry} small theme={theme} compact={compact} />}
        </View>
      )}
    </ReaderFindPopup>
  );
}
