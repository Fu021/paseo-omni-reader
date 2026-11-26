import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AssistantReader, transformAssistant } from "./client/markdown";
import { messages } from "./client/messages";
import { PdfPanel } from "./client/pdf-panel";
import { TextPanel } from "./client/text-panel";
import { markdownExtensions, markdownKind, messageSchema, textExtensions } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  const registrations = [
    client.addFilePanel({
      id: "markdown", title: messages.message("markdown"), icon: "BookOpenText",
      files: { extensions: markdownExtensions }, Component: TextPanel,
    }),
    client.addFilePanel({
      id: "text", title: messages.message("text"), icon: "FileText",
      files: { extensions: textExtensions }, Component: TextPanel,
    }),
    client.addFilePanel({
      id: "pdf", title: messages.message("pdf"), icon: "FileText",
      files: { extensions: ["pdf"] }, Component: PdfPanel,
    }),
    client.addTimelineRenderer({
      kind: markdownKind, version: 1, schema: messageSchema, Component: AssistantReader,
    }),
    client.addTimelineTransformer({
      id: "assistant-math", query: { itemType: "assistant_message" }, transform: transformAssistant,
    }),
  ];
  return () => { for (const remove of registrations.reverse()) remove(); };
}
