import { useState } from "react";
import { Alert, Platform, Share } from "react-native";
import { useTranslation, type PluginFile } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { shareAndroidFile } from "./android-file-share";
import { Control, type Theme } from "./controls";
import { messages } from "./messages";
import { downloadLocalFile } from "./web";

export function ExternalFileAction({ file, theme, compact }: { file: PluginFile; theme: Theme; compact: boolean }) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const [opening, setOpening] = useState(false);
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
    <Control title={t("externalFile")} theme={theme} compact={compact} disabled={opening} onPress={() => { void open(); }} />
  );
}
