/**
 * Shared plumbing for the durable host-surface adapters (Phase 2).
 *
 * Holds the single `Storage` ref the durable adapters write through, the
 * value envelope (value + optional TTL), and a reusable KV core whose
 * compare-and-set / increment are TRULY atomic across instances — built on
 * `Storage.kvCompareAndSwap` rather than an in-process lock.
 *
 * Cloud-agnostic: everything goes through the `Storage` kv primitives, so the
 * same code runs on sqlite (single node) and Postgres (multi-instance).
 */

import type { Storage } from '../../storage/storage.js';
import type { BundleScope, KvSurface } from '../inMemorySurfaces.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('host.durable');

let storageRef: Storage | null = null;

export function setDurableStorage(storage: Storage | null): void {
  storageRef = storage;
}

export function requireDurableStorage(): Storage {
  if (!storageRef) {
    throw new Error(
      'Durable host surface used before initDurableSurfaces() wired the Storage backend at boot.',
    );
  }
  return storageRef;
}

/** Non-throwing variant: the durable Storage handle, or null when boot hasn't
 *  wired it (e.g. a unit test that doesn't init host-ext). Lets write-through
 *  caches degrade gracefully to in-memory-only instead of crashing. */
export function tryDurableStorage(): Storage | null {
  return storageRef;
}

export const now = (): number => Date.now();

/** Persisted envelope. `e` = expiry epoch-ms (TTL); absent ⇒ no expiry. */
export interface Envelope {
  v: unknown;
  e?: number;
}

export function encodeEnvelope(value: unknown, ttlSeconds?: unknown): string {
  const env: Envelope = { v: value };
  if (typeof ttlSeconds === 'number' && ttlSeconds > 0) {
    env.e = now() + ttlSeconds * 1000;
  }
  return JSON.stringify(env);
}

/** Decode a stored row, honoring TTL. Returns the raw string (for CAS
 *  expected-matching) plus the live value (null when absent/expired/corrupt)
 *  and whether it is expired. */
export function decodeEnvelope(
  raw: string | null,
): { raw: string | null; value: unknown; expired: boolean; expiresAtMs: number | null } {
  if (raw === null) return { raw: null, value: null, expired: false, expiresAtMs: null };
  let env: Envelope;
  try {
    env = JSON.parse(raw) as Envelope;
  } catch {
    // Corrupt persisted record — surface it instead of silently dropping the
    // value (ENG-4); the caller still sees `value: null` (absent).
    log.warn('durable_corrupt_record', { bytes: raw.length });
    return { raw, value: null, expired: false, expiresAtMs: null };
  }
  const expiresAtMs = typeof env.e === 'number' ? env.e : null;
  if (expiresAtMs !== null && expiresAtMs <= now()) {
    return { raw, value: null, expired: true, expiresAtMs };
  }
  return { raw, value: env.v, expired: false, expiresAtMs };
}

// Tenant isolation: the durable store is one flat keyspace, so the tenant id is
// encoded into the key prefix. encodeURIComponent keeps the delimiter out of
// the tenant segment, so a crafted user key can never cross a tenant boundary
// (the user key is the raw suffix; list() strips the fixed prefix).
const tenantPrefix = (root: string, tenantId: string): string =>
  `${root}${encodeURIComponent(tenantId)}:`;

const MAX_CAS_RETRIES = 256;

// In-process per-key serialization. This COALESCES same-instance read-modify-
// write so they don't fight each other through CAS retries; cross-instance
// correctness still comes from kvCompareAndSwap below. Keyed by full storage
// key, shared across scopes.
const keyLocks = new Map<string, Promise<unknown>>();
async function withKeyLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = keyLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const chained = prev.then(() => gate);
  keyLocks.set(lockKey, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (keyLocks.get(lockKey) === chained) keyLocks.delete(lockKey);
  }
}

/**
 * A reusable durable KV surface over `Storage`, namespaced by `root`. Used for
 * both `host.kv` (root `hostsurf:kv:`) and `host.cache` (root `hostsurf:cache:`).
 * `set` is last-writer-wins; `atomicIncrement`/`cas` are atomic across
 * instances via `kvCompareAndSwap`.
 */
export function createKvCore(root: string, scope: BundleScope): KvSurface {
  const tenantId = scope.tenantId;
  const prefix = () => tenantPrefix(root, tenantId);
  const sk = (key: string) => `${prefix()}${key}`;
  const storage = () => requireDurableStorage();

  return {
    async get({ key }) {
      const k = sk(String(key));
      const { raw, value, expired, expiresAtMs } = decodeEnvelope(await storage().kvGet(k));
      if (expired) {
        // Lazily evict (best-effort; ignore races).
        try { await storage().kvDelete(k); } catch { /* noop */ }
        return { value: null, found: false, ttlRemainingMs: null };
      }
      const found = raw !== null;
      const ttlRemainingMs = expiresAtMs !== null ? Math.max(0, expiresAtMs - now()) : null;
      return { value: found ? value : null, found, ttlRemainingMs };
    },

    async set({ key, value, ttlSeconds }) {
      await storage().kvSet(sk(String(key)), encodeEnvelope(value, ttlSeconds));
      return { ok: true };
    },

    async delete({ key }) {
      const existed = await storage().kvDelete(sk(String(key)));
      return { ok: true, existed };
    },

    async list({ prefix: keyPrefix }) {
      const p = typeof keyPrefix === 'string' ? keyPrefix : '';
      const tp = prefix();
      const rows = await storage().kvList(tp);
      const keys: string[] = [];
      for (const row of rows) {
        const key = row.key.slice(tp.length);
        const { value, expired } = decodeEnvelope(row.value);
        if (expired || value === null) continue;
        if (!p || key.startsWith(p)) keys.push(key);
      }
      return { keys };
    },

    async atomicIncrement({ key, delta }) {
      const k = sk(String(key));
      const step = typeof delta === 'number' ? delta : 1;
      return withKeyLock(k, async () => {
        for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
          const { raw, value } = decodeEnvelope(await storage().kvGet(k));
          const prev = typeof value === 'number' ? value : 0;
          const next = prev + step;
          const res = await storage().kvCompareAndSwap(k, raw, encodeEnvelope(next));
          if (res.swapped) return { value: next };
          // Lost a cross-instance race; re-read and retry.
        }
        throw Object.assign(
          new Error('durable kv atomicIncrement: exceeded retry budget under contention'),
          { code: 'cas_contention' },
        );
      });
    },

    async cas(args) {
      // Canonical CAS: input `{key, expect, set}`, output `{swapped, actual}`.
      // Accept legacy `{expected, value}` aliases (parity with the in-memory
      // impl) but emit only the canonical output shape.
      const a = args as {
        key?: unknown; expect?: unknown; expected?: unknown; set?: unknown; value?: unknown;
      };
      const k = sk(String(a.key));
      const expectVal = ('expect' in a ? a.expect : a.expected) ?? null;
      const setVal = 'set' in a ? a.set : a.value;
      return withKeyLock(k, async () => {
        const { raw, value } = decodeEnvelope(await storage().kvGet(k));
        if (JSON.stringify(value) !== JSON.stringify(expectVal)) {
          return { swapped: false, actual: value };
        }
        const res = await storage().kvCompareAndSwap(k, raw, encodeEnvelope(setVal));
        if (res.swapped) return { swapped: true, actual: setVal };
        // Concurrent cross-instance writer slipped in between read and swap.
        const after = decodeEnvelope(await storage().kvGet(k));
        return { swapped: false, actual: after.value };
      });
    },
  };
}
