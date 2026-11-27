import { useTranslation, type PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";
import { useEffect, useState, type ReactNode } from "react";
import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { messages } from "./messages";

export type Theme = PluginHostProps["theme"];

export function CloseButton({ label, onPress, theme }: { label: string; onPress: () => void; theme: Theme }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => ({
        width: 40, height: 40, alignItems: "center", justifyContent: "center",
        borderRadius: 6, backgroundColor: pressed ? theme.colors.surface2 : "transparent",
      })}>
      <Icon name="X" size={20} color={theme.colors.foreground} />
    </Pressable>
  );
}

export function Control({
  title, label = title, theme, compact, disabled = false, selected, onPress,
}: {
  title: string;
  label?: string;
  theme: Theme;
  compact: boolean;
  disabled?: boolean;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      style={({ pressed }) => ({
        height: compact ? 40 : 32,
        minWidth: compact ? 40 : 32,
        paddingHorizontal: 8,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: selected || pressed ? theme.colors.surface2 : "transparent",
        opacity: disabled ? 0.45 : 1,
      })}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: selected ? "600" : "500" }}>
        {title}
      </Text>
    </Pressable>
  );
}

export function Toolbar({ theme, children }: { theme: Theme; children: ReactNode }) {
  return (
    <View style={{
      alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 4,
      paddingHorizontal: 8, paddingVertical: 4, borderBottomWidth: 1,
      borderBottomColor: theme.colors.border, backgroundColor: theme.colors.surface0,
    }}>{children}</View>
  );
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
