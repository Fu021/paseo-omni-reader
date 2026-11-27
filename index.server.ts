import { extname } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  openWorkspaceFile, readDocumentLayout, readMarkdownPage, readStructuredDocument, readWorksheet, renderFormulas, renderOfficePage, renderPdfPage,
} from "./shared/contracts";
import { readerSettings } from "./shared/reader-settings";
import { createEngine } from "./server/engine";
import { createOfficePreview } from "./server/office-preview";
import { openWithDefaultApp } from "./server/external-file";
import { loadMarkdownPage } from "./server/markdown-page";
import { workspaceDirectory } from "./server/workspace-file";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(readerSettings);
  const engine = createEngine();
  const office = createOfficePreview(engine);
  server.handle(renderFormulas, ({ formulas, color, platform }) =>
    engine.dispatch({ kind: "math", formulas, color, platform }),
  );
  server.handle(openWorkspaceFile, async ({ workspaceId, path }, { paseo }) => {
    await openWithDefaultApp(await workspaceDirectory(paseo, workspaceId), path);
    return { opened: true as const };
  });
  server.handle(readMarkdownPage, async ({ workspaceId, path, offset, revision, fence }, { paseo }) =>
    loadMarkdownPage(await workspaceDirectory(paseo, workspaceId), path, offset, revision, fence),
  );
  server.handle(readDocumentLayout, async ({ workspaceId, path }, { paseo }) => {
    const root = await workspaceDirectory(paseo, workspaceId);
    return extname(path).toLowerCase() === ".pdf"
      ? engine.dispatch({ kind: "pdf-layout", root, path })
      : office.layout(root, path);
  });
  server.handle(renderPdfPage, async ({ workspaceId, path, page, pixels }, { paseo }) =>
    engine.dispatch({ kind: "pdf", root: await workspaceDirectory(paseo, workspaceId), path, page, pixels }),
  );
  server.handle(renderOfficePage, async ({ workspaceId, path, page, pixels }, { paseo }) =>
    office.page(await workspaceDirectory(paseo, workspaceId), path, page, pixels),
  );
  server.handle(readStructuredDocument, async ({ workspaceId, path }, { paseo }) =>
    engine.dispatch({ kind: "document", root: await workspaceDirectory(paseo, workspaceId), path }),
  );
  server.handle(readWorksheet, async ({ workspaceId, path, sheet }, { paseo }) =>
    engine.dispatch({ kind: "worksheet", root: await workspaceDirectory(paseo, workspaceId), path, sheet }),
  );
  return () => {
    office.stop();
    engine.stop();
  };
}
