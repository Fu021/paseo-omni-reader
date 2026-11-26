import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readStructuredDocument, readTextPage, renderFormulas, renderPdfPage } from "./shared/contracts";
import { createEngine } from "./server/engine";
import { loadTextPage } from "./server/text-page";
import { workspaceDirectory } from "./server/workspace-file";

export default function contribute(server: PluginServerContext) {
  const engine = createEngine();
  server.handle(renderFormulas, ({ formulas, color, platform }) =>
    engine.dispatch({ kind: "math", formulas, color, platform }),
  );
  server.handle(readTextPage, async ({ workspaceId, path, offset, revision, fence }, { paseo }) =>
    loadTextPage(await workspaceDirectory(paseo, workspaceId), path, offset, revision, fence),
  );
  server.handle(renderPdfPage, async ({ workspaceId, path, page, pixels }, { paseo }) =>
    engine.dispatch({ kind: "pdf", root: await workspaceDirectory(paseo, workspaceId), path, page, pixels }),
  );
  server.handle(readStructuredDocument, async ({ workspaceId, path }, { paseo }) =>
    engine.dispatch({ kind: "document", root: await workspaceDirectory(paseo, workspaceId), path }),
  );
  return engine.stop;
}
