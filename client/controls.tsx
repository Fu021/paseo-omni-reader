import { useTranslation, type PluginHostProps } from "@getpaseo/plugin/client";
import { Icon, WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { Platform, Pressable, Text, TextInput, View, type TextInputProps, type ViewStyle } from "react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { messages } from "./messages";
import { setWebTitle } from "./web";

export type Theme = PluginHostProps["theme"];

const readerIcon = {
  svg: '<svg viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="4" fill="#141052"/><path fill="#f8f4e8" d="M3.5 7C3.5 5.5 9.5 5.8 11.8 8v10c-2.6-1.8-5.1-2-7.7-1.3-.4.1-.6 0-.6-.4zm17 0v9.3c0 .4-.2.5-.6.4-2.6-.7-5.1-.5-7.7 1.3V8c2.3-2.2 8.3-2.5 8.3-1z"/><path fill="#64a386" d="M12.2 8c.4-.4.9-.7 1.4-.9v6.4l-.7-.8-.7.8z"/></svg>',
};

export function useWebTitle<T = View>(value?: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (Platform.OS === "web" && value) return setWebTitle(ref.current, value);
  }, [value]);
  return ref;
}

export function Control({ title, icon, label, theme, compact, disabled = false, selected, small, onPress }: {
  title: string;
  icon?: string;
  label?: string;
  theme: Theme;
  compact: boolean;
  disabled?: boolean;
  selected?: boolean;
  small?: boolean;
  onPress: () => void;
}) {
  const hint = useWebTitle(icon || label ? title : undefined);
  const size = small ? 25 : compact ? 40 : 32;
  return (
    <Pressable
      ref={hint}
      onPress={onPress}
      hitSlop={small ? 4 : undefined}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled, selected }}
      {...(Platform.OS === "web" && selected !== undefined ? { "aria-pressed": selected } : {})}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        height: size,
        minWidth: size,
        paddingHorizontal: icon ? 0 : 8,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: selected || pressed || hovered ? theme.colors.surface2 : "transparent",
        opacity: disabled ? 0.45 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={small ? 14 : 18} color={small ? theme.colors.foregroundMuted : theme.colors.foreground} /> : (
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: selected ? "600" : "500" }}>
          {label ?? title}
        </Text>
      )}
    </Pressable>
  );
}

export function ReaderFileBadge({ size, lines }: { size?: number; lines?: number }) {
  const { t, locale } = useTranslation(messages);
  const labels: string[] = [];
  if (size !== undefined) {
    const [unit, divisor]: [string, number] = size < 1024 ? ["B", 1] : size < 1024 ** 2 ? ["KiB", 1024]
      : size < 1024 ** 3 ? ["MiB", 1024 ** 2] : ["GiB", 1024 ** 3];
    labels.push(`${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(size / divisor)} ${unit}`);
  }
  if (lines !== undefined) labels.push(t("fileLines", { lines: new Intl.NumberFormat(locale).format(lines) }));
  if (!labels.length) return null;
  return <WorkspaceRowBadge label={labels.join(" · ")} />;
}

export function Toolbar({ theme, children, filePanel, lines, nativePrimary }: {
  theme: Theme; children: ReactNode; filePanel?: PluginFilePanelProps; lines?: number; nativePrimary?: ReactNode;
}) {
  const { t } = useTranslation(messages);
  const row: ViewStyle = {
    alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 4, paddingHorizontal: 8, paddingVertical: 4,
  };
  const background = { borderBottomWidth: 1, borderBottomColor: theme.colors.border, backgroundColor: theme.colors.surface0 };
  const tab = filePanel?.tab as (PluginFilePanelProps["tab"] & { close?: () => void }) | undefined;
  const native = Platform.OS !== "web";
  const close = !native && filePanel && !filePanel.layout.compact ? tab?.close : undefined;
  return (
    <View style={background}>
      {filePanel && (
        <View testID="omni-reader-brand" style={[row, { flexWrap: "nowrap", gap: 8 }]}>
          <View testID="omni-reader-icon" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
            pointerEvents="none" style={{ flexShrink: 0 }}>
            <Icon icon={readerIcon} size={32} />
          </View>
          <Text numberOfLines={1}
            style={{ flexShrink: 1, minWidth: 0, color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>
            Omni Reader
          </Text>
          <View testID={lines === undefined ? "omni-file-metadata" : "omni-markdown-metadata"}
            style={{ marginLeft: "auto", flexShrink: 1, minWidth: 0 }}>
            <ReaderFileBadge size={filePanel.file.size} lines={lines} />
          </View>
          {close && <Control icon="X" title={t("closeReader")} theme={theme} compact={false} onPress={close} />}
        </View>
      )}
      {native && nativePrimary && (
        <View style={[row, { paddingBottom: 0 }]}>{nativePrimary}</View>
      )}
      <View style={row}>
        {children}
      </View>
    </View>
  );
}

export function ReaderInput({ theme, style, ...props }: TextInputProps & { theme: Theme }) {
  return <TextInput {...props} style={[{
    flexGrow: 1, flexShrink: 1, minWidth: 84, paddingHorizontal: 8, paddingVertical: 5,
    color: theme.colors.foreground, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 6,
  }, style]} placeholderTextColor={theme.colors.foregroundMuted} />;
}

export function ReadError({ theme, label, error, retry, onRetry, compact }: {
  theme: Theme; label: string; error: unknown; retry: string; onRetry: () => void; compact: boolean;
}) {
  const { t } = useTranslation(messages);
  const message = error instanceof Error ? error.message : "";
  const detail = message.includes("128 MiB reader limit") ? t("pdfTooLarge")
    : message.includes("Document exceeds the preview limit") ? t("documentTooLarge")
    : message.includes("supports UTF-8") ? t("textEncoding")
    : message.includes("File changed") || message.includes("File ended") ? t("fileChanged")
    : message.includes("outside the workspace") ? t("outsideWorkspace")
    : message.includes("File is no longer available") || message.includes("ENOENT") ? t("fileUnavailable")
    : undefined;
  return (
    <View accessibilityRole="alert" style={{ alignItems: "flex-start", gap: 6, padding: 16 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{label}</Text>
      {detail && <Text selectable style={{ color: theme.colors.foregroundMuted }}>{detail}</Text>}
      <Control title={retry} onPress={onRetry} theme={theme} compact={compact} />
    </View>
  );
}

export function useFileGeneration(file: PluginFilePanelProps["file"]) {
  const [generation, setGeneration] = useState(0);
  useEffect(() => file.watch(() => setGeneration((value) => value + 1)), [file]);
  return generation;
}
