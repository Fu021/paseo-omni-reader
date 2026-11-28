import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Text, View } from "react-native";
import { useTranslation } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { Theme } from "./controls";
import { messages } from "./messages";
import { bindReaderCopy } from "./web";

const NoticeContext = createContext<((text: string, error?: boolean) => void) | undefined>(undefined);

export function useReaderNotice() {
  return useContext(NoticeContext);
}

export function ReaderNotices({ children, theme }: { children: ReactNode; theme: Theme }) {
  const { t } = useTranslation(messages);
  const root = useRef<View>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const notify = useCallback((text: string, error = false) => setNotice({ text, error }), []);
  const copied = t("copied");
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 2200);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (Platform.OS === "web") return bindReaderCopy(root.current, () => notify(copied));
  }, [copied, notify]);
  return (
    <View ref={root} style={{ flex: 1, minHeight: 0 }}>
      <NoticeContext.Provider value={notify}>{children}</NoticeContext.Provider>
      {!!notice && (
        <View pointerEvents="none" testID="omni-reader-notice"
          style={{ position: "absolute", left: 0, right: 0, top: 8, alignItems: "center" }}>
          <View style={{ borderRadius: 16, borderWidth: 1, borderColor: theme.colors.border,
            paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 8,
            backgroundColor: theme.colors.surface0 }}>
            <Icon name={notice.error ? "CircleAlert" : "CheckCircle2"} size={18}
              color={notice.error ? theme.colors.statusDanger : theme.colors.accent} />
            <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foreground }}>{notice.text}</Text>
          </View>
        </View>
      )}
    </View>
  );
}
