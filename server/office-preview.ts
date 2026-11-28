import { execFile } from "node:child_process";
import { extname, join } from "node:path";
import { DOMParser, onErrorStopParsing } from "@xmldom/xmldom";
import { fromBufferPromise } from "yauzl";
import { pagedOfficeExtensions, type MarkdownSearchOptions } from "../shared/contracts";
import type { createEngine } from "./engine";
import { officeDirectory } from "./office-location";
import { withWorkspaceFile } from "./workspace-file";
import type { EngineResults } from "./worker-protocol";

const maxOfficeBytes = 24 * 1024 * 1024;
const maxPreviewBytes = 32 * 1024 * 1024;
const documentPart = { docx: "word/document.xml", pptx: "ppt/presentation.xml" };
const relationshipNamespace = "http://schemas.openxmlformats.org/package/2006/relationships";
const externalOrActivePart = /(?:^|\/)(?:activeX|externalLinks|oleObject[^/]*|vbaProject\.bin)(?:\/|$)/i;

async function supportsFormattedPreview(content: Buffer, extension: string) {
  if (!Object.hasOwn(documentPart, extension)) return false;
  const archive = await fromBufferPromise(content, { lazyEntries: true, validateEntrySizes: true }).catch(() => null);
  if (!archive) return false;
  const parser = new DOMParser({ onError: onErrorStopParsing });
  const entries = new Set<string>();
  let relationshipBytes = 0;
  let unpackedBytes = 0;
  try {
    if (archive.entryCount > 8_000) return false;
    for await (const entry of archive.eachEntry()) {
      const { fileName, uncompressedSize } = entry;
      unpackedBytes += uncompressedSize;
      if (unpackedBytes > 256 * 1024 * 1024) return false;
      const normalizedName = fileName.toLowerCase();
      if (externalOrActivePart.test(fileName) || entries.has(normalizedName)) return false;
      entries.add(normalizedName);
      if (!normalizedName.endsWith(".rels")) continue;
      relationshipBytes += uncompressedSize;
      if (relationshipBytes > 2 * 1024 * 1024) return false;
      const stream = await archive.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      const source = Buffer.concat(chunks).toString("utf8");
      if (source.includes("\0") || /<!DOCTYPE/i.test(source)) return false;
      const root = parser.parseFromString(source, "application/xml").documentElement;
      if (root?.namespaceURI !== relationshipNamespace || root.localName !== "Relationships") return false;
      for (const relation of Array.from(root.getElementsByTagNameNS(relationshipNamespace, "Relationship"))) {
        const kind = relation.getAttribute("Type")?.split("/").pop()?.toLowerCase();
        const external = relation.getAttribute("TargetMode")?.toLowerCase() === "external";
        if (external && kind !== "hyperlink") return false;
        if (["oleobject", "control", "activexcontrol", "externallink", "dde", "vbaproject"].includes(kind ?? "")) return false;
        if (kind === "package" && !(
          extension === "pptx" &&
          /^ppt\/charts\/_rels\/[^/]+\.xml\.rels$/i.test(fileName) &&
          /^(?:\.\.\/embeddings\/|\/ppt\/embeddings\/)[^/]+\.xlsx$/i.test(relation.getAttribute("Target") ?? "")
        )) return false;
      }
    }
    return entries.has(documentPart[extension as keyof typeof documentPart]);
  } catch {
    return false;
  } finally {
    archive.close();
  }
}

