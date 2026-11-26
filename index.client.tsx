import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AssistantReader, transformAssistant } from "./client/markdown";
import { messages } from "./client/messages";
import { PdfPanel } from "./client/pdf-panel";
import { TextPanel } from "./client/text-panel";
import { StructuredPanel, VisualPanel } from "./client/document-panel";
import {
  dataExtensions, frameExtensions, imageExtensions, markdownExtensions, markdownKind, messageSchema, officeExtensions, textExtensions,
} from "./shared/contracts";

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
    client.addFilePanel({
      id: "document", title: messages.message("document"), icon: "FileText",
      files: { extensions: [...officeExtensions, ...dataExtensions] }, Component: StructuredPanel,
    }),
    client.addFilePanel({
      id: "visual", title: messages.message("visual"), icon: "Image",
      files: { extensions: [...frameExtensions, ...imageExtensions] }, Component: VisualPanel,
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
