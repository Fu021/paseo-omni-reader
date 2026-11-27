import { useState } from "react";
import { Alert, Platform, Share } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { openWorkspaceFile } from "../shared/contracts";
import { shareAndroidFile } from "./android-file-share";
import { Control } from "./controls";
import { messages } from "./messages";
import { downloadLocalFile } from "./web";

type DesktopBridge = { invoke(command: "desktop_daemon_status"): Promise<unknown> };

async function desktopDaemonId(desktop: DesktopBridge) {
  const status = await desktop.invoke("desktop_daemon_status");
  return typeof status === "object" && status !== null && "status" in status && status.status === "running" &&
    "serverId" in status && typeof status.serverId === "string" ? status.serverId : null;
}

export function ExternalFileAction({ file, workspaceId, host, theme, layout }: PluginFilePanelProps) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const openLocal = useRpc(openWorkspaceFile);
  const [opening, setOpening] = useState(false);
  const desktop = Platform.OS === "web" && typeof window !== "undefined"
    ? (window as Window & { paseoDesktop?: DesktopBridge }).paseoDesktop
    : undefined;
  const localDaemon = useQuery({
    queryKey: ["omni-reader", "desktop-daemon"],
    queryFn: () => desktopDaemonId(desktop!),
    enabled: typeof desktop?.invoke === "function",
    staleTime: 5_000,
    retry: false,
  });
  const localFile = Boolean(localDaemon.data) && localDaemon.data === host.id;
  const checking = typeof desktop?.invoke === "function" && localDaemon.isPending;
  const download = Platform.OS === "web" && !localFile;
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
      if (localFile) {
        await openLocal({ workspaceId, path: file.path });
        return;
      }
      const url = await file.url();
      if (Platform.OS === "ios" && url.startsWith("file:")) await Share.share({ url });
      else if (Platform.OS === "web") downloadLocalFile(url, file.name);
      else throw new Error("Unsupported file URL.");
    } catch {
      if (Platform.OS === "android") showAndroidFallback();
      else toast.error(t(localFile ? "externalAppError" : download ? "downloadError" : "externalError"));
    } finally {
      setOpening(false);
    }
  };
  return (
    <Control title={t(download ? "downloadFile" : "externalFile")} icon={download ? "Download" : "ExternalLink"}
      theme={theme} compact={layout.compact} disabled={opening || checking} onPress={() => { void open(); }} />
  );
}
