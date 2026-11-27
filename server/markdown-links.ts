import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse, postprocess, preprocess } from "micromark";
import { decodeString } from "micromark-util-decode-string";

function workspaceDestination(source: string, root: string, directory: string): string | undefined {
  const target = decodeString(source);
  if (!target || /^(?:[a-z][a-z\d+.-]*:|[/\\~#?])/i.test(target)) return;
  const hash = target.indexOf("#");
  const route = hash === -1 ? target : target.slice(0, hash);
  if (route.includes("?")) return;
  const lines = /:\d+(?:-\d+|:\d+)?$/.exec(route)?.[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(route.slice(0, route.length - lines.length));
  } catch {
    return;
  }
  const path = relative(root, resolve(directory, decoded));
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return;
  const encoded = path.split(sep).map((part) =>
    encodeURIComponent(part).replace(/[()]/g, (mark) => mark === "(" ? "%28" : "%29"),
  ).join("/");
  return `./${encoded}${lines}${hash === -1 ? "" : target.slice(hash)}`;
}

export function rebaseMarkdownLinks(markdown: string, root: string, filePath: string): string {
  const directory = dirname(resolve(root, filePath));
  if (directory === resolve(root) || (!markdown.includes("](") && !markdown.includes("]:"))) return markdown;
  const events = postprocess(parse().document().write(preprocess()(markdown, undefined, true)));
  const parts: string[] = [];
  let offset = 0;
  for (const [action, token] of events) {
    if (action !== "enter" || (token.type !== "resourceDestinationString" && token.type !== "definitionDestinationString")) continue;
    const { start, end } = token;
    const destination = workspaceDestination(markdown.slice(start.offset, end.offset), root, directory);
    if (destination === undefined) continue;
    parts.push(markdown.slice(offset, start.offset), destination);
    offset = end.offset;
  }
  return offset === 0 ? markdown : parts.join("") + markdown.slice(offset);
}
