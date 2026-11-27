export function createPageRenderQueue() {
  let tail: Promise<unknown> = Promise.resolve();

  return function enqueue<Result>(signal: AbortSignal, render: () => Promise<Result>) {
    const result = tail.then(() => {
      if (signal.aborted) throw new Error("Page rendering cancelled.");
      return render();
    });
    tail = result.catch(() => undefined);
    return result;
  };
}
