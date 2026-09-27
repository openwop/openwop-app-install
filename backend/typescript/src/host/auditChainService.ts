/**
 * Per-tenant tamper-evident audit hash-chain (ADR 0301 / CDP-F).
 *
 * The single owner + only appender of a per-tenant, append-only, hash-chained
 * audit log scoped NARROWLY to CDP-F governance events: consent changes and
 * governance/approval decisions.
 * — Scope correction (ADR 0389 P2, 2026-07-17): `security.*` kinds now ride
 *   this SAME chain (secret reveal/rotate/delete, break-glass). Tamper
 *   evidence matters MORE for security events than consent rows, and a second
 *   `security:audit` collection would have duplicated this owner — the exact
 *   two-audit-systems smell. Kinds stay free strings; nothing else changes. This is NOT the run-event log (`emit`/telemetry)
 * nor the unified `governanceDecisionLog`/`Storage.appendAudit` stream — those are
 * plain, mutable audit rows. This log is HASH-CHAINED so any after-the-fact
 * mutation of a persisted entry is detectable by `verifyChain`.
 *
 * ── Durability & shape ──────────────────────────────────────────────────────
 * A DURABLE SIDE-LOG (two `DurableCollection`s over `host_ext_kv`), NOT run-state:
 * it does not participate in `:fork` and is never rewound by replay. Each entry is
 *   { tenantId, seq, prevHash, entryHash, kind, at, payload }
 * keyed `${tenantId}:${seq}`, plus a per-tenant HEAD pointer keyed `${tenantId}`.
 * Genesis is a real seq-0 entry with prevHash = '0'*64; real appends are seq 1..N.
 *   entryHash = sha256(prevHash + canonicalize({tenantId, seq, kind, at, payload}))
 * where `canonicalize` is deterministic JSON with recursively, stably-sorted keys
 * so the hash is reproducible and independently verifiable.
 *
 * ── THE CRITICAL GUARD: per-tenant serialized append (belt + braces) ─────────
 * Two concurrent appends MUST NOT fork the chain or reuse a seq. Serialized two
 * ways, both load-bearing:
 *   1. STORE-LEVEL COMPARE-AND-SWAP (the cross-instance correctness guarantee):
 *      the new entry claims its seq via an INSERT-IF-ABSENT CAS on `${tenantId}:
 *      ${seq}` (`DurableCollection.compareAndSwap(null, entry)` → storage
 *      `kvCompareAndSwap`). Exactly one writer wins a given seq; a loser re-reads
 *      the (now-advanced) head and retries the NEXT seq. The seq claim being
 *      exclusive is what forces appends to serialize across processes — the head
 *      pointer only advances by the seq-winner, so it can never fork. This is the
 *      same proven idiom as `eventSchemaService.registerEventSchema`.
 *   2. IN-PROCESS PER-TENANT ASYNC MUTEX (removes CAS spin within one process):
 *      `withTenantLock` chains a tenant's appends through a promise queue so, in a
 *      single instance, they execute strictly one-at-a-time and never contend on
 *      the CAS at all. This is the belt to the CAS's braces — it is an
 *      optimization for the common single-instance case; the CAS remains the hard
 *      guarantee that holds across instances where an in-process mutex cannot.
 * Retries are bounded; genuine exhaustion (pathological same-instant contention)
 * throws rather than looping forever.
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from './hostExtPersistence.js';

/** Seeded audit kinds (CDP-F scope). `kind` is a free string so future governance
 *  events can append without a schema change; these are the two wired today. */
export const AUDIT_KIND_CONSENT_CHANGE = 'consent.change';
export const AUDIT_KIND_GOVERNANCE_DECISION = 'governance.decision';
const GENESIS_KIND = 'genesis';

/** The all-zero prev-hash that anchors seq 0 (there is no prior entry). */
const GENESIS_PREV_HASH = '0'.repeat(64);

/** Bounded retry for the seq-claim CAS. A CAS loss is forward progress (a peer
 *  advanced the head; the loser simply takes the next seq), so the loop always
 *  terminates; under N simultaneous appends a writer needs at most ~N attempts.
 *  The cap only has to exceed realistic burst concurrency — appends are rare and
 *  off the hot path — so the terminal throw fires solely under pathological
 *  same-instant contention, bounding per-call storage work. */
const MAX_APPEND_ATTEMPTS = 50;

