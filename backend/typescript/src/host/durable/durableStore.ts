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

// ── ADR 0868 — bounded scans ────────────────────────────────────────
// Every durable surface reads a key range through these helpers, never through
// `Storage.kvList` directly (a ratchet test holds that). `kvList` returns every
// row under a prefix, values included, so a `limit: 1` query or a queue receive
// used to cost the whole table or queue on every call, on the 4-connection
// Storage pool the daemons share.

type KvRow = { key: string; value: string };

/** Byte order of the UTF-8 key — the order `kvListPage` returns. */
export const compareKeyBytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** Rows per page when a caller iterates a whole range (`scanPrefix`). */
export const SCAN_BATCH = 500;

const envInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/** `surface_scan_heavy` fires when one logical read pulls at least this many
 *  rows into the process, or takes at least this long. */
export const scanWarnRows = (): number => envInt('OPENWOP_SURFACE_SCAN_WARN_ROWS', 5000);
export const scanWarnMs = (): number => envInt('OPENWOP_SURFACE_SCAN_WARN_MS', 500);

/** `hostsurf:<family>:…` → `<family>`; the tenant segment is not logged. */
const scanFamily = (prefix: string): string => prefix.split(':')[1] ?? 'unknown';

function reportScan(op: string, prefix: string, rows: number, startedMs: number): void {
  const ms = Date.now() - startedMs;
  if (rows >= scanWarnRows() || ms >= scanWarnMs()) {
    log.warn('surface_scan_heavy', { op, family: scanFamily(prefix), rows, ms });
  }
}

async function rawPage(storage: Storage, prefix: string, after: string | undefined, limit: number): Promise<ReadonlyArray<KvRow>> {
  if (storage.kvListPage) return storage.kvListPage(prefix, { after, limit });
  // Fallback for a backend without the paged read: complete, but unbounded.
  const all = [...(await storage.kvList(prefix))].sort((a, b) => compareKeyBytes(a.key, b.key));
  const from = after === undefined ? 0 : all.findIndex((r) => compareKeyBytes(r.key, after) > 0);
  return from < 0 ? [] : all.slice(from, from + limit);
}

/** One page: at most `limit` rows under `prefix` with key > `after`, byte order. */
export async function listPage(prefix: string, opts: { after?: string; limit: number }): Promise<ReadonlyArray<KvRow>> {
  const started = Date.now();
  const rows = await rawPage(requireDurableStorage(), prefix, opts.after, opts.limit);
  reportScan('page', prefix, rows.length, started);
  return rows;
}

/**
 * Iterate the rows under `prefix` (key > `after`, when given) in pages of
 * `batch`, in byte order, reporting the whole read once when it ends. Memory
 * is bounded by the batch; a caller that stops early (`break`) reads only what
 * it consumed. Deleting the row just yielded is safe: the cursor is the key.
 */
export async function* scanPrefix(
  prefix: string,
  opts: { batch?: number; after?: string; op?: string } = {},
): AsyncGenerator<KvRow> {
  const storage = requireDurableStorage();
  const batch = opts.batch ?? SCAN_BATCH;
  const started = Date.now();
  let rows = 0;
  let after = opts.after;
  try {
    for (;;) {
      const page = await rawPage(storage, prefix, after, batch);
      rows += page.length;
      for (const row of page) yield row;
      if (page.length < batch) return;
      after = page[page.length - 1]!.key;
    }
  } finally {
    reportScan(opts.op ?? 'scan', prefix, rows, started);
  }
}

/** The number of keys under `prefix`, counted by the database when it can. */
export async function countPrefix(prefix: string): Promise<number> {
  const storage = requireDurableStorage();
  if (storage.kvCount) return storage.kvCount(prefix);
  const started = Date.now();
  const n = (await storage.kvList(prefix)).length;
  reportScan('count', prefix, n, started);
  return n;
}

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
export async function withKeyLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
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
      // ADR 0868: the caller's prefix narrows the DATABASE range, not a JS filter
      // over the tenant's whole kv keyspace.
      const keys: string[] = [];
      for await (const row of scanPrefix(`${tp}${p}`)) {
        const { value, expired } = decodeEnvelope(row.value);
        if (expired || value === null) continue;
        keys.push(row.key.slice(tp.length));
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
