/**
 * Deterministic read-then-write interleaving for DurableCollection race tests.
 *
 * A read-then-put race needs a competing write to land BETWEEN a caller's read and
 * its write. Two `Promise.all` calls get that interleaving only by accident of
 * microtask order. This wrapper makes it exact: `interleaveAfterRead(match, run)`
 * arms a one-shot hook so the NEXT `kvGet` whose key matches resolves its value,
 * then runs `run` (the competitor, e.g. a second call to the same service function)
 * to completion, and only then returns the now-stale value to the first caller.
 *
 * `kvList` (the read behind `listByPrefix`/`list`) is matched the same way, on its
 * prefix argument, so a list-then-put is interleaved exactly like a get-then-put.
 * The hook disarms before `run` starts, so the competitor's own reads pass straight
 * through. Every other storage method is forwarded unchanged.
 */
import type { Storage } from '../../src/storage/storage.js';

export interface InterleavedStorage {
  storage: Storage;
  /** Arm a one-shot competitor for the next `kvGet` key / `kvList` prefix matching `match`. */
  interleaveAfterRead(match: (key: string) => boolean, run: () => Promise<unknown>): void;
  /** True once an armed competitor has run (asserts the hook actually fired). */
  fired(): boolean;
}

export function interleavedStorage(inner: Storage): InterleavedStorage {
  let hook: { match: (key: string) => boolean; run: () => Promise<unknown> } | null = null;
  let didFire = false;
  const storage = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'kvGet' || prop === 'kvList') {
        const read = (Reflect.get(target, prop, receiver) as (k: string, ...rest: unknown[]) => Promise<unknown>).bind(target);
        return async (key: string, ...rest: unknown[]): Promise<unknown> => {
          const value = await read(key, ...rest);
          if (hook && hook.match(key)) {
            const armed = hook;
            hook = null;
            didFire = true;
            await armed.run();
          }
          return value;
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return {
    storage,
    interleaveAfterRead(match, run) { hook = { match, run }; didFire = false; },
    fired: () => didFire,
  };
}
