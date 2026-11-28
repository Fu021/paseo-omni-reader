import { parse, postprocess, preprocess } from "micromark";
import { decodeString } from "micromark-util-decode-string";
import type { MarkdownReference as Reference } from "./contracts";

function identifier(value: string) {
  return value.replace(/[\t\n\r ]+/g, " ").trim().toLowerCase().toUpperCase();
}

function events(text: string) {
  return postprocess(parse().document().write(preprocess()(text, undefined, true)));
}

export function markdownReferences(text: string): Reference[] {
  if (!text.includes("]:")) return [];
  const references: Reference[] = [];
  let entry: Reference | undefined;
  for (const [action, token] of events(text)) {
    if (action === "enter" && token.type === "definition") entry = { label: "", destination: "" };
    if (!entry) continue;
    const value = () => text.slice(token.start.offset, token.end.offset);
    if (action === "enter" && token.type === "definitionLabelString") entry.label = value();
    if (action === "enter" && token.type === "definitionDestinationString") entry.destination = decodeString(value());
    if (action === "enter" && token.type === "definitionTitleString") entry.title = decodeString(value());
    if (action === "exit" && token.type === "definition") {
      if (entry.label) references.push(entry);
      entry = undefined;
    }
  }
  return references;
}

function resource({ destination, title }: Reference) {
  const href = destination.replace(/[<>\\\r\n]/g, (char) => encodeURIComponent(char)).replaceAll("&", "&amp;");
  const caption = !title ? "" : ` "${title.replace(/\r\n?|\n/g, " ").replace(/[\\"]/g, "\\$&").replaceAll("&", "&amp;")}"`;
  return `<${href}>${caption}`;
}

export function inlineReferenceLinks(text: string, definitions?: readonly Reference[]) {
  if (!text.includes("[") || (!definitions?.length && !text.includes("]:"))) return text;
  const references = new Map<string, Reference>();
  for (const entry of definitions ?? markdownReferences(text)) {
    const key = identifier(entry.label);
    if (!references.has(key)) references.set(key, entry);
  }
  if (!references.size) return text;
  const prefix = definitions?.length
    ? [...references.values()].map((entry) => `[${entry.label.replace(/[\r\n]+/g, " ")}]: ${resource(entry)}`).join("\n") + "\n\n"
    : "";
  const input = prefix + text;
  const stack: { label?: string; labelEnd?: number; reference?: string; inline?: boolean }[] = [];
  const edits: { start: number; end: number; value: string }[] = [];
  for (const [action, token] of events(input)) {
    if (token.type === "link" || token.type === "image") {
      if (action === "enter") stack.push({});
      else {
        const current = stack.pop();
        if (!current?.label || current.labelEnd === undefined || current.inline || current.labelEnd < prefix.length) continue;
        const entry = references.get(identifier(current.reference ?? current.label));
        if (entry) edits.push({ start: current.labelEnd - prefix.length, end: token.end.offset - prefix.length, value: `(${resource(entry)})` });
      }
    } else {
      const current = stack.at(-1);
      if (!current) continue;
      if (action === "enter" && token.type === "resource") current.inline = true;
      if (action === "exit" && token.type === "label") current.labelEnd = token.end.offset;
      if (action === "enter" && token.type === "labelText") current.label = input.slice(token.start.offset, token.end.offset);
      if (action === "enter" && token.type === "referenceString") current.reference = input.slice(token.start.offset, token.end.offset);
    }
  }
  if (!edits.length) return text;
  let tail = text.length;
  const result: string[] = [];
  for (const { start, end, value } of edits.reverse()) {
    result.push(text.slice(end, tail), value);
    tail = start;
  }
  return text.slice(0, tail) + result.reverse().join("");
}
