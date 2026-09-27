/**
 * A minimal FIFO async semaphore — bound how many heavy operations run at once.
 *
 * Introduced for ADR 0411 §P3 (grade-code VID-2): a generative-video dispatch
 * buffers a whole ≤cap video in memory (binary + base64), so a handful of
 * concurrent jobs can OOM a small instance. Wrapping the dispatch in a semaphore
 * makes peak RSS PREDICTABLE (`slots × per-job`) instead of unbounded-by-traffic.
 *
 * `max <= 0` (or non-finite) → a pass-through that imposes no limit, so a large
 * host opts out via config without a code path change.
 */
export interface AsyncSemaphore {
  /** Run `fn` once a slot is free; releases the slot when it settles (success or throw). */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createSemaphore(max: number): AsyncSemaphore {
  if (!Number.isFinite(max) || max <= 0) {
    return { run: (fn) => fn() }; // disabled / unbounded — no queueing overhead
  }
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < max) { active += 1; resolve(); }
      else waiters.push(resolve);
    });
  const release = (): void => {
    const next = waiters.shift();
    if (next) next(); // hand the slot straight to the next waiter (active stays level)
    else active -= 1;
  };
  return {
    async run(fn) {
      await acquire();
      try { return await fn(); }
      finally { release(); }
    },
  };
}
