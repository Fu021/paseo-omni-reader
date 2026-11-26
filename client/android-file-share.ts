import type { PluginFile } from "@getpaseo/plugin/client";

interface ExpoSharingModule {
  shareAsync(url: string, options: { dialogTitle: string; mimeType?: string }): Promise<void>;
}

export async function shareAndroidFile(
  file: Pick<PluginFile, "url" | "mimeType">,
  dialogTitle: string,
): Promise<boolean> {
  const { expo } = globalThis as typeof globalThis & {
    expo?: { modules?: { ExpoSharing?: ExpoSharingModule } };
  };
  const sharing = expo?.modules?.ExpoSharing;
  if (typeof sharing?.shareAsync !== "function") return false;

  const url = await file.url();
  if (!url.startsWith("file:///")) return false;
  const mimeType = file.mimeType.trim().toLowerCase();
  await sharing.shareAsync(url, {
    dialogTitle,
    mimeType: mimeType && mimeType !== "application/octet-stream" ? mimeType : undefined,
  });
  return true;
}
