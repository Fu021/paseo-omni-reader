import { extname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { markdownExtensions, textExtensions, type Fence } from "../shared/contracts";
import { rebaseMarkdownLinks } from "./markdown-links";
import { withWorkspaceFile } from "./workspace-file";

export const textPageBytes = 24 * 1024;
const extensions = [...markdownExtensions, ...textExtensions];

function afterLine(line: string, fence: Fence | undefined): Fence | undefined {
  const match = /^ {0,3}(`{3,256}|~{3,256})(.*)$/.exec(line);
  if (!match) return fence;
  const [, marker, tail] = match;
  if (fence) {
    return marker[0] === fence.marker[0] && marker.length >= fence.marker.length && !tail.trim()
      ? undefined
      : fence;
  }
  if (tail.length > 750 || (marker[0] === "`" && tail.includes("`"))) return;
  return { marker, opening: marker + tail };
}

function chooseBoundary(text: string, initialFence: Fence | undefined, markdown: boolean, eof: boolean) {
  let fence = initialFence;
  let lastLine = { end: 0, fence };
  let paragraph = lastLine;
  let display: string | undefined;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r(?!$)|\n)/g)) {
    const line = match[0].replace(/[\r\n]+$/, "");
    const end = match.index + match[0].length;
    if (markdown) {
      if (!display) fence = afterLine(line, fence);
      if (!fence) {
        const delimiter = line.trim();
        if (delimiter === "$$") display = display === "$$" ? undefined : display ?? "$$";
        if (delimiter === "\\[" && !display) display = "\\]";
        if (delimiter === "\\]" && display === "\\]") display = undefined;
      }
    }
    lastLine = { end, fence };
    if (!fence && !display && (line.trim() === "" || !markdown)) paragraph = lastLine;
  }
  if (eof) return { end: text.length, fence: undefined };
  if (paragraph.end >= text.length / 2) return paragraph;
  if (lastLine.end >= text.length / 2) return lastLine;
  return { end: text.length, fence };
}

export async function loadTextPage(
  root: string,
  path: string,
  offset: number,
  revision?: string,
  previousFence?: Fence,
) {
  const markdownFile = markdownExtensions.includes(extname(path).slice(1).toLowerCase());
  return withWorkspaceFile(root, path, extensions, async (file, size, stamp) => {
    if ((revision && stamp !== revision) || offset > size) {
      throw new Error("File changed. Reload to read the new version.");
    }
    const bytes = Buffer.alloc(Math.min(textPageBytes, size - offset));
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, offset + length);
      if (!bytesRead) throw new Error("File ended while reading.");
      length += bytesRead;
    }
    const eof = offset + length === size;
    const decoder = new StringDecoder("utf8");
    const text = eof ? decoder.end(bytes) : decoder.write(bytes);
    const encoded = Buffer.from(text);
    if (!bytes.subarray(0, encoded.length).equals(encoded)) throw new Error("Reader supports UTF-8 text files.");
    const boundary = chooseBoundary(text, previousFence, markdownFile, eof);
    const kept = text.slice(0, boundary.end);
    const consumed = boundary.end === text.length && eof
      ? length
      : Buffer.byteLength(kept);
    const nextOffset = offset + consumed < size ? offset + consumed : null;
    const source = offset === 0 ? kept.replace(/^\uFEFF/, "") : kept;
    const prefix = previousFence ? `${previousFence.opening}\n` : "";
    const suffix = boundary.fence ? `\n${boundary.fence.marker}\n` : "";
    const preview = prefix + source + suffix;
    const markdown = markdownFile ? rebaseMarkdownLinks(preview, root, path) : preview;
    return { source, markdown, size, nextOffset, revision: stamp, fence: boundary.fence };
  });
}
