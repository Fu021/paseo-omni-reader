import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DOMParser, onErrorStopParsing } from "@xmldom/xmldom";
import { fromBufferPromise } from "yauzl";
import { officeExtensions } from "../shared/contracts";
import type { createEngine } from "./engine";
import { withWorkspaceFile } from "./workspace-file";

const execute = promisify(execFile);
const maxOfficeBytes = 24 * 1024 * 1024;
const maxPreviewBytes = 32 * 1024 * 1024;
const filters: Record<string, { input: string; output: string }> = {
  docx: { input: "Office Open XML Text", output: "writer_pdf_Export" },
  xlsx: { input: "Calc MS Excel 2007 XML", output: "calc_pdf_Export" },
  pptx: { input: "Impress MS PowerPoint 2007 XML", output: "impress_pdf_Export" },
};
const relationshipNamespace = "http://schemas.openxmlformats.org/package/2006/relationships";
const externalOrActivePart = /(?:^|\/)(?:activeX|externalLinks|oleObject[^/]*|vbaProject\.bin)(?:\/|$)/i;

async function supportsEmbeddedCharts(content: Buffer, extension: string) {
  if (extension === "docx") return false;
  const archive = await fromBufferPromise(content, { lazyEntries: true, validateEntrySizes: true }).catch(() => null);
  if (!archive) return false;
  const parser = new DOMParser({ onError: onErrorStopParsing });
  const entries = new Set<string>();
  let relationshipBytes = 0;
  try {
    if (archive.entryCount > 8_000) return false;
    for await (const entry of archive.eachEntry()) {
      const { fileName, uncompressedSize } = entry;
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
          /^ppt\/charts\/_rels\/[^/]+\.xml\.rels$/i.test(fileName) &&
          /^(?:\.\.\/embeddings\/|\/ppt\/embeddings\/)[^/]+\.xlsx$/i.test(relation.getAttribute("Target") ?? "")
        )) return false;
      }
    }
    return entries.has(extension === "xlsx" ? "xl/workbook.xml" : "ppt/presentation.xml");
  } catch {
    return false;
  } finally {
    archive.close();
  }
}

function officeProfile(embeddedCharts: boolean) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="DisableActiveContent" oor:op="fuse"><value>${!embeddedCharts}</value></prop>
    <prop oor:name="DisableOLEAutomation" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>
  </item>
  <item oor:path="/org.openoffice.Office.Calc/Content/Update">
    <prop oor:name="Link" oor:op="fuse"><value>1</value></prop>
  </item>
  <item oor:path="/org.openoffice.Office.Writer/Content/Update">
    <prop oor:name="Link" oor:op="fuse"><value>2</value></prop>
  </item>
</oor:items>`;
}

function officeCommands() {
  return [
    process.env.OMNI_READER_SOFFICE,
    "soffice",
    "libreoffice",
    join(homedir(), ".local", "share", "paseo-omni-reader", "soffice"),
    ...(process.platform === "darwin" ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"] : []),
    ...(process.platform === "win32" ? ["ProgramFiles", "ProgramFiles(x86)"].flatMap((key) => {
      const folder = process.env[key];
      return folder ? [join(folder, "LibreOffice", "program", "soffice.com")] : [];
    }) : [join(homedir(), ".local", "bin", "soffice")]),
  ].filter((command): command is string => !!command);
}

export function createOfficePreview(engine: ReturnType<typeof createEngine>) {
  const lifetime = new AbortController();
  const cached = new Map<string, Uint8Array>();
  const pending = new Map<string, Promise<Uint8Array | null>>();
  let cachedBytes = 0;
  let command: string | undefined;

  async function convert(content: Buffer, extension: string) {
    const directory = await mkdtemp(join(tmpdir(), "omni-office-"));
    try {
      const profile = join(directory, "profile");
      const input = join(directory, `preview.${extension}`);
      const output = join(directory, "preview.pdf");
      await mkdir(join(profile, "user"), { recursive: true });
      await Promise.all([
        writeFile(input, content),
        supportsEmbeddedCharts(content, extension).then((enabled) =>
          writeFile(join(profile, "user", "registrymodifications.xcu"), officeProfile(enabled))),
      ]);
      const filter = filters[extension];
      const args = [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        "--headless", "--norestore", "--nodefault", "--nofirststartwizard",
        `--infilter=${filter.input}`, "--convert-to", `pdf:${filter.output}`, "--outdir", directory, input,
      ];
      for (const candidate of new Set(command ? [command, ...officeCommands()] : officeCommands())) {
        try {
          await execute(candidate, args, {
            cwd: directory, timeout: 18_000, maxBuffer: 128_000, windowsHide: true,
            signal: lifetime.signal, killSignal: "SIGKILL",
          });
          command = candidate;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw new Error("The Office layout renderer could not render the document.");
        }
        const result = await stat(output).catch(() => null);
        if (!result?.isFile() || !result.size) throw new Error("The Office document could not be opened.");
        if (result.size > maxPreviewBytes) throw new Error("The Office preview exceeds the size limit.");
        const preview = new Uint8Array(new SharedArrayBuffer(result.size));
        preview.set(await readFile(output));
        return preview;
      }
      return null;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
    const request = read().then((content) => convert(content, extension)).then((output) => {
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
    pending.set(key, request);
    return request;
  }

  function prepare(root: string, path: string) {
    const extension = extname(path).slice(1).toLowerCase();
    return withWorkspaceFile(root, path, officeExtensions, async (file, size, revision) => {
      if (size > maxOfficeBytes) throw new Error("Document exceeds the preview limit.");
      const key = JSON.stringify([root, path, revision]);
      return { key, data: await load(key, () => file.readFile(), extension) };
    });
  }

  return {
    async layout(root: string, path: string) {
      const { key, data } = await prepare(root, path);
      return data ? engine.dispatch({ kind: "office-layout", key, data }) : null;
    },
    async page(root: string, path: string, page: number, pixels: number) {
      const { key, data } = await prepare(root, path);
      return data ? engine.dispatch({ kind: "office", key, data, page, pixels }) : null;
    },
    stop() {
      lifetime.abort();
      cached.clear();
    },
  };
}
