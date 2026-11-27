import { useState } from "react";
import { Alert, Platform, Share } from "react-native";
import { useRpc, useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { openWorkspaceFile } from "../shared/contracts";
import { shareAndroidFile } from "./android-file-share";
import { Control } from "./controls";
import { messages } from "./messages";
import { downloadLocalFile } from "./web";

type DesktopBridge = { invoke?(command: "desktop_daemon_status"): Promise<unknown> };

async function isDesktopLocalHost(desktop: DesktopBridge, hostId: string) {
  const status = await desktop.invoke?.("desktop_daemon_status").catch(() => null);
  return typeof status === "object" && status !== null &&
    "serverId" in status && status.serverId === hostId;
}

export function ExternalFileAction({ file, workspaceId, host, theme, layout }: PluginFilePanelProps) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const openLocal = useRpc(openWorkspaceFile);
  const [opening, setOpening] = useState(false);
  const desktop = Platform.OS === "web"
    ? (globalThis as typeof globalThis & { paseoDesktop?: DesktopBridge }).paseoDesktop
    : undefined;
  const showAndroidFallback = () => {
    Alert.alert(t("externalFile"), t("externalAndroid"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("copyFilePath"),
        onPress: () => {
          void copyText(file.path).then(() => toast.show(t("copied"), { variant: "success" }),
            () => toast.error(t("externalError")));
        },
      },
    ], { cancelable: true });
  };
  const open = async () => {
    setOpening(true);
    try {
      if (Platform.OS === "android") {
        if (!await shareAndroidFile(file, file.name)) showAndroidFallback();
        return;
      }
      if (desktop && await isDesktopLocalHost(desktop, host.id)) {
        await openLocal({ workspaceId, path: file.path });
        return;
      }
      const url = await file.url();
      if (Platform.OS === "ios" && url.startsWith("file:")) await Share.share({ url });
      else if (Platform.OS === "web") downloadLocalFile(url, file.name);
      else throw new Error("Unsupported file URL.");
    } catch {
      if (Platform.OS === "android") showAndroidFallback();
      else toast.error(t("externalError"));
    } finally {
      setOpening(false);
    }
  };
  return (
    <Control title={t(Platform.OS === "web" && !desktop ? "downloadFile" : "externalFile")}
      theme={theme} compact={layout.compact} disabled={opening} onPress={() => { void open(); }} />
  );
}
