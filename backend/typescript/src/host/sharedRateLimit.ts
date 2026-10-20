/**
 * ADR 0934 D1/D2 — a rate limit shared by every instance, for public token
 * surfaces (the ADR 0924 client approval link first).
 *
 * `middleware/rateLimit.ts` (ADR 0640) counts per process, so with N instances
 * the effective budget is N× and every deploy resets it (SEC-3). That is fine for
 * cheap shedding of general traffic, and wrong for a public capability link that
 * decides a client's approval. This counter lives in the host KV and moves only
 * through `kvCompareAndSwap`, which every backend implements atomically (Postgres
 * as one guarded statement, SQLite in a transaction), so concurrent takers on
 * different instances can never exceed the limit.
 *
 * Shape: a FIXED window. Row key `hostext:ratelimit:<scope>:<sha256(key)>:<index>`
 * with value `{n, windowEnd, updatedAt}`. The window index is in the key, so a new
 * window is a new row and an old one is never read again; hashing keeps IPs and
 * tokens out of storage. A refused take writes nothing. Old rows are reclaimed by
 * the KV age-out lane (one day), and correctness never depends on that deletion.
 *
 * Cost: one read and one CAS write per call, which is why this is for public
 * token surfaces only and the global middleware stays in memory.
 *
 * Failure posture (D2), chosen by the caller:
 *  - `closed` (decisions and mutations): a counter that cannot be read or swapped
 *    throws a 503 `service_unavailable` with `retryAfterS: 5`, and sustained CAS
 *    contention refuses. A public write that decides something never runs
 *    unmetered.
 *  - `open` (reads): the same failures fall back to a per-process window and the
 *    result says `degraded: true` (logged at most once a minute).
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import type { Storage } from '../storage/storage.js';
import { hostExtStorage } from './hostExtPersistence.js';
import { registerKvAgeOut } from './kvAgeOut.js';

const log = createLogger('host.sharedRateLimit');

export const SHARED_RATE_LIMIT_PREFIX = 'hostext:ratelimit:';
// A loser re-reads from the CAS result (no extra round trip), so a burst of N
// racers on one key needs up to N attempts for the last one to land.
const CAS_ATTEMPTS = 64;
const SCOPE_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

registerKvAgeOut({ id: 'ratelimit:shared', prefix: SHARED_RATE_LIMIT_PREFIX, ttlDays: 1, timestampField: 'updatedAt' });

export interface SharedTake {
  /** Stable name of the limit, e.g. `campaign-ops.portal.token` (lowercase, dots, dashes). */
  scope: string;
  /** What is limited (a token, an IP, an org id). Hashed before storage. */
  key: string;
  limit: number;
  windowS: number;
  cost?: number;
  /** D2: `closed` for decisions and writes, `open` for reads. */
  failure: 'closed' | 'open';
  /** Defaults to the host KV; a caller may pass its own client. */
  storage?: Storage;
  now?: number;
}

export interface SharedTakeResult {
  allowed: boolean;
  remaining: number;
  /** Epoch ms when the current window ends. */
  resetAt: number;
  /** Seconds a refused caller should wait. */
  retryAfterS: number;
  /** Set when the shared counter failed and the per-process fallback answered. */
  degraded?: true;
}

interface WindowRow { n: number; windowEnd: number; updatedAt: string }

const keyHash = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 40);

function parseRow(raw: string | null): WindowRow | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<WindowRow>;
    return typeof v.n === 'number' && Number.isFinite(v.n) && v.n >= 0 && typeof v.windowEnd === 'number' ? (v as WindowRow) : null;
  } catch {
    return null;
  }
}

// The per-process fallback for `open` takes (D2). Bounded: entries for windows
// that have ended are dropped as the map is touched.
const local = new Map<string, { n: number; windowEnd: number }>();
const LOCAL_MAX = 10_000;
let lastDegradedLog = 0;

function takeLocal(id: string, limit: number, cost: number, windowEnd: number, now: number): SharedTakeResult {
  if (local.size >= LOCAL_MAX) for (const [k, v] of local) if (v.windowEnd <= now) local.delete(k);
  const cur = local.get(id);
  const n = cur && cur.windowEnd === windowEnd ? cur.n : 0;
  const retryAfterS = Math.max(1, Math.ceil((windowEnd - now) / 1000));
  if (n + cost > limit) return { allowed: false, remaining: Math.max(0, limit - n), resetAt: windowEnd, retryAfterS, degraded: true };
  if (local.size < LOCAL_MAX || local.has(id)) local.set(id, { n: n + cost, windowEnd });
  return { allowed: true, remaining: limit - n - cost, resetAt: windowEnd, retryAfterS, degraded: true };
}

function unavailable(scope: string, err: unknown): OpenwopError {
  log.warn('shared_rate_limit_unavailable', { scope, error: err instanceof Error ? err.message : String(err) });
  return new OpenwopError('service_unavailable', 'This is briefly unavailable. Try again in a few seconds.', 503, { reason: 'rate_limit_unavailable', retryAfterS: 5 });
}

/** Take `cost` units from the shared window, or refuse without spending. */
export async function takeShared(t: SharedTake): Promise<SharedTakeResult> {
  const cost = t.cost ?? 1;
  if (!SCOPE_RE.test(t.scope)) throw new Error(`sharedRateLimit: invalid scope '${t.scope}'`);
  if (!(t.limit > 0) || !(t.windowS > 0) || !(cost > 0)) throw new Error('sharedRateLimit: limit, windowS and cost must be > 0');
  const now = t.now ?? Date.now();
  const windowMs = t.windowS * 1000;
  const index = Math.floor(now / windowMs);
  const windowEnd = (index + 1) * windowMs;
  const id = `${t.scope}:${keyHash(t.key)}:${index}`;
  const rowKey = `${SHARED_RATE_LIMIT_PREFIX}${id}`;
  const retryAfterS = Math.max(1, Math.ceil((windowEnd - now) / 1000));

  const degrade = (err: unknown): SharedTakeResult => {
    if (t.failure === 'closed') throw unavailable(t.scope, err);
    if (now - lastDegradedLog > 60_000) {
      lastDegradedLog = now;
      log.warn('shared_rate_limit_degraded', { scope: t.scope, error: err instanceof Error ? err.message : String(err) });
    }
    return takeLocal(id, t.limit, cost, windowEnd, now);
  };

  let storage: Storage;
  try { storage = t.storage ?? hostExtStorage(); } catch (err) { return degrade(err); }
  try {
    let raw = await storage.kvGet(rowKey);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const n = parseRow(raw)?.n ?? 0;
      if (n + cost > t.limit) return { allowed: false, remaining: Math.max(0, t.limit - n), resetAt: windowEnd, retryAfterS };
      const next: WindowRow = { n: n + cost, windowEnd, updatedAt: new Date(now).toISOString() };
      const r = await storage.kvCompareAndSwap(rowKey, raw, JSON.stringify(next));
      if (r.swapped) return { allowed: true, remaining: t.limit - next.n, resetAt: windowEnd, retryAfterS };
      raw = r.actual;
    }
  } catch (err) {
    return degrade(err);
  }
  // Sustained contention: a closed limit refuses rather than run unmetered.
  log.warn('shared_rate_limit_contention', { scope: t.scope, attempts: CAS_ATTEMPTS });
  if (t.failure === 'closed') return { allowed: false, remaining: 0, resetAt: windowEnd, retryAfterS };
  return degrade(new Error('cas_contention'));
}
