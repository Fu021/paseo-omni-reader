import { Worker } from "node:worker_threads";
import source from "./generated/worker";
import type { EngineRequest, EngineResponse, EngineResults } from "./worker-entry";

export function createEngine() {
  let worker: Worker | undefined;
  let queue = Promise.resolve();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let pending = 0;
  let stopped = false;

  function release() {
    clearTimeout(idle);
    const previous = worker;
    worker = undefined;
    void previous?.terminate();
  }

  function getWorker() {
    if (worker) return worker;
    const created = new Worker(source, {
      eval: true,
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 192 },
    });
    created.on("error", () => { if (worker === created) release(); });
    created.unref();
    worker = created;
    return created;
  }

  function dispatch<Request extends EngineRequest>(request: Request): Promise<EngineResults[Request["kind"]]> {
    if (stopped) return Promise.reject(new Error("Reader stopped."));
    if (pending >= 24) return Promise.reject(new Error("Reader is busy. Please retry."));
    pending++;
    clearTimeout(idle);
    const result = queue.then(() => {
      if (stopped) throw new Error("Reader stopped.");
      const current = getWorker();
      return new Promise<EngineResults[Request["kind"]]>((resolve, reject) => {
        const finish = (response: EngineResponse | Error) => {
          clearTimeout(deadline);
          current.off("message", finish);
          current.off("exit", exited);
          if (response instanceof Error) reject(response);
          else if ("error" in response) reject(new Error(response.error));
          else resolve(response.result as EngineResults[Request["kind"]]);
        };
        const exited = () => finish(new Error("Reader worker stopped."));
        const deadline = setTimeout(() => {
          finish(new Error("Rendering took too long. Please retry."));
          release();
        }, 20_000);
        current.once("message", finish);
        current.once("exit", exited);
        current.postMessage(request);
      });
    }).finally(() => {
      pending--;
      if (!pending && !stopped) idle = setTimeout(release, 60_000).unref();
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  return { dispatch, stop: () => { stopped = true; release(); } };
}
