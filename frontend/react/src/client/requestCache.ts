/**
 * Coalesce-and-cache for tenant-global reads (rate-limit fix).
 *
 * The multi-tab chat deck and the mention/voice pickers each independently fetch
 * the same tenant- or user-scoped resources on mount — model capabilities, the
 * agent inventory, advisory boards, the roster, the caller's profile, the
 * realtime-voice config. With N tabs/pickers live that is N identical reads in
 * one burst, which on a real page load is enough to trip the per-IP read budget
 * (`backend/.../middleware/rateLimit.ts`, default 60/min) into a wall of `429`s.
 *
 * `cachedRead` collapses concurrent identical calls into ONE in-flight request
 * and (when `ttlMs > 0`) serves the resolved value to later callers until it
 * expires. A REJECTED load is never cached and clears the in-flight slot, so a
 * transient failure (including a 429) self-heals on the next call rather than
 * pinning an empty result. Pass `ttlMs: 0` for mutable resources to get pure
 * in-flight coalescing (collapses the load burst, zero staleness afterwards);
 * use a real TTL only for reads that don't change within a session. After a
 * mutation that changes a cached resource, call `invalidate(key)`.
 */
import { onAuthChange } from './config.js';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const inflight = new Map<string, Promise<unknown>>();
const cache = new Map<string, Entry<unknown>>();

// Deferred Phase D (SHELL-8): the coalesce cache holds tenant reads
// (agents/roster/boards/model-caps/voice-config) — drop everything whenever
// the identity OR the bound tenant changes (fireAuthChanged on switch). The
// generation counter keeps a load that was ALREADY in flight at clear time
// from re-populating the cache with old-tenant data when it resolves — the
// invariant the staged reload-removal (PLAN-DEFERRED D.3) depends on.
let generation = 0;
onAuthChange(() => { generation += 1; cache.clear(); inflight.clear(); });

export async function cachedRead<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  if (ttlMs > 0) {
    const hit = cache.get(key) as Entry<T> | undefined;
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }

  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const gen = generation;
  // Definite-assignment: the finally below runs strictly after p is assigned
  // (the closure first awaits the loader).
  let p!: Promise<T>;
  p = (async () => {
    try {
      const value = await loader();
      // A tenant change while this load was in flight → the result belongs to
      // the OLD tenant; hand it to the original caller but never cache it.
      if (ttlMs > 0 && gen === generation) cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      if (inflight.get(key) === p) inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** Drop a cached entry (and any in-flight slot) — call after a mutation that
 *  changes the resource so the next read re-fetches. */
export function invalidate(key: string): void {
  cache.delete(key);
  inflight.delete(key);
}

/** Clear everything — test hygiene between cases. */
export function clearRequestCache(): void {
  cache.clear();
  inflight.clear();
}
