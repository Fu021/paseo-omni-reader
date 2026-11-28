import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { View } from "react-native";
import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { Loading } from "@getpaseo/plugin/client/ui";
import { ReaderNotices } from "./reader-notice";

function DeferredReaderBody({ active, children }: { active: boolean; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active || shown) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setShown(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [active, shown]);
  return shown ? children : <Loading />;
}

export function fileReader(Reader: ComponentType<PluginFilePanelProps>) {
  function ReaderPresentation({ props }: { props: PluginFilePanelProps }) {
    const { layout, tab, theme } = props;
    const { active } = tab as typeof tab & { active?: boolean };
    const native = layout.platform !== "web";
    const [nativeLayoutReady, setNativeLayoutReady] = useState(false);
    const canOpen = active !== false && (!native || active === true || nativeLayoutReady);
    const awaitNativeLayout = native && active === undefined && !nativeLayoutReady;
    return (
      <View collapsable={false} style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}
        onLayout={awaitNativeLayout ? ({ nativeEvent: { layout: bounds } }) => {
          if (bounds.width > 0 && bounds.height > 0) setNativeLayoutReady(true);
        } : undefined}>
        <DeferredReaderBody active={canOpen}>
          <ReaderNotices theme={theme}><Reader {...props} /></ReaderNotices>
        </DeferredReaderBody>
      </View>
    );
  }

  return function OmniFileReader(props: PluginFilePanelProps) {
    const fileKey = JSON.stringify([props.host.id, props.workspaceId, props.file.path]);
    return <ReaderPresentation key={fileKey} props={props} />;
  };
}
