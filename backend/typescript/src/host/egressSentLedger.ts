/**
 * Egress send-ledger (ADR 0619) — the ONE durable record of "this (run, node)
 * already sent" for the brokered NON-email egress channels (SMS + push, and
 * voice when `ctx.voice` lands). The email sibling is `emailSentLedger` (ADR 0193);
 * this generalises the SAME put-on-accept dedup for the other channels so a
 * within-run `config.retry` re-run (ADR 0326 — the invocation-log cache is keyed
 * per attempt, so a retry re-executes the node body) or a genuine cross-run
 * re-dispatch does not double-send.
 *
 * A send is a non-idempotent side effect. Callers `priorSend(key)` before sending
 * and `recordSend()` only on a genuine provider accept; the key is tenant- AND
 * channel-prefixed over the caller's `idempotencyKey` — a SHA-256 the send node
 * derives over `(runId, nodeId, recipient, content)` (see `index.mjs`), so it is
 * INVARIANT across a `config.retry` re-run (same runId, same key) but DISTINCT
 * across two genuinely-separate runs.
 *
 * NB — unlike `emailSentLedger`'s WF-EM-6 key, this key INCLUDES runId, and this
 * ledger is NOT the `:fork` guard. The send nodes are in the ADR 0341 served-set
 * (`MANIFEST_FAST_PATH_SERVED`), so a replay / `:fork` serves the source run's
 * recorded outcome and NEVER re-invokes the adapter — the runId in the key is
 * irrelevant on a fork because the adapter is not reached at all. This ledger
 * guards only the axes ADR 0341 does not: a within-run `config.retry` re-run and a
 * same-runId dispatch-recovery restart (an orphaned run re-driven through
 * `executeRun` with the SAME runId) — both re-execute the node body live with the
 * same key. Mirrors `emailSentLedger` mechanically — node execution is sequential
 * per run, and `reserveSend` is the cross-instance CAS.
 *
 * Stores NO name/address/body — the recipient (phone number / device token) is
 * hashed into the caller's `idempotencyKey`, never persisted plaintext. So under
 * ADR 0464 this collection is classified EXEMPT by PARITY with `email:sent`
 * (`test/subject-erasure-coverage.test.ts`): TTL-swept, no subject data, and early
 * deletion would un-dedup a live send generation and risk double-delivery to the
 * very subject requesting erasure — the TTL is the right reclaim.
 *
 * Retention: `sweepExpiredEgressSent` deletes rows older than
 * `OPENWOP_EGRESS_LEDGER_TTL_DAYS` (default 30 — well beyond any real replay
 * window), bounded per tick, riding the same worker tick as `sweepExpiredEmailSent`.
 */
import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.egressSentLedger');

/** The brokered non-email egress channels this ledger dedups. */
export type EgressChannel = 'sms' | 'push' | 'voice';

export interface EgressSentRecord {
  key: string;
  tenantId: string;
  channel: EgressChannel;
  provider: string;
  /** The provider's accepted-send reference (Twilio `sid` / Expo `id`); `''` on a
   *  reservation row until `recordSend` overwrites it on accept. */
  providerRef: string;
  createdAt: string;
}

const ledger = new DurableCollection<EgressSentRecord>('egress:sent', (r) => r.key);

/** Tenant- and channel-prefixed ledger key over the caller's fork-stable idempotency key. */
export function egressLedgerKey(tenantId: string, channel: EgressChannel, idempotencyKey: string): string {
  return `${tenantId}:${channel}:${idempotencyKey}`;
}

/** The recorded accepted send for `key`, or null. */
export function priorSend(key: string): Promise<EgressSentRecord | null> {
  return ledger.get(key);
}

/** Record an accepted send (put-on-accept only — a failed send is not recorded,
 *  so a retry re-sends). */
export function recordSend(rec: EgressSentRecord): Promise<void> {
  return ledger.put(rec);
}

/**
 * Atomically claim `key` before a send, via the DurableCollection cross-instance
 * CAS (insert-if-absent). Two instances racing the same key resolve to exactly one
 * 'reserved' winner; the reservation row carries `providerRef: ''` until
 * `recordSend` overwrites it on accept. Mirrors `emailSentLedger.reserveSend`
 * (same deliberate at-most-once-on-crash trade-off: a suppressed duplicate beats a
 * double send; callers `releaseSend` on failure to restore retry-re-sends).
 */
export async function reserveSend(rec: EgressSentRecord): Promise<'reserved' | 'duplicate'> {
  return (await ledger.compareAndSwap(null, rec)) ? 'reserved' : 'duplicate';
}

/** Release a reservation after a FAILED send so a retry can re-send. */
export async function releaseSend(key: string): Promise<void> {
  await ledger.delete(key);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_MS_DEFAULT = 30 * DAY_MS;
/** Bound deletes per sweep tick (mirrors `sweepExpiredEmailSent`' `SWEEP_DELETE_CAP`). */
const SWEEP_DELETE_CAP = 500;

function ttlMs(): number {
  const days = Number(process.env.OPENWOP_EGRESS_LEDGER_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? days * DAY_MS : TTL_MS_DEFAULT;
}

/**
 * Delete accepted-send rows older than the retention TTL. Fail-contained and
 * bounded (`SWEEP_DELETE_CAP` per call). Rows with an unparseable `createdAt` are
 * KEPT. Returns the number deleted. Called from the webhook-delivery worker tick,
 * the same cadence as `sweepExpiredEmailSent`.
 */
export async function sweepExpiredEgressSent(now: number = Date.now()): Promise<number> {
  const cutoff = now - ttlMs();
  let all: EgressSentRecord[];
  try {
    all = await ledger.list();
  } catch (err) {
    log.warn('egress ledger sweep list failed', { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
  let deleted = 0;
  for (const rec of all) {
    if (deleted >= SWEEP_DELETE_CAP) break;
    const stamped = Date.parse(rec.createdAt);
    if (!Number.isFinite(stamped) || stamped >= cutoff) continue; // keep fresh / unparseable
    try {
      if (await ledger.delete(rec.key)) deleted++;
    } catch (err) {
      log.warn('egress ledger sweep delete failed', { key: rec.key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (deleted > 0) log.info('egress ledger sweep', { deleted });
  return deleted;
}
