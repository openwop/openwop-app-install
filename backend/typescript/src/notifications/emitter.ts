/**
 * Notification emitter — process-local fanout of newly-inserted
 * notifications to SSE subscribers, plus a single chokepoint helper
 * (`emitNotification`) that the executor + suspend manager call when
 * an action-needed event happens.
 *
 * Two-step shape mirrors `executor/eventLog.ts`:
 *   1. caller hands a NotificationRecord (already shaped + tenanted)
 *   2. emitter inserts into Storage then fans out to any subscribers
 *
 * Subscribers receive only their own tenant's notifications. Filtering
 * happens in the route layer so the emitter stays storage-only and
 * doesn't need to know about principal/tenant context.
 *
 * Process-local only: in a multi-instance Cloud Run deployment, a
 * notification inserted on instance A will not push to a client SSE'd
 * to instance B. The client polls `GET /v1/notifications` periodically
 * (or on tab focus) to backfill — same pattern as the run-event SSE
 * uses against the same Cloud Run service.
 */

import { randomBytes } from 'node:crypto';
import type { Storage } from '../storage/storage.js';
import type { NotificationRecord } from '../types.js';
import { pushNotification, pushNotificationsBatch } from './webPush.js';
import { deliverTeamsApprovalCard } from '../host/teamsApprovalDelivery.js';
import { deliverEmailForNotificationRecord } from '../host/emailApprovalDelivery.js';
import { assertEffectAllowed } from '../host/runEffectContext.js';
import {
  mintEffectIdentity,
  recordDurableEffectEscapeAt,
  type EffectIdentity,
} from '../host/effectEscapeLedger.js';
import { getInvocationLog } from '../executor/invocationLog.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('notifications.emitter');

let backend: Storage | null = null;
const subscribers = new Set<(n: NotificationRecord) => void>();

export function setNotificationBackend(storage: Storage): void {
  backend = storage;
}

/** Input accepted by both `emit` and `signal` — the full record minus the
 *  fields the emitter fills in. `status` is overridable only on `emit`. */
type RecordInput = Omit<NotificationRecord, 'notificationId' | 'createdAt' | 'status'> & {
  notificationId?: string;
  createdAt?: string;
  status?: NotificationRecord['status'];
};

/** Single source of truth for record construction — keeps `emit` and `signal`
 *  from drifting if `NotificationRecord` gains a field. */