export function createOfficePreview(engine: ReturnType<typeof createEngine>) {
  const lifetime = new AbortController();
  const cached = new Map<string, Uint8Array>();
  const pending = new Map<string, Promise<Uint8Array | null>>();
  const layouts = new Map<string, Promise<EngineResults["office-layout"] | null>>();
  let cachedBytes = 0;
  let queue = Promise.resolve();

  async function convert(content: Buffer, extension: string) {
    if (!await supportsFormattedPreview(content, extension)) return null;
    const directory = await officeDirectory();
    lifetime.signal.throwIfAborted();
    return new Promise<Uint8Array>((resolve, reject) => {
      const worker = execFile(process.execPath, [
        "--max-old-space-size=192", "--wasm-num-compilation-tasks=4", "--no-wasm-tier-up",
        join(directory, "server", "office-worker.cjs"), extension, String(content.byteLength),
      ], {
        encoding: "buffer", maxBuffer: maxPreviewBytes, timeout: 90_000,
        signal: lifetime.signal, killSignal: "SIGKILL", windowsHide: true,
      }, (error, output) => {
        if (lifetime.signal.aborted) {
          reject(new Error("Reader stopped."));
          return;
        }
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new Error("The Office preview exceeds the size limit."));
          return;
        }
        if (error || !output.byteLength) {
          reject(new Error(error?.killed ? "The Office preview took too long. Please retry."
            : "The Office layout renderer could not render the document."));
          return;
        }
        const shared = new Uint8Array(new SharedArrayBuffer(output.byteLength));
        shared.set(output);
        resolve(shared);
      });
      worker.stdin?.on("error", () => {});
      worker.stdin?.end(content);
    });
  }

  function load(key: string, read: () => Promise<Buffer>, extension: string) {
    const previous = cached.get(key);
    if (previous) {
      cached.delete(key);
      cached.set(key, previous);
      return Promise.resolve(previous);
    }
    const current = pending.get(key);
    if (current) return current;
    if (pending.size >= 2) throw new Error("The Office layout renderer is busy. Please retry.");
    const request = queue.then(async () => {
      lifetime.signal.throwIfAborted();
      return await convert(await read(), extension);
    }).then((output) => {
      if (!output || lifetime.signal.aborted) return output;
      cached.set(key, output);
      cachedBytes += output.byteLength;
      while (cached.size > 4 || cachedBytes > 48 * 1024 * 1024) {
        const oldest = cached.entries().next().value;
        if (!oldest) break;
        cachedBytes -= oldest[1].byteLength;
        cached.delete(oldest[0]);
      }
      return output;
    }).finally(() => pending.delete(key));
    queue = request.then(() => undefined, () => undefined);
    pending.set(key, request);
    return request;
  }

  function prepare(root: string, path: string) {
    const extension = extname(path).slice(1).toLowerCase();
    if (!pagedOfficeExtensions.includes(extension)) return Promise.resolve({ key: "", data: null });
    return withWorkspaceFile(root, path, pagedOfficeExtensions, async (file, size, revision) => {
      if (size > maxOfficeBytes) throw new Error("Document exceeds the preview limit.");
      const key = JSON.stringify([root, path, revision]);
      return { key, data: await load(key, () => file.readFile(), extension) };
    });
  }

  function layout(root: string, path: string) {
    const target = JSON.stringify([root, path]);
    const previous = layouts.get(target);
    if (previous) return previous;
    const request = prepare(root, path)
      .then(({ key, data }) => data ? engine.dispatch({ kind: "office-layout", key, data }) : null)
      .finally(() => layouts.delete(target));
    layouts.set(target, request);
    return request;
  }

  return {
    async text(root: string, path: string, page: number) {
      const { key, data } = await prepare(root, path);
      return data ? engine.dispatch({ kind: "office-text", key, data, page }) : null;
    },
    async search(root: string, path: string, query: string, options: MarkdownSearchOptions) {
      const { key, data } = await prepare(root, path);
      return data ? engine.dispatch({ kind: "office-search", key, data, query, options }) : null;
    },
    async layoutStatus(root: string, path: string) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          layout(root, path),
          new Promise<"loading">((resolve) => { timer = setTimeout(resolve, 2_500, "loading"); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async page(root: string, path: string, page: number, pixels: number) {
      const { key, data } = await prepare(root, path);
      return data ? engine.dispatch({ kind: "office", key, data, page, pixels }) : null;
    },
    stop() {
      lifetime.abort(new Error("Reader stopped."));
      cached.clear();
      cachedBytes = 0;
    },
  };
}
