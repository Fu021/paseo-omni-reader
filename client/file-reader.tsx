import type { ComponentType } from "react";
import { Text, View } from "react-native";
import { useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { CloseButton } from "./controls";
import { messages } from "./messages";

const readerIcon = {
  svg: '<svg viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="4" fill="#141052"/><path fill="#f8f4e8" d="M3.5 7C3.5 5.5 9.5 5.8 11.8 8v10c-2.6-1.8-5.1-2-7.7-1.3-.4.1-.6 0-.6-.4zm17 0v9.3c0 .4-.2.5-.6.4-2.6-.7-5.1-.5-7.7 1.3V8c2.3-2.2 8.3-2.5 8.3-1z"/><path fill="#64a386" d="M12.2 8c.4-.4.9-.7 1.4-.9v6.4l-.7-.8-.7.8z"/></svg>',
};

type ReaderTab = PluginFilePanelProps["tab"] & {
  close?: () => void;
};

export function fileReader(Reader: ComponentType<PluginFilePanelProps>) {
  return function OmniFileReader(props: PluginFilePanelProps) {
    const { file, layout, tab, theme } = props;
    const { t } = useTranslation(messages);
    const { close: closeTab } = tab as ReaderTab;
    return (
      <View style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
        <View testID="omni-reader-header" style={{
          flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32,
          paddingLeft: 12, paddingRight: 4, borderBottomWidth: 1, borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface0,
        }}>
          <Icon icon={readerIcon} size={17} />
          <Text numberOfLines={1} accessibilityRole="header"
            style={{ flex: 1, color: theme.colors.foreground, fontSize: 13 }}>{file.name}</Text>
          {!layout.compact && closeTab && <CloseButton label={t("closeReader")} onPress={closeTab} theme={theme} />}
        </View>
        <Reader key={file.path} {...props} />
      </View>
    );
  };
}
