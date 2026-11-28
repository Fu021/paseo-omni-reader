import { Worker } from "node:worker_threads";
import documentWorker from "./generated/document-worker";
import mathWorker from "./generated/math-worker";
import { officeDirectory } from "./office-location";
import type { EngineRequest, EngineResponse, EngineResults } from "./worker-protocol";

function createWorkerQueue(source: string, timeout = 20_000, findDirectory?: () => Promise<string>) {
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

  async function getWorker() {
    if (worker) return worker;
    const directory = findDirectory && await findDirectory();
    if (stopped) throw new Error("Reader stopped.");
    const created = new Worker(source, {
      eval: true,
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 192 },
      workerData: directory,
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
    const result = queue.then(async () => {
      if (stopped) throw new Error("Reader stopped.");
      const current = await getWorker();
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
        }, timeout);
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

export function createEngine() {
  const math = createWorkerQueue(mathWorker, 20_000, officeDirectory);
  const document = createWorkerQueue(documentWorker, 20_000, officeDirectory);
  const office = createWorkerQueue(documentWorker, 20_000, officeDirectory);
  const search = createWorkerQueue(documentWorker, 5_000, officeDirectory);
  const queues = { math, document, pdf: document, "pdf-layout": document, "pdf-text": document, "pdf-search": search,
    office, "office-layout": office, "office-text": office, "office-search": search, worksheet: office,
    "markdown-search": search, "worksheet-search": search };
  return {
    dispatch: <Request extends EngineRequest>(request: Request) =>
      queues[request.kind].dispatch(request),
    stop: () => {
      math.stop();
      document.stop();
      office.stop();
      search.stop();
    },
  };
}
