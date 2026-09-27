/**
 * Email sent-ledger (ADR 0193) — the ONE durable record of "this (run, node)
 * already sent", shared by both send paths so there is a single source of
 * truth for send idempotency:
 *   - the transactional adapter (`emailAdapter.ts`, Phase 1 — SendGrid/Postmark), and
 *   - the provider-native `core.email.send` node (Phase 2 — Gmail/Graph as the
 *     connected human).
 *
 * A send is a non-idempotent side effect, so a REPLAY / retry / post-approval
 * re-invoke of the SAME run MUST NOT re-send. Callers `get(key)` before sending
 * and `put()` only on a genuine accept; the key is tenant-prefixed and anchored
 * on the caller's run+node (or the transactional adapter's fork-stable
 * `idempotencyKey`). Mirrors the `ads:dispatch` ledger (`adsAdapter.ts`) —
 * sequential per run, not CAS-guarded (no concurrent same-key send within one run).
 *
 * NOTE — fork dedup depends on the CALLER'S key (WF-EM-6). The `email-send` node
 * supplies a fork-stable, content-anchored `idempotencyKey` (`nodeId` + content,
 * NO runId), so a `:fork` — which mints a new runId — derives the SAME key and
 * THIS LEDGER DEDUPS the re-send (`email-send` has no approval interrupt, so this
 * ledger is the guard, not a human re-approval). Only the fallback path — a caller
 * that supplies no key, so `ledgerKey` derives a run-scoped key — is fork-fresh (a
 * new runId ⇒ a new key) and carries no cross-fork suppression by construction.
 * See `emailAdapter.ts` `ledgerKey`.
 *
 * Retention (ADR 0193 §Retention / ADR 0201 follow-up — LANDED): a ledger row
 * only needs to outlive the replay / retry / `:fork` window of its run, so
 * `sweepExpiredEmailSent` (below) deletes rows older than
 * `OPENWOP_EMAIL_LEDGER_TTL_DAYS` (default 30 — far beyond any real replay
 * window). It rides the webhook-delivery worker tick, the same cadence as
 * `sweepExpiredApprovalGates`.
 */
import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.emailSentLedger');

export interface EmailSentRecord {
  key: string;
  tenantId: string;
  provider: string;
  messageId: string;
  createdAt: string;
}

const ledger = new DurableCollection<EmailSentRecord>('email:sent', (r) => r.key);

/** The recorded accepted send for `key`, or null. */
export function priorSend(key: string): Promise<EmailSentRecord | null> {
  return ledger.get(key);
}

/** Record an accepted send (put-on-accept only — a failed send is not recorded,
 *  so a retry re-sends). */
export function recordSend(rec: EmailSentRecord): Promise<void> {
  return ledger.put(rec);
}

/**
 * DEF-3 (CODEBASE-ASSESSMENT) — atomically claim `key` before a send, via the
 * DurableCollection cross-instance CAS (insert-if-absent). Two instances
 * racing the same key (a ROUTE-driven send retried in parallel — the invite
 * path; node execution stays sequential per run) resolve to exactly one
 * 'reserved' winner. The reservation row carries `messageId: ''` until
 * `recordSend` overwrites it on provider accept.
 *
 * Trade-off (deliberate): a crash between reserve and accept leaves the
 * reservation in place, so that key becomes AT-MOST-ONCE (no resend) until
 * the TTL sweep clears it — for email, a suppressed duplicate beats a double
 * send. An ordinary failed send is NOT affected: callers release() on
 * failure, restoring retry-re-sends.
 */
export async function reserveSend(rec: EmailSentRecord): Promise<'reserved' | 'duplicate'> {
  return (await ledger.compareAndSwap(null, rec)) ? 'reserved' : 'duplicate';
}

/** Release a reservation after a FAILED send so a retry can re-send. */
export async function releaseSend(key: string): Promise<void> {
  await ledger.delete(key);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_MS_DEFAULT = 30 * DAY_MS;
/** Bound deletes per sweep tick so one tick can't do unbounded work on a large
 *  ledger (mirrors `sweepExpiredApprovalGates`' `SWEEP_BATCH`). A backlog just
 *  drains over successive ticks. */
const SWEEP_DELETE_CAP = 500;

/** Records older than this many days are eligible for the sweep. Generous by
 *  default — a delayed replay/`:fork` re-send is a far worse failure than a
 *  slightly-larger ledger, so the TTL sits well beyond any real replay window. */
function ttlMs(): number {
  const days = Number(process.env.OPENWOP_EMAIL_LEDGER_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? days * DAY_MS : TTL_MS_DEFAULT;
}

/**
 * Delete accepted-send rows older than the retention TTL. Fail-contained (a bad
 * row can't wedge the worker tick that hosts it) and bounded (`SWEEP_DELETE_CAP`
 * per call). Rows with an unparseable `createdAt` are KEPT (never delete a row we
 * can't confidently age). Returns the number deleted. Called from the
 * webhook-delivery worker tick.
 */
export async function sweepExpiredEmailSent(now: number = Date.now()): Promise<number> {
  const cutoff = now - ttlMs();
  let all: EmailSentRecord[];
  try {
    all = await ledger.list();
  } catch (err) {
    log.warn('email ledger sweep list failed', { error: err instanceof Error ? err.message : String(err) });
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
      log.warn('email ledger sweep delete failed', { key: rec.key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (deleted > 0) log.info('email ledger sweep', { deleted });
  return deleted;
}