function buildRecord(input: RecordInput): NotificationRecord {
  return {
    notificationId: input.notificationId ?? randomBytes(16).toString('hex'),
    tenantId: input.tenantId,
    recipientUserId: input.recipientUserId,
    // ADR 0050 Phase 3 role-addressed targeting. This was DECLARED on
    // `NotificationRecord`, PERSISTED by the storage adapters, and FILTERED by the
    // read path (`routes/notifications.ts` — default-deny: a member lacking the
    // role does not see it) — but dropped here, so it never reached a row. The
    // docblock above calls this function the single source of truth "if
    // `NotificationRecord` gains a field"; the field was gained and this was not
    // updated. No live data was affected because nothing wrote it yet, but the
    // omission inverts the guarantee for anything that does: a record with neither
    // `recipientUserId` nor `recipientRole` is a TENANT-WIDE BROADCAST, so a
    // role-addressed notice would have gone to everyone.
    recipientRole: input.recipientRole,
    type: input.type,
    priority: input.priority,
    status: input.status ?? 'unread',
    title: input.title,
    message: input.message,
    runId: input.runId,
    workflowId: input.workflowId,
    nodeId: input.nodeId,
    interruptId: input.interruptId,
    actionUrl: input.actionUrl,
    metadata: input.metadata,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

/** Fan a record out to every live SSE subscriber. A subscriber throwing must
 *  not abort the emit/signal or starve the other subscribers. */
function fanOut(record: NotificationRecord): void {
  for (const sub of subscribers) {
    try { sub(record); } catch { /* subscriber failures don't abort the fanout */ }
  }
}

/**
 * ADR 0591 P4 — the Layer-2 memo for a notification, read/written through the
 * SINGLE existing owner (`executor/invocationLog.ts`). No second dedup store.
 *
 * The memo is validated, never cast. `putInvocation` stores `result` as opaque
 * JSON, so what comes back is genuinely `unknown` — asserting `as
 * NotificationRecord` over it would let a malformed row become a "successfully
 * deduped" delivery that then fails somewhere further from the cause. A memo
 * that does not look like a record is treated as ABSENT, which re-fires the
 * notification: the wrong direction is delivering twice, not delivering a
 * corrupt object.
 */
function asNotificationRecord(value: unknown): NotificationRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  // EVERY non-optional field of `NotificationRecord`, not a sample of them. An
  // earlier revision checked only id/tenant/type/createdAt, which let a partial
  // memo through and returned it TYPED with `priority`/`status`/`title`/`message`
  // undefined — the cast would then be a lie about exactly the fields a renderer
  // reads. If the interface gains a required field, add it here; the compiler
  // cannot catch that, because the input is `unknown` by construction.
  for (const k of ['notificationId', 'tenantId', 'type', 'priority', 'status', 'createdAt'] as const) {
    if (typeof v[k] !== 'string' || v[k] === '') return null;
  }
  // `title`/`message` are required but may legitimately be empty strings.
  if (typeof v['title'] !== 'string' || typeof v['message'] !== 'string') return null;
  return value as NotificationRecord;
}

/** The retry-stable read: the newest record at this logical identity, whatever
 *  attempt produced it — the read RFC 0150 §B exists for. */
async function readNotificationMemo(identity: EffectIdentity): Promise<NotificationRecord | null> {
  let stored: unknown;
  try {
    stored = await getInvocationLog().latest({
      runId: identity.runId,
      nodeId: identity.nodeId,
      invocationId: identity.invocationId,
    });
  } catch (err) {
    // The invocation-log backend is not installed. Nothing at this seam can
    // dedupe without it, and staying silent would make a host with Layer-2
    // switched off look identical to one that deduped — so say so loudly. The
    // emit proceeds: refusing to notify would turn a bookkeeping gap into a
    // dropped user-visible message.
    log.error('ADR 0591: notification dedup unavailable — invocation log not installed; duplicate delivery is possible', {
      runId: identity.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  return asNotificationRecord(stored);
}

/**
 * ADR 0618 — the atomic Layer-2 claim. `true` iff THIS caller must fire.
 *
 * Fails OPEN on a storage error, deliberately and asymmetrically to
 * `readNotificationMemo`, which fails open for the same reason: a host whose
 * claim backend is unavailable would otherwise stop notifying entirely. A
 * missing dedup is a duplicate; a claim that always denies is a silent outage.
 * Both are logged at error, because a host running without Layer-2 must not
 * look identical to one that has it.
 */
const CLAIM_STALE_AFTER_MS = 10 * 60_000;

async function claimNotificationEffect(identity: EffectIdentity): Promise<boolean> {
  try {
    return await getInvocationLog().claim(
      { runId: identity.runId, nodeId: identity.nodeId, invocationId: identity.invocationId },
      { nowMs: Date.now(), staleAfterMs: CLAIM_STALE_AFTER_MS },
    );
  } catch (err) {
    log.error('ADR 0618: invocation claim unavailable — concurrent duplicate suppression is OFF for this emit', {
      runId: identity.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

async function writeNotificationMemo(identity: EffectIdentity, record: NotificationRecord): Promise<void> {
  try {
    await getInvocationLog().put(
      {
        runId: identity.runId,
        nodeId: identity.nodeId,
        attempt: identity.attempt,
        invocationId: identity.invocationId,
      },
      record,
    );
  } catch (err) {
    // The notification HAS been delivered at this point. Failing the emit now
    // would report a delivered message as failed; the honest cost of a missing
    // memo is that a redelivery re-fires, which is the pre-existing behaviour.
    log.error('ADR 0591: notification memo write failed — a redelivery of this identity will re-fire', {
      runId: identity.runId,
      notificationId: record.notificationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function getNotificationEmitter() {
  if (!backend) throw new Error('Notification backend not installed');
  const b = backend;
  return {
    async emit(input: RecordInput): Promise<NotificationRecord> {
      // ADR 0531 — the #2871 seam. A notification is a durable, user-visible
      // effect: a replay that re-emits notifies a real person a second time.
      assertEffectAllowed('notification', input.type);
      // ADR 0591 P4 — RFC 0158 §C.7 LAYER-2 DEDUP, on the identity that
      // survives redelivery.
      //
      // WHY THIS SEAM NEEDED IT. The guard above only refuses during a REPLAY
      // (`sourceOutcomes` present). A dispatch-recovery re-dispatch is not a
      // replay: `runDispatchSweeper.ts:201` calls `executeRun` with no
      // `resumeSnapshot`/`resumeFromNodeIndex`, and `sourceOutcomes` is
      // populated only for `replayInvocationsFromRunId`, so an orphaned run
      // (`status IN ('pending','running')` with an expired lease) RESTARTS from
      // the top with `replaying: false`. The guard allows, and this notified a
      // real person a second time. §C.7 is a MUST-dedupe — "MUST dedupe on an
      // identity that survives redelivery" — so that was a genuine gap, not a
      // test-harness artifact.
      //
      // The fix reuses the ONE dedup mechanism (`executor/invocationLog.ts`,
      // keyed by the RFC 0150 §B identity) rather than adding a second beside
      // it. It works because the recovery lane re-executes the node from the
      // start, so the ordinal — and therefore the identity — reproduces.
      //
      // ORDER IS LOAD-BEARING, in both directions:
      //   - the ledger row is appended AFTER the dedup miss, so a correctly
      //     SUPPRESSED emit records no escape (otherwise the §C.7 witness
      //     false-FAILs a conformant host);
      //   - and BEFORE the insert, so a crash between the two cannot lose it
      //     (a lost row makes a real double-fire read as one).
      //
      // WHAT THIS DOES NOT CLOSE: CONCURRENT delivery. The lookup and the write
      // are not atomic and `putInvocation` is `INSERT OR REPLACE`, so it cannot
      // serve as a compare-and-set claim. Two INSTANCES executing the same
      // identity at once both mint it (each process has its own module-level
      // ordinal counter, both starting at 0), both miss, and both fire:
      //
      //   A: mint → MISS → append/insert/put
      //   B: mint → MISS → append/insert/put          → two notifications
      //
      // That needs two processes — within one process the shared ordinal counter
      // hands the second emit a DIFFERENT identity, so it is not reproducible
      // single-instance. Real orphan recovery is sequential (the lane re-dispatches
      // a run whose owner is presumed crashed), which is the case §C.7 describes
      // and the case this closes. But the lane has no interlock — it sets a lease
      // without stopping the previous owner — so a late lease renewal under a GC
      // pause or a slow write can expire the lease while the original executor is
      // still alive, and then both run. Closing that needs a real CAS claim
      // (an `ON CONFLICT DO NOTHING` insert used as a lock), not a longer read.
      //
      // ADR 0618 — CLOSED. That claim now exists (`storage.claimInvocation`), and
      // the paragraph above stands as the description of what this code did until
      // it did. `spec/v1/idempotency.md` §"Concurrent duplicates (Layer 2)" makes
      // the atomic claim a MUST, unconditionally and explicitly "within a
      // single-instance deployment".
      //
      // ORDER MATTERS, and it is: memo → claim → fire → memo.
      //   - the memo read stays FIRST and unchanged: it is the retry-stable
      //     fast path (RFC 0150 §B) and it must not start costing a write.
      //   - the claim is what two CONCURRENT executors contend on. Exactly one
      //     wins; the loser re-reads the memo, because the winner may have
      //     finished between our miss and our claim.
      //   - a loser that still sees no memo returns the winner's in-flight
      //     delivery as suppressed rather than firing a second one. Suppressing
      //     a duplicate is the entire point; the alternative is the duplicate.
      const identity = mintEffectIdentity(`notification:${input.type}`);
      const memo = identity ? await readNotificationMemo(identity) : null;
      // Suppressed: return what the first delivery produced. No ledger row, no
      // second insert, no second person notified.
      if (memo) return memo;
      if (identity) {
        const won = await claimNotificationEffect(identity);
        if (!won) {
          // Someone else holds this identity. Re-read: they may have completed
          // while we were contending.
          const raced = await readNotificationMemo(identity);
          if (raced) return raced;
          log.warn('ADR 0618: concurrent duplicate suppressed — another executor holds this effect identity', {
            runId: identity.runId,
            nodeId: identity.nodeId,
          });
          return buildRecord(input);
        }
      }
      if (identity) await recordDurableEffectEscapeAt(identity);
      const record = buildRecord(input);
      await b.insertNotification(record);
      if (identity) await writeNotificationMemo(identity, record);
      fanOut(record);
      // Fan out to every Web Push subscription owned by the tenant.
      // Best-effort + concurrent — push delivery latency must not
      // block the emit return. `pushNotification` swallows per-sub
      // errors and prunes 404/410 endpoints on its own; PRV-6: the outer
      // `.catch` guarantees a whole-promise rejection (e.g. the subscription
      // storage read failing) can never surface as an unhandled rejection.
      void pushNotification(b, record).catch((err: unknown) => {
        log.warn('web-push fanout failed', {
          notificationId: record.notificationId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      // ADR 0198 Phase B — best-effort Teams adaptive-card delivery for
      // addressed action-needed notifications (sent via the RECIPIENT's own
      // microsoft365 connection; silent no-op without a delivery pref).
      // Same isolation contract as webPush: never breaks the insert.
      void deliverTeamsApprovalCard(b, record).catch((err: unknown) => {
        log.warn('teams approval-card delivery failed', {
          notificationId: record.notificationId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      // ADR 0478 §2 — best-effort email delivery for ADDRESSED action-needed
      // notifications (opt-in pref; interrupt-backed records are handled by
      // the token lane in notify.ts — this sibling skips them). Same
      // isolation contract as Teams: never breaks the insert.
      try {
        deliverEmailForNotificationRecord(record);
      } catch (err) {
        log.warn('email approval delivery failed', {
          notificationId: record.notificationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return record;
    },
    /**
     * ADR 0214 D3 — emit MANY records (all the same tenant) with a single batched
     * web-push (loads the subscription table once, not once per record). Each record
     * still gets its own durable inbox insert + SSE fan-out (per-recipient by design).
     * Teams cards are intentionally skipped — the batch path is channel activity, not
     * an approval surface. Returns the inserted records.
     */
    async emitMany(inputs: RecordInput[]): Promise<NotificationRecord[]> {
      // ADR 0531 — gate the BATCH before any row lands. Per-item isolation below
      // deliberately swallows individual insert failures, so a per-item guard
      // would be swallowed too and the replay would proceed silently.
      if (inputs.length > 0) assertEffectAllowed('notification', `emitMany×${inputs.length}`);
      // ADR 0591 — NOT DEDUPED, AND NOT LEDGERED. Stated here rather than only in
      // the ADR because this is the same public surface as `emit` above: a caller
      // moving from `emit` to `emitMany` silently loses BOTH the RFC 0158 §C.7
      // redelivery dedup AND its visibility to the effect-escape ledger, with
      // nothing at the call site to say so. A batch redelivered by the orphan
      // lane re-notifies every recipient, and the `replay/effect-escapes` seam
      // reports none of it.
      //
      // Not fixed here on purpose: the batch has no per-item logical identity to
      // dedupe ON — `nextLogicalInvocationOrdinal` allocates one ordinal per
      // call, so giving each item an identity is a design decision about what a
      // "logical effect" is for a batch, not a mechanical extension. Doing it
      // wrong would mint identities that do not reproduce across a re-dispatch,
      // which is worse than no dedup: it would make the witness read 1 while two
      // batches actually fired.
      // Per-item isolation: one recipient's insert failing must not drop the others
      // (nor skip the whole web-push batch). Only the rows that actually landed are
      // pushed + returned.
      const inserted: NotificationRecord[] = [];
      for (const record of inputs.map(buildRecord)) {
        try {
          await b.insertNotification(record);
          fanOut(record);
          inserted.push(record);
        } catch (err: unknown) {
          log.warn('notification insert failed (emitMany)', { notificationId: record.notificationId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (inserted.length > 0) {
        void pushNotificationsBatch(b, inserted).catch((err: unknown) => {
          log.warn('web-push batch fanout failed', { count: inserted.length, error: err instanceof Error ? err.message : String(err) });
        });
      }
      return inserted;
    },
    /**
     * ADR 0074 — fan out a transient frame to SSE subscribers WITHOUT
     * persisting it or web-pushing it. Used for `review.updated` cache hints
     * that should reach every connected tenant member (broadcast: omit
     * `recipientUserId`) but must never land in the durable inbox or grow
     * storage. The frame is a full `NotificationRecord` shape so the stream
     * route's tenant/recipient filter (`routes/notifications.ts`) applies
     * unchanged; the FE notification store routes signal types to the
     * review-status store instead of the inbox.
     */
    signal(input: Omit<RecordInput, 'status'>): NotificationRecord {
      // Transient: build the record, fan out to live subscribers, and return.
      // Deliberately NO `insertNotification` and NO web-push — never persisted.
      const record = buildRecord(input);
      fanOut(record);
      return record;
    },
    subscribe(fn: (n: NotificationRecord) => void): () => void {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}
