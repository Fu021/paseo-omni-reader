import { useCallback, useEffect, useLayoutEffect, useState, type ComponentType, type ReactNode } from "react";
import { Modal, SafeAreaView, Text, View } from "react-native";
import { useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { Icon, Loading } from "@getpaseo/plugin/client/ui";
import { Control, type Theme } from "./controls";
import { messages } from "./messages";
import { createReaderOpenGate } from "./reader-open-gate";
import { IsolatedReader } from "./reader-scroll";

const readerIcon = {
  svg: '<svg viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="4" fill="#141052"/><path fill="#f8f4e8" d="M3.5 7C3.5 5.5 9.5 5.8 11.8 8v10c-2.6-1.8-5.1-2-7.7-1.3-.4.1-.6 0-.6-.4zm17 0v9.3c0 .4-.2.5-.6.4-2.6-.7-5.1-.5-7.7 1.3V8c2.3-2.2 8.3-2.5 8.3-1z"/><path fill="#64a386" d="M12.2 8c.4-.4.9-.7 1.4-.9v6.4l-.7-.8-.7.8z"/></svg>',
};

type ReaderTab = PluginFilePanelProps["tab"] & {
  active?: boolean;
  close?: () => void;
};

type Presentation = "initial" | "fullScreen" | "desktop" | "embedded" | "ignored";

const claimReaderOpen = createReaderOpenGate();

function DesktopReaderBody({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setShown(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return shown ? children : <Loading />;
}

function FullScreenReader({ header, theme, close, children }: {
  header: ReactNode; theme: Theme; close: () => void; children: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  return (
    <Modal visible presentationStyle="fullScreen" onRequestClose={close} onShow={() => setShown(true)}
      animationType="none" allowSwipeDismissal={false} hardwareAccelerated
      supportedOrientations={["portrait", "landscape"]}>
      <SafeAreaView accessibilityViewIsModal onAccessibilityEscape={close}
        style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <IsolatedReader.Provider value>
          {header}
          {shown ? children : <Loading />}
        </IsolatedReader.Provider>
      </SafeAreaView>
    </Modal>
  );
}

export function fileReader(Reader: ComponentType<PluginFilePanelProps>) {
  function ReaderPresentation({ props, fileKey }: { props: PluginFilePanelProps; fileKey: string }) {
    const { file, layout, tab, theme } = props;
    const { t } = useTranslation(messages);
    const { active, close: closeTab } = tab as ReaderTab;
    const native = layout.platform !== "web";
    const [owner] = useState(() => Symbol());
    const [nativeLayoutReady, setNativeLayoutReady] = useState(false);
    const [presentation, setPresentation] = useState<Presentation>("initial");
    const requestOpen = useCallback(() => {
      if (!claimReaderOpen(fileKey, owner)) return false;
      setPresentation(native ? "fullScreen" : "desktop");
      return true;
    }, [fileKey, native, owner]);
    const canOpen = active !== false && (!native || active === true || nativeLayoutReady);
    useLayoutEffect(() => {
      if (presentation === "initial" && canOpen && !requestOpen()) setPresentation("ignored");
    }, [canOpen, presentation, requestOpen]);
    useEffect(() => {
      if (presentation !== "ignored" || active === false || !closeTab) return;
      const timeout = setTimeout(closeTab, 0);
      return () => clearTimeout(timeout);
    }, [active, closeTab, presentation]);
    const fullScreen = presentation === "fullScreen" && active !== false;
    const awaitNativeLayout = native && active === undefined && presentation === "initial" && !nativeLayoutReady;
    const showClose = fullScreen || (!layout.compact && !!closeTab);
    const close = closeTab ?? (() => setPresentation("embedded"));
    const header = (
      <View testID="omni-reader-header" style={{
        flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32,
        paddingLeft: 12, paddingRight: 4, borderBottomWidth: 1, borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      }}>
        <Icon icon={readerIcon} size={17} />
        <Text numberOfLines={1} accessibilityRole="header"
          style={{ flex: 1, color: theme.colors.foreground, fontSize: 13 }}>{file.name}</Text>
        {(presentation === "ignored" || (native && presentation === "embedded")) && (
          <Control
            icon={native ? "Maximize" : "BookOpenText"}
            title={t(native ? "fullScreenReader" : "preview")}
            onPress={requestOpen} theme={theme} compact={native}
          />
        )}
        {showClose && (
          <Control icon="X" title={t("closeReader")} onPress={close} theme={theme} compact={native} />
        )}
      </View>
    );
    if (awaitNativeLayout) {
      return (
        <View collapsable={false} style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}
          onLayout={({ nativeEvent: { layout: bounds } }) => {
            if (bounds.width > 0 && bounds.height > 0) {
              setNativeLayoutReady(true);
            }
          }} />
      );
    }
    if (fullScreen) {
      return (
        <FullScreenReader {...{ header, theme, close }}>
          <Reader key={file.path} {...props} />
        </FullScreenReader>
      );
    }
    return (
      <View style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
        {header}
        {presentation === "desktop" && (
          <DesktopReaderBody key={file.path}>
            <Reader {...props} />
          </DesktopReaderBody>
        )}
      </View>
    );
  }

  return function OmniFileReader(props: PluginFilePanelProps) {
    const fileKey = JSON.stringify([props.host.id, props.workspaceId, props.file.path]);
    return <ReaderPresentation key={fileKey} props={props} fileKey={fileKey} />;
  };
}