/** One hash-chained audit entry. */
export interface AuditEntry {
  tenantId: string;
  /** 0 = genesis; real appends are 1..N, contiguous, gap-free. */
  seq: number;
  /** entryHash of seq-1 (or '0'*64 at genesis). */
  prevHash: string;
  /** sha256(prevHash + canonicalize({tenantId, seq, kind, at, payload})). */
  entryHash: string;
  kind: string;
  /** ISO-8601 append time (stored, so the hash is recomputable from the row). */
  at: string;
  payload: Record<string, unknown>;
}

/** Per-tenant head pointer — the durable "latest" cache the CAS advances. */
interface AuditHead {
  tenantId: string;
  seq: number;
  headHash: string;
}

const entries = new DurableCollection<AuditEntry>(
  'cdp:audit-chain',
  (e) => `${e.tenantId}:${e.seq}`,
  undefined,
  (e) => e.tenantId,
);
const heads = new DurableCollection<AuditHead>(
  'cdp:audit-head',
  (h) => h.tenantId,
  undefined,
  (h) => h.tenantId,
);

// ── canonicalization + hashing ──────────────────────────────────────────────

/** Recursively sort object keys (arrays keep order) so serialization is stable. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortValue(obj[k]);
    return out;
  }
  return value;
}

/** Deterministic JSON with stably-sorted keys — the hashed, verifiable form. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function computeEntryHash(e: {
  tenantId: string;
  seq: number;
  kind: string;
  at: string;
  payload: Record<string, unknown>;
  prevHash: string;
}): string {
  const body = canonicalize({ tenantId: e.tenantId, seq: e.seq, kind: e.kind, at: e.at, payload: e.payload });
  return createHash('sha256').update(e.prevHash + body).digest('hex');
}

// ── per-tenant in-process serialization (belt) ──────────────────────────────

const tenantChains = new Map<string, Promise<unknown>>();

/** Run `fn` after any in-flight append for `tenantId` settles — a per-tenant
 *  async mutex so a single instance never contends on the seq-claim CAS. The tail
 *  promise swallows outcomes so one caller's rejection can't poison the queue. */
function withTenantLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tenantChains.get(tenantId) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run regardless of the previous call's outcome
  tenantChains.set(tenantId, run.then(() => undefined, () => undefined));
  return run;
}

// ── append ──────────────────────────────────────────────────────────────────

/** Lazily create the seq-0 genesis entry + head for a tenant. Idempotent and
 *  cross-instance safe: the genesis seq is claimed with an insert-if-absent CAS,
 *  and a loser adopts the WINNER's persisted genesis hash (their `at` differs, so
 *  the loser must not trust its own recomputed hash). */
async function ensureGenesis(tenantId: string): Promise<AuditHead> {
  const existing = await heads.get(tenantId);
  if (existing) return existing;

  const at = new Date().toISOString();
  const genesis: AuditEntry = {
    tenantId,
    seq: 0,
    prevHash: GENESIS_PREV_HASH,
    kind: GENESIS_KIND,
    at,
    payload: {},
    entryHash: computeEntryHash({ tenantId, seq: 0, kind: GENESIS_KIND, at, payload: {}, prevHash: GENESIS_PREV_HASH }),
  };

  if (await entries.compareAndSwap(null, genesis)) {
    const head: AuditHead = { tenantId, seq: 0, headHash: genesis.entryHash };
    await heads.compareAndSwap(null, head); // safe if a peer set it first
    return (await heads.get(tenantId)) ?? head;
  }

  // Lost the genesis claim — adopt the persisted winner's hash, and make sure a
  // head exists (the winner may not have written it yet).
  const persisted = await entries.get(`${tenantId}:0`);
  const head: AuditHead = { tenantId, seq: 0, headHash: persisted?.entryHash ?? genesis.entryHash };
  const current = await heads.get(tenantId);
  if (current) return current;
  await heads.compareAndSwap(null, head);
  return (await heads.get(tenantId)) ?? head;
}

/**
 * Append one governance event to the tenant's hash-chain and return the entry.
 * Serialized per tenant by the in-process mutex AND the seq-claim CAS (see the
 * file header). Never forks the chain or reuses a seq.
 */
export function appendAudit(tenantId: string, kind: string, payload: Record<string, unknown>): Promise<AuditEntry> {
  if (!tenantId) return Promise.reject(new Error('appendAudit requires a tenantId'));
  return withTenantLock(tenantId, () => appendAuditCas(tenantId, kind, payload));
}

