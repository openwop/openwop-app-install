/**
 * Durable host-surface adapters (Phase 2) — registration + KV/cache.
 *
 * The real-backend adapters behind the surface seam (host/surfaceBackends.ts).
 * Each satisfies the same surface interface as the in-memory demo impl, so
 * swapping one in is config-only (`OPENWOP_SURFACE_KV=durable`) with no
 * wire-shape change.
 *
 * Cloud-agnostic: built on the dialect-agnostic `Storage` kv primitives, so
 * the same adapter runs on the sqlite control plane (single node) and on
 * Postgres (multi-instance, read-through), selected only by
 * `OPENWOP_STORAGE_DSN`. No vendor-specific code path.
 *
 * Atomicity: `kv`/`cache` compare-and-set and increment are atomic ACROSS
 * instances via `Storage.kvCompareAndSwap` (see durableStore.ts) — no
 * in-process lock, correct under multi-instance concurrency.
 */

import type { Storage } from '../../storage/storage.js';
import type { BundleScope, KvSurface, CacheSurface } from '../inMemorySurfaces.js';
import { registerSurfaceAdapter } from '../surfaceBackends.js';
import { createKvCore, setDurableStorage } from './durableStore.js';
import { createDurableTable } from './durableTable.js';
import { createDurableQueue, createDurableQueueBus } from './durableQueue.js';
import { createDurableVector, createDurableSearch, createDurableNosql } from './durableData.js';
import { createDurableFs } from './durableFs.js';
import { createDurableSql, setDurableSqlDir } from './durableSql.js';

/** Backend id the durable adapters register under (OPENWOP_SURFACE_*=durable). */
export const DURABLE_BACKEND_ID = 'durable';

/** host.kv — durable KV over the shared Storage. */
export function createDurableKv(scope: BundleScope): KvSurface {
  return createKvCore('hostsurf:kv:', scope);
}

/** host.cache — a separate durable namespace, wrapped into the cache-semantic
 *  `{hit, value, ttlRemainingMs}` shape (a miss MUST surface `hit: false` per
 *  RFC 0019 §B point 2). Mirrors the in-memory cache, which also wraps kv. */
export function createDurableCache(scope: BundleScope): CacheSurface {
  const kv = createKvCore('hostsurf:cache:', scope);
  return {
    get: async (args) => {
      const out = (await kv.get(args)) as {
        value: unknown; found?: boolean; ttlRemainingMs?: number | null;
      };
      return { hit: !!out.found, value: out.value, ttlRemainingMs: out.ttlRemainingMs ?? null, found: !!out.found };
    },
    put: async (args) => kv.set({ key: args.key, value: args.value, ttlSeconds: args.ttlSeconds ?? 60 }),
    evict: kv.delete,
  };
}

/**
 * Wire the durable surface adapters to the host Storage and register them
 * behind the seam. Call once at boot, after `openStorage()` and before
 * `initInMemorySurfaces()` (whose boot guard checks adapter availability).
 */
export function initDurableSurfaces(storage: Storage, opts: { sqlDir?: string } = {}): void {
  setDurableStorage(storage);
  if (opts.sqlDir) setDurableSqlDir(opts.sqlDir);
  registerSurfaceAdapter('kv', DURABLE_BACKEND_ID, createDurableKv);
  registerSurfaceAdapter('cache', DURABLE_BACKEND_ID, createDurableCache);
  registerSurfaceAdapter('table', DURABLE_BACKEND_ID, createDurableTable);
  registerSurfaceAdapter('queue', DURABLE_BACKEND_ID, createDurableQueue);
  registerSurfaceAdapter('queueBus', DURABLE_BACKEND_ID, createDurableQueueBus);
  registerSurfaceAdapter('vector', DURABLE_BACKEND_ID, createDurableVector);
  registerSurfaceAdapter('search', DURABLE_BACKEND_ID, createDurableSearch);
  registerSurfaceAdapter('nosql', DURABLE_BACKEND_ID, createDurableNosql);
  registerSurfaceAdapter('fs', DURABLE_BACKEND_ID, createDurableFs);
  registerSurfaceAdapter('sql', DURABLE_BACKEND_ID, createDurableSql);
}

/** Test affordance — set the Storage ref directly without registering. */
export function _setDurableStorageForTesting(storage: Storage | null): void {
  setDurableStorage(storage);
}
