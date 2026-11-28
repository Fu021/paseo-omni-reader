import { extname } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  findDocumentText, findWorksheetText, openWorkspaceFile, readDocumentLayout, readDocumentText, readMarkdownInfo, readMarkdownPage, readMarkdownSource,
  readStructuredDocument, readWorksheet, renderFormulas, renderOfficePage, renderPdfPage, searchMarkdownFile,
} from "./shared/contracts";
import { readerSettings } from "./shared/reader-settings";
import { createEngine } from "./server/engine";
import { createOfficePreview } from "./server/office-preview";
import { openWithDefaultApp } from "./server/external-file";
import { loadMarkdownInfo, loadMarkdownSource } from "./server/markdown-index";
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
  server.handle(readMarkdownPage, async ({ workspaceId, path, offset, revision, fence, table, firstLine, atLine }, { paseo }) =>
    loadMarkdownPage(await workspaceDirectory(paseo, workspaceId), path, offset, revision, fence, table, firstLine, atLine),
  );
  server.handle(readMarkdownInfo, async ({ workspaceId, path }, { paseo }) =>
    loadMarkdownInfo(await workspaceDirectory(paseo, workspaceId), path),
  );
  server.handle(readMarkdownSource, async ({ workspaceId, path, line, through }, { paseo }) =>
    loadMarkdownSource(await workspaceDirectory(paseo, workspaceId), path, line, through),
  );
  server.handle(searchMarkdownFile, async ({ workspaceId, path, ...input }, { paseo }) =>
    engine.dispatch({ kind: "markdown-search", root: await workspaceDirectory(paseo, workspaceId), path, ...input }),
  );
  server.handle(readDocumentLayout, async ({ workspaceId, path }, { paseo }) => {
    const root = await workspaceDirectory(paseo, workspaceId);
    return extname(path).toLowerCase() === ".pdf"
      ? engine.dispatch({ kind: "pdf-layout", root, path })
      : office.layoutStatus(root, path);
  });
  server.handle(renderPdfPage, async ({ workspaceId, path, page, pixels }, { paseo }) =>
    engine.dispatch({ kind: "pdf", root: await workspaceDirectory(paseo, workspaceId), path, page, pixels }),
  );
  server.handle(renderOfficePage, async ({ workspaceId, path, page, pixels }, { paseo }) =>
    office.page(await workspaceDirectory(paseo, workspaceId), path, page, pixels),
  );
  server.handle(readDocumentText, async ({ workspaceId, path, page }, { paseo }) => {
    const root = await workspaceDirectory(paseo, workspaceId);
    return extname(path).toLowerCase() === ".pdf"
      ? engine.dispatch({ kind: "pdf-text", root, path, page }) : office.text(root, path, page);
  });
  server.handle(findDocumentText, async ({ workspaceId, path, query, options }, { paseo }) => {
    const root = await workspaceDirectory(paseo, workspaceId);
    return extname(path).toLowerCase() === ".pdf"
      ? engine.dispatch({ kind: "pdf-search", root, path, query, options })
      : office.search(root, path, query, options);
  });
  server.handle(readStructuredDocument, async ({ workspaceId, path }, { paseo }) =>
    engine.dispatch({ kind: "document", root: await workspaceDirectory(paseo, workspaceId), path }),
  );
  server.handle(readWorksheet, async ({ workspaceId, path, sheet }, { paseo }) =>
    engine.dispatch({ kind: "worksheet", root: await workspaceDirectory(paseo, workspaceId), path, sheet }),
  );
  server.handle(findWorksheetText, async ({ workspaceId, path, ...input }, { paseo }) =>
    engine.dispatch({ kind: "worksheet-search", root: await workspaceDirectory(paseo, workspaceId), path, ...input }),
  );
  return () => {
    office.stop();
    engine.stop();
  };
}