async function appendAuditCas(tenantId: string, kind: string, payload: Record<string, unknown>): Promise<AuditEntry> {
  await ensureGenesis(tenantId);
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    const head = await heads.get(tenantId);
    if (!head) { await ensureGenesis(tenantId); continue; } // head lost between calls — re-seed
    const seq = head.seq + 1;
    const prevHash = head.headHash;
    const at = new Date().toISOString();
    const entry: AuditEntry = {
      tenantId,
      seq,
      prevHash,
      kind,
      at,
      payload,
      entryHash: computeEntryHash({ tenantId, seq, kind, at, payload, prevHash }),
    };
    // Claim the seq (insert-if-absent). A loss means a peer took this seq — re-read
    // the advanced head and retry the next one. This CAS is the true serializer.
    if (!(await entries.compareAndSwap(null, entry))) {
      // GRADE-PASS 2026-07-17 (DATA-2/SEC-C7): if the seq-winner crashed between
      // its entry CAS and its head advance, the head is stale FOREVER and every
      // future append spins to exhaustion — bricking the tenant's chain (and
      // with it the fail-closed vault reveal). Self-heal: adopt the orphan
      // entry that chains off our head and advance the head to it.
      const orphan = await entries.get(`${tenantId}:${seq}`);
      if (orphan && orphan.prevHash === prevHash) {
        await heads.compareAndSwap(head, { tenantId, seq, headHash: orphan.entryHash });
      }
      continue;
    }
    // Advance the head. Because the seq claim above is exclusive, no other writer
    // can have advanced the head off `head` since we read it, so this CAS holds;
    // even if it somehow lost, the entry is already durably + correctly chained.
    await heads.compareAndSwap(head, { tenantId, seq, headHash: entry.entryHash });
    return entry;
  }
  throw new Error(`appendAudit exhausted ${MAX_APPEND_ATTEMPTS} attempts under contention for tenant '${tenantId}'`);
}

// ── verify + read ───────────────────────────────────────────────────────────

/**
 * Walk seq 0..head recomputing each entryHash from its stored fields and checking
 * the prev-hash linkage. Returns the first seq whose recomputed hash or linkage
 * fails (tamper detection), or `{ ok: true }` for an intact / empty chain.
 */
export async function verifyChain(tenantId: string): Promise<{ ok: boolean; brokenAt?: number }> {
  const head = await heads.get(tenantId);
  if (!head) return { ok: true }; // never appended — trivially intact
  let prevHash = GENESIS_PREV_HASH;
  for (let seq = 0; seq <= head.seq; seq++) {
    const entry = await entries.get(`${tenantId}:${seq}`);
    if (!entry) return { ok: false, brokenAt: seq }; // missing link
    if (entry.prevHash !== prevHash) return { ok: false, brokenAt: seq }; // broken linkage
    if (computeEntryHash(entry) !== entry.entryHash) return { ok: false, brokenAt: seq }; // tampered fields
    prevHash = entry.entryHash;
  }
  return { ok: true };
}

/** The current head (seq + hash) for a tenant, or null if nothing was appended. */
export async function getAuditHead(tenantId: string): Promise<{ seq: number; headHash: string } | null> {
  const head = await heads.get(tenantId);
  return head ? { seq: head.seq, headHash: head.headHash } : null;
}

/** Read a tenant's full chain (seq 0..head), ascending. */
export async function listChain(tenantId: string): Promise<AuditEntry[]> {
  const head = await heads.get(tenantId);
  if (!head) return [];
  const out: AuditEntry[] = [];
  for (let seq = 0; seq <= head.seq; seq++) {
    const entry = await entries.get(`${tenantId}:${seq}`);
    if (entry) out.push(entry);
  }
  return out;
}

/** Test-only — force the head pointer to a stale value to simulate the
 *  crash-between-CAS-and-head-advance window (grade-pass DATA-2). */
export async function __forceHeadForTest(tenantId: string, seq: number, headHash: string): Promise<void> {
  await heads.put({ tenantId, seq, headHash });
}

/** Test-only: clear both collections and the in-process locks. */
export async function __resetAuditChain(): Promise<void> {
  await entries.__clear();
  await heads.__clear();
  tenantChains.clear();
}

/** Test-only: overwrite a persisted entry's stored fields WITHOUT re-hashing —
 *  simulates tampering in the store so `verifyChain` can be exercised. */
export async function __tamperEntryForTest(tenantId: string, seq: number, mutate: (e: AuditEntry) => AuditEntry): Promise<void> {
  const entry = await entries.get(`${tenantId}:${seq}`);
  if (!entry) throw new Error(`no entry at ${tenantId}:${seq}`);
  await entries.put(mutate(entry));
}
