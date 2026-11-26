import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

export async function workspaceDirectory(paseo: PluginHandlerContext["paseo"], id: string) {
  const handle = paseo.workspaces.ref(id);
  await handle.refresh();
  if (!handle.directory) throw new Error("Workspace is unavailable.");
  return handle.directory;
}

function assertInside(root: string, path: string) {
  const child = relative(root, path);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("File is outside the workspace.");
  }
}

export function revisionOf(info: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

export async function withWorkspaceFile<Result>(
  directory: string,
  path: string,
  extensions: readonly string[],
  read: (file: FileHandle, size: number, revision: string) => Promise<Result>,
): Promise<Result> {
  const extension = (file: string) => extname(file).slice(1).toLowerCase();
  const root = await realpath(directory);
  const lexical = resolve(isAbsolute(path) ? directory : root, path);
  const workspaceRelative = relative(resolve(directory), lexical);
  const candidate = isAbsolute(path) ? resolve(root, workspaceRelative) : lexical;
  assertInside(root, candidate);
  const actual = await realpath(candidate);
  assertInside(root, actual);
  if (!extensions.includes(extension(candidate)) || !extensions.includes(extension(actual))) {
    throw new Error("Unsupported file type.");
  }
  const file = await open(
    actual,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const info = await file.stat({ bigint: true });
    const confirmed = await realpath(candidate);
    assertInside(root, confirmed);
    const current = await stat(confirmed, { bigint: true });
    if (!info.isFile() || current.ino !== info.ino || current.dev !== info.dev) {
      throw new Error("File is no longer available.");
    }
    const revision = revisionOf(info);
    const value = await read(file, Number(info.size), revision);
    if (revision !== revisionOf(await file.stat({ bigint: true }))) {
      throw new Error("File changed while reading. Reload the file.");
    }
    return value;
  } finally {
    await file.close();
  }
}
