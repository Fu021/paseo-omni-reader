import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerAssistantReading } from "./client/markdown";
import { fileReader } from "./client/file-reader";
import { messages } from "./client/messages";
import { OfficePanel, PdfPanel } from "./client/pdf-panel";
import { MarkdownPanel } from "./client/markdown-panel";
import { ReaderSettings } from "./client/settings";
import { WorksheetPanel } from "./client/worksheet-panel";
import { markdownExtensions, officeExtensions } from "./shared/contracts";

const pdfReader = fileReader(PdfPanel);
const documentReader = fileReader((props) =>
  props.file.extension === "xlsx" ? <WorksheetPanel {...props} /> : <OfficePanel {...props} />);
const markdownReader = fileReader(MarkdownPanel);
const defaultReader = { preferByDefault: true };

export default function contribute(client: PluginClientContext) {
  const registrations = [
    client.addSettingsScreen({
      id: "reader", title: messages.message("formulaSettings"), icon: "Sigma", Component: ReaderSettings,
    }),
    client.addFilePanel({
      id: "pdf", title: messages.message("pdf"), icon: "FileText",
      ...defaultReader, files: { extensions: ["pdf"] }, Component: pdfReader,
    }),
    client.addFilePanel({
      id: "document", title: messages.message("document"), icon: "FileText",
      ...defaultReader, files: { extensions: officeExtensions }, Component: documentReader,
    }),
    client.addFilePanel({
      id: "markdown", title: messages.message("markdown"), icon: "BookOpenText",
      ...defaultReader, files: { extensions: markdownExtensions }, Component: markdownReader,
    }),
    registerAssistantReading(client),
  ];
  return () => { for (const remove of registrations.reverse()) remove(); };
}
