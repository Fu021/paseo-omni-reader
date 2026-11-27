import { spawn } from "node:child_process";
import { markdownExtensions, officeExtensions } from "../shared/contracts";
import { withWorkspaceFile } from "./workspace-file";

function launch(command: string, args: string[], options?: NodeJS.ProcessEnv): Promise<void> {
  const env = { ...process.env, ...options };
  for (const key of [
    "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "PASEO_DESKTOP_MANAGED", "PASEO_SUPERVISED", "PASEO_NODE_ENV",
  ]) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "ignore", detached: true, windowsHide: true });
    const settle = setTimeout(() => reject(new Error("The system did not confirm opening the file.")), 10_000);
    child.unref();
    child.once("error", (error) => {
      clearTimeout(settle);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(settle);
      if (code === 0) resolve();
      else reject(new Error("The system could not open the file."));
    });
  });
}

export async function openWithDefaultApp(directory: string, path: string) {
  const target = await withWorkspaceFile(directory, path, ["pdf", ...officeExtensions, ...markdownExtensions],
    async (_file, _size, _revision, resolvedPath) => resolvedPath);
  switch (process.platform) {
    case "darwin":
      return launch("/usr/bin/open", [target]);
    case "win32":
      return launch("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "Invoke-Item -LiteralPath $env:PASEO_OMNI_READER_FILE -ErrorAction Stop",
      ], { PASEO_OMNI_READER_FILE: target });
    case "linux":
      return launch("gio", ["open", target]).catch(() => launch("xdg-open", [target]));
    default:
      throw new Error("Opening files is unavailable on this system.");
  }
}
