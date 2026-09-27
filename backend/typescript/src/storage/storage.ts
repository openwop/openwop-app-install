/**
 * Narrow storage interface used by the workflow-engine sample.
 *
 * As of P3.3, every method returns a Promise. The sqlite + memory
 * backends wrap their sync `better-sqlite3` calls in `async` (cheap;
 * the Promise is resolved synchronously). The Postgres backend uses
 * `pg` natively. Callers `await` every call.
 *
 * Backends implement these methods atomically (per-method ACID where
 * the backing store supports it). The sqlite impl uses transactions
 * where multiple writes must be atomic (e.g., event append + sequence
 * increment); the Postgres impl uses `BEGIN`/`COMMIT` around the same
 * sequences.
 */

import type {
  AnnotationRecord,
  ChatMessageRecord,
  ChatSessionRecord,
  DispatchOutboxRecord,
  DispatchOutboxStats,
  EventRecord,
  IdempotencyRecord,
  InterruptRecord,
  NotificationRecord,
  NotificationStatus,
  PushSubscriptionRecord,
  RunRecord,
  UserAgentRecord,
  WebhookDeliveryRecord,
  WebhookSubscriptionRecord,
} from '../types.js';
import type {
  ChatEgressEnvelope,
  DeliveryLogRecord,
  MessagingConnectorRecord,
  MessagingIdentityRecord,
  MessagingPolicyRecord,
  MessagingAllowlistEntry,
  MessagingPairingRecord,
  MessagingRoutingRuleRecord,
  MessagingSessionRecord,
  MessagingTurnRecord,
  RelayDeviceRecord,
} from '../messaging/types.js';
import type { ReassignTenantResult } from './tenantMigration.js';
import type { IdempotentClaim } from '../host/idempotentResponse.js';
import type { WorkspaceFileRow } from '../host/workspaceStore.js';

/** One row of the append-only agent-attributed-run index (RFC 0086). */
export interface AgentRunAttributionRow {
  runId: string;
  tenantId: string;
  rosterId: string;
  agentId?: string;
  source: 'heartbeat' | 'schedule' | 'kanban' | 'approval';
  /** ISO-8601 run creation time. */
  createdAt: string;
}

/** ADR 0551 P1 — options for the run-insert write. */
export interface InsertRunOptions {
  /**
   * Append a dispatch-outbox row for this run **in the same atomic operation**
   * as the run insert (one sqlite write transaction / one Postgres
   * `BEGIN…COMMIT`). Either both rows land or neither does, so a caller that
   * has returned `201` can never be in the state "run exists, nothing will ever
   * start it".
   *
   * `nextAttemptAt` (epoch ms) is when the durable worker may first claim the
   * row. It is set slightly in the FUTURE on purpose — see
   * `DISPATCH_OUTBOX_HINT_GRACE_MS` in `host/runInsert.ts`. That delay is a
   * de-duplication window against the in-process wakeup hint, NOT the durability
   * mechanism; the row is.
   *
   * Omit for run inserts that are not accepted work with a start promise (a
   * `:fork` copy, a seam probe, a run whose definition is not catalog-
   * resolvable). Those keep their existing recovery story: the orphan sweeper.
   */
  dispatchOutbox?: { nextAttemptAt: number };
  /**
   * ADR 0549 H56 — commit the caller's HTTP idempotency claim as `completed`
   * **in the same atomic operation** as the run insert (and the outbox row, when
   * both are present). Either the run row AND the completed ledger row land, or
   * neither does.
   *
   * WHY. `POST /v1/runs` used to insert the run and then, ~40 lines later, call
   * `completeIdempotentResponse`. Two windows sat between them, and both minted
   * a SECOND run for one key: a holder that DIED (or was reclaimed) after the
   * insert left the ledger `pending`, so the retry reclaimed the key and created
   * again; and a THROW after the insert reached the `finally`, whose release
   * DELETED the pending row, so the retry won a fresh claim and created again.
   * With the commit inside the insert there is no instant at which a run exists
   * and the ledger does not say so — the same argument ADR 0551 P1 made for the
   * dispatch outbox, applied to the ledger. `releaseIdempotentResponse` in the
   * route's `finally` is then structurally harmless: the row is already
   * `completed`, and release refuses a completed row.
   *
   * The commit is the same compare-and-set as `completeIdempotentResponse`
   * (`claim_token` must still be THIS caller's). If the CAS matches no row —
   * the lease lapsed and another caller reclaimed the key while this request
   * ran — the adapter MUST roll the whole insert back and reject with
   * `IdempotentCommitRejectedError`: the reclaimer owns the key now, so this
   * holder's run must not exist. Returning `false` here (as `complete` does)
   * would leave the run row committed, which is exactly the duplicate this
   * option exists to make impossible.
   *
   * `responseBody` is the response the route WILL send; it is computable before
   * the insert because it needs only `run.runId` and the request host.
   */
  idempotencyCommit?: {
    tenantId: string;
    endpoint: string;
    key: string;
    claimToken: string;
    responseStatus: number;
    responseBody: string;
    updatedAt: string;
  };
}

/**
 * ADR 0549 H56 — thrown by `insertRun` when `idempotencyCommit`'s compare-and-set
 * matches no row (the claim was reclaimed while this holder ran). The insert has
 * been rolled back: no run row, no outbox row. The route maps this to the
 * protocol's in-flight 409 — the key IS in flight, under the reclaimer.
 */
export class IdempotentCommitRejectedError extends Error {
  readonly code = 'idempotency_commit_rejected' as const;
  constructor(public readonly key: string) {
    super('idempotency commit rejected: the claim token no longer matches (reclaimed) — run insert rolled back');
    this.name = 'IdempotentCommitRejectedError';
  }
}

/** See `deleteManagedUsageForTenant`. Built by `usageBucketMatchersForTenant`. */
export interface UsageLikeMatcher { pattern: string; escape: string }

/** ADR 0740 — the outcome of `Storage.claimRunExecution`. See that method. */
export type RunExecutionClaim = 'claimed' | 'held' | 'not-runnable' | 'missing';

/** ADR 0754 — the payload-key grammar `findFirstEventByPayload` accepts (an identifier, never a path or SQL). */
export const PAYLOAD_KEY_RE = /^[A-Za-z0-9_]+$/;

/** Statuses that are final: a run in one of these is never executed again. */
export const RUN_FINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/**
 * RFC 0215 §A (ADR 0752) — per-subscription delivery lanes. The dispatcher claims
 * with both set: at most ONE row per subscription per claim (its oldest due row),
 * and none for a subscription this instance already has an attempt outstanding
 * for. So one subscription's backlog, or its unanswered attempt, can never occupy
 * capacity another subscription needs. Omitted, the claim is the plain oldest-due
 * batch (the deterministic `processDueWebhookDeliveries` test lane).
 */
export interface WebhookClaimOptions {
  onePerSubscription?: boolean;
  excludeSubscriptionIds?: readonly string[];
  /** RFC 0215 §A.3 (ADR 0752 P2): skip rows of these tenants — the dispatcher
   *  passes the tenants already at their in-flight cap. Rows with no tenant
   *  (enqueued before the column existed) are never excluded. */
  excludeTenantIds?: readonly string[];
}

export interface Storage {
  // ── runs ──
  insertRun(run: RunRecord, opts?: InsertRunOptions): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
  updateRun(runId: string, patch: Partial<RunRecord>): Promise<void>;
  /** ATOMIC top-level-key merge into `run.metadata` (ADR 0476 correction,
   *  grade-code H2). `updateRun({metadata})` is a whole-column write, so every
   *  read-modify-write caller races concurrent metadata writers (the ADR 0024
   *  connectionUse incident class). This merges `patch`'s top-level keys in
   *  ONE statement (pg `jsonb ||` / sqlite `json_patch`) — concurrent writers
   *  of DISJOINT keys can no longer clobber each other. RFC 7396 semantics: a
   *  `null` value DELETES the key. `ifAbsentKey` makes the write conditional:
   *  applied only while `metadata` lacks that key (atomic never-overwrite for
   *  terminal stamps). No-op on a missing run. Returns TRUE iff the row was
   *  written (ADR 0482 C1 — the spend fold must consume the WRITTEN stamp,
   *  never the computed figure: a cancel×executor terminal race otherwise
   *  folds one run's spend twice into the budget counter). */
  mergeRunMetadata(runId: string, patch: Record<string, unknown>, opts?: { ifAbsentKey?: string }): Promise<boolean>;
  /** Newest first (`created_at DESC, run_id DESC` — the tie-break makes the order total, so a
   *  keyset cursor is exact). `before` (RFC 0182 `listRuns` pagination, ADR 0658) returns
   *  only runs strictly older than the given (createdAt, runId) pair — the last item of the
   *  previous page. */
  listRuns(filter: {
    tenantId?: string;
    workflowId?: string;
    status?: string;
    limit?: number;
    before?: { createdAt: string; runId: string };
  }): Promise<readonly RunRecord[]>;
  /** Child runs of a parent (snapshot `childRuns` + the cancel cascade) —
   *  served by the parent_run_id index so it never scans the tenant's runs
   *  (the O(tenant) listRuns+filter it replaced blew the 30s statement
   *  timeout at ~4k runs/tenant: the 2026-07-14 silent-board incident). */
  listRunsByParent(parentRunId: string): Promise<readonly RunRecord[]>;
  /** Per-tenant activity summary for tenants matching `tenantPrefix` that own
   *  at least one run (ADR 0372 — the anon-tenant lifecycle sweep's evidence).
   *  `lastHumanRunAt` is the newest run WITHOUT a `metadata.schedule` stamp —
   *  scheduler-fired runs must never make an abandoned tenant look active (the
   *  2026-07-15 misclassification lesson). All timestamps ISO or null. */
  listTenantActivity(tenantPrefix: string, limit: number): Promise<ReadonlyArray<{
    tenantId: string;
    firstRunAt: string | null;
    lastHumanRunAt: string | null;
    lastChatAt: string | null;
  }>>;
  /** ADR 0372 correction (grade-pass DATA-1): the run-anchored enumerator
   *  above never sees a tenant with ZERO runs — yet hostext-only tenants
   *  exist (e.g. Studio provisioning writes roster/profile rows on first
   *  touch), and they were permanently invisible to the anon sweep. This leg
   *  enumerates tenants matching `tenantPrefix` that own at least one
   *  host-extension row CARRYING a JSON `tenantId` (the same probe the purge
   *  fallback trusts), with the newest hostext write + newest chat touch as
   *  the abandonment evidence. Known limitations (stated, not hidden): a row
   *  whose value lacks a TOP-LEVEL `tenantId` doesn't anchor its tenant here —
   *  every provisioning-shaped store (roster, agent-profile) carries it; and
   *  ANY hostext write counts as activity with no human/machine distinction —
   *  a future background rewriter of tenant-carrying rows would immortalize
   *  anon tenants (the inverse of the scheduler-flood lesson the run leg
   *  encodes; nothing does this today — marker self-heals live in the
   *  non-anchoring `hostextidx:` keyspace). */
  listHostExtTenantActivity(tenantPrefix: string, limit: number): Promise<ReadonlyArray<{
    tenantId: string;
    lastHostExtAt: string;
    lastChatAt: string | null;
  }>>;
  /** ADR 0369 — cheap EXISTS probe: does ANY run (optionally with the given
   *  status) reference this workflow definition? Serves the delete guard
   *  (refuse while referenced — replay/`:fork` re-resolve by id) and the
   *  promote gate (requires a 'completed' review run). Index-backed; never
   *  a tenant scan. */
  hasRunForWorkflow(workflowId: string, filter?: { status?: RunRecord['status'] }): Promise<boolean>;
  /** ADR 0371 — the sweeper's feed: terminal runs whose removal_at has
   *  passed, oldest deadline first, index-backed. */
  listRunsPastRemoval(now: string, limit: number): Promise<readonly RunRecord[]>;
  /** ADR 0371 — un-stamp a run (sweep found it non-terminal, or a pin needs
   *  the deadline gone). Explicit method: exactOptionalPropertyTypes bans an
   *  `undefined` patch field, and `null` isn't in the record shape. */
  clearRunRemoval(runId: string): Promise<void>;
  /** Permanently remove a run + its events / interrupts / invocation-log
   *  rows (no FK cascade in this schema, so the delete is explicit).
   *  Returns true if a run row existed. Tenant authorization is enforced at
   *  the route, not here. */
  deleteRun(runId: string): Promise<boolean>;

  // ── run dispatch lease (multi-instance crash recovery) ──
  /**
   * Stamp the dispatch lease on a run: `dispatchOwner = owner`,
   * `dispatchLeaseExpiresAt = leaseExpiresAt` (epoch ms). Called by `executeRun`
   * at start. Pass `(null, null)` to clear. Best-effort — a missing run is a no-op.
   */
  setRunDispatchLease(runId: string, owner: string | null, leaseExpiresAt: number | null): Promise<void>;
  /**
   * ADR 0740 — ATOMICALLY claim the right to EXECUTE a run. The execution fence.
   *
   * `setRunDispatchLease` above is an unconditional stamp: two deliveries of one
   * accepted run (the `setImmediate` dispatch hint racing a `dispatch_outbox`
   * redelivery, or two instances) both stamp it and BOTH EXECUTE — measured as
   * one HTTP effect arriving twice and two `run.completed` on one run
   * (`WHD-12`). This is the conditional form, ONE statement, so exactly one
   * contender wins on sqlite and on Postgres alike:
   *
   *   claimed       the caller now owns the run; the lease is stamped.
   *   held          another execution holds a LIVE lease on a pending/running
   *                 run. A fresh dispatch that gets this is a DUPLICATE DELIVERY
   *                 and must not execute.
   *   not-runnable  the run is terminal (`completed`/`failed`/`cancelled`).
   *                 Re-executing finished work is never a legitimate delivery.
   *   missing       no such row. Nothing to contend over; callers proceed.
   *
   * ADMITTED when the run is not terminal AND any of: no owner yet; the lease is
   * absent or EXPIRED (crash recovery — the orphan lane's re-dispatch must keep
   * working); or the run is SUSPENDED (`paused`/`waiting-*`). That last arm is
   * load-bearing: nothing clears `dispatch_owner` at suspend, so a run waiting
   * days on an approval still carries its first executor's lease, and a resume
   * dispatched on any OTHER instance is legitimate by definition — the previous
   * execution RETURNED. A plain owner/expiry CAS would reject it, intermittently
   * and only in multi-instance deploys.
   */
  claimRunExecution(runId: string, owner: string, nowMs: number, leaseExpiresAt: number): Promise<RunExecutionClaim>;
  /**
   * RENEW the dispatch lease **only if `owner` still holds it** (ADR 0585 P0b).
   * Returns `true` when the row was updated, `false` when this instance is no
   * longer the owner (or the run is gone).
   *
   * ── WHY THIS IS NOT `setRunDispatchLease` ─────────────────────────────────
   *
   * `setRunDispatchLease` is an UNCONDITIONAL `UPDATE … WHERE run_id = ?`. As a
   * DISPATCH-TIME stamp that is correct — the caller is claiming the run. As a
   * RENEWAL it is a defect: an instance that was reclaimed while suspended
   * (Cloud Run `cpu-throttling` stops a detached run mid-flight) would, on its
   * next heartbeat, **take the run back from the legitimate new owner** and
   * extend the lease by a full `RUN_DISPATCH_LEASE_MS`. The sweeper would then
   * see a healthy lease and never re-reclaim, so the new owner is silently
   * disowned and the zombie's ownership is self-renewing.
   *
   * Unreachable today only because the lease (ceiling + 120s) outlives the
   * longest legal run, so a live run is never reclaimed. ADR 0585 P1 — which
   * shortens the lease — is exactly what would activate it.
   *
   * The `false` return is also the LIVENESS SIGNAL P0b is built on: it is how a
   * resumed instance learns it lost the run, at no extra read, on a write it
   * was making anyway.
   *
   * Compare-and-swap on an owner token is the same shape as `kvCompareAndSwap`
   * below; this is not a new concurrency primitive in this interface.
   */
  renewRunDispatchLeaseIfOwner(runId: string, owner: string, leaseExpiresAt: number): Promise<boolean>;
  /**
   * Atomically claim up to `limit` ORPHANED runs for `workerId`: rows with
   * `status IN ('pending','running')`, `createdAt < staleBeforeIso` (a grace
   * window so freshly-dispatched runs are never raced), and the dispatch lease
   * absent or expired (`dispatchLeaseExpiresAt IS NULL OR < nowMs`). Sets a fresh
   * lease (`dispatchOwner=workerId`, `dispatchLeaseExpiresAt=nowMs+leaseMs`) and
   * returns the claimed runs for re-dispatch. MUST be multi-instance-safe
   * (Postgres `FOR UPDATE SKIP LOCKED`; sqlite a single write transaction).
   */
  claimOrphanedRuns(
    workerId: string,
    nowMs: number,
    staleBeforeIso: string,
    leaseMs: number,
    limit: number,
  ): Promise<readonly RunRecord[]>;

  // ── ADR 0551 P1 — durable dispatch outbox ──
  //
  // The outbox answers a question the dispatch LEASE cannot: the lease records
  // who is running a run, so it only exists once something has started running
  // it. Between `insertRun` and the first `executeRun` await there was nothing
  // durable at all — a process death in that window left an accepted run
  // `pending` with no record that anyone ever intended to start it, recoverable
  // only by the orphan sweeper's 2-minute grace scan of ALL pending runs.
  //
  // The outbox is written WITH the run and claimed by a leased worker, so the
  // intent is durable from the moment the run is visible. The run-dispatch
  // lease above remains the EXECUTION fence — this queue never becomes a second
  // executor, it only decides when `executeRun` is invoked.
  /**
   * Atomically claim up to `limit` DUE outbox rows for `workerId`: rows with
   * `status='pending'`, `nextAttemptAt <= nowMs`, and the claim lease absent or
   * expired. Sets the lease (`claimedBy=workerId`, `claimExpiresAt=nowMs+leaseMs`)
   * and returns the claimed rows. MUST be multi-instance-safe — Postgres uses
   * `FOR UPDATE SKIP LOCKED`; sqlite a single write transaction.
   */
  claimDispatchOutbox(
    workerId: string,
    nowMs: number,
    leaseMs: number,
    limit: number,
  ): Promise<readonly DispatchOutboxRecord[]>;
  /** Read one row (or null). Exists for the worker's own re-check and for tests. */
  getDispatchOutbox(runId: string): Promise<DispatchOutboxRecord | null>;
  /**
   * Retire a dispatch intent that has been DISCHARGED — the worker observed the
   * run leave `pending`, or the run no longer exists.
   *
   * DELETES the row rather than marking it terminal, for the same reason
   * `releaseIdempotentResponse` does (ADR 0549): a queue whose completed rows
   * accumulate needs a retention sweep, and a retention sweep is one more thing
   * that can silently stop running. Deleting makes the table self-bounding.
   *
   * Idempotent — deleting an absent row is a no-op, so a duplicate delivery
   * cannot fail on the second retire.
   */
  completeDispatchOutbox(runId: string): Promise<void>;
  /**
   * Return a claimed row to the queue with `attempts + 1`, the lease cleared and
   * the caller-computed backoff `nextAttemptAt`. When `dead` is true the row
   * becomes terminal `dead` instead (attempts exhausted); it is deliberately NOT
   * deleted, so an operator surface can see intents that were never discharged.
   */
  rescheduleDispatchOutbox(
    runId: string,
    nextAttemptAt: number,
    dead: boolean,
    error: string,
  ): Promise<void>;

  // ── ADR 0551 P2 — operator visibility + redrive ──
  /**
   * Whole-queue aggregates: pending depth, dead depth, and the creation time of
   * the oldest pending row. Computed by the adapter (COUNT/MIN) rather than by
   * counting a capped listing, because a capped count under-reports precisely
   * when the queue is deep enough to matter.
   */
  dispatchOutboxStats(): Promise<DispatchOutboxStats>;
  /** Newest-first page of rows in one state, for the operator projection. */
  listDispatchOutbox(filter: { status: DispatchOutboxRecord['status']; limit: number }): Promise<readonly DispatchOutboxRecord[]>;
  /**
   * REDRIVE a `dead` row back to `pending` with a fresh attempts budget.
   *
   * A COMPARE-AND-SET, not a state-machine check: the `WHERE ... AND status =
   * 'dead'` predicate is evaluated by the same statement that writes, so two
   * concurrent redrives of one row produce exactly ONE re-queue. A read-then-
   * write would let both callers observe `dead` and both write `pending`,
   * which is the "state machine is not a CAS" failure that has already produced
   * a duplicated refund in this codebase.
   *
   * Returns `true` when THIS call performed the transition, `false` when the row
   * is absent or was not `dead` (already redriven by a peer, or never dead).
   * `reason` is recorded on the row as `last_error` so the queue itself carries
   * why it was re-queued; the audit chain carries who did it.
   */
  redriveDispatchOutbox(runId: string, nextAttemptAt: number, reason: string): Promise<boolean>;

  // ── annotations (RFC 0056 — per-run side-store, NOT the event log) ──
  insertAnnotation(record: AnnotationRecord): Promise<void>;
  listAnnotations(runId: string): Promise<readonly AnnotationRecord[]>;

  // ── events ──
  /** Atomic append: assigns next sequence per (runId), returns sequence. */
  appendEvent(input: Omit<EventRecord, 'sequence'>): Promise<EventRecord>;
  /**
   * Bulk append for INITIAL LOADS (the demo seed) — one round-trip instead of N.
   * Assigns the same monotonic per-(runId) `sequence` as `appendEvent` (continuing
   * from each run's current max, in array order) and preserves the per-run
   * serialization, so the result is byte-identical to N `appendEvent` calls. Use
   * for bulk-loading; the hot path stays on `appendEvent`.
   */
  appendEventsBatch(inputs: readonly Omit<EventRecord, 'sequence'>[]): Promise<EventRecord[]>;
  /**
   * THE SEAT (`spec/v2/core/persistence.md` §"The seat"). The one event-list
   * method, and therefore where the era adapter sits: an era-`2` log (a run
   * created before this host's v2 cut) is translated through
   * `schemas/v2/event-codemap.json` for a major-2 reader, and an era-`3` log is
   * mapped back to its v1 spelling for the v1 wire. `sequence` is preserved
   * verbatim, INCLUDING `0`; the cursor stays exclusive (`sequence > fromSeq`).
   *
   * `contract` names the protocol major the caller is serving. Omit it: the
   * adapter reads the current request's negotiated major from its async context,
   * so no route has to remember. Pass it ONLY where the read escapes the
   * request's context — the SSE gap fetch, scheduled from the appender.
   */
  listEvents(runId: string, opts?: { fromSeq?: number; limit?: number; contract?: 1 | 2 }): Promise<readonly EventRecord[]>;
  /**
   * ADR 0754 — the FIRST event of `type` in `runId`'s log whose top-level
   * `payload[payloadKey]` equals `payloadValue`, found by the DATABASE in one
   * round-trip over the existing `(run_id, sequence)` index — never by paging the
   * log into the process (`getArtifact` used to page up to 100 × 500 events and
   * silently 404 past 50k). `payloadKey` is an identifier (`^[A-Za-z0-9_]+$`);
   * `type` is the caller's (v1) vocabulary, translated to the stored era by the
   * event-era wrapper exactly as `appendEvent` translates it.
   */
  findFirstEventByPayload(runId: string, type: string, payloadKey: string, payloadValue: string): Promise<EventRecord | null>;
  /** The highest sequence in the run's log, or **-1 when the log is empty** —
   *  the first event is 0 (RFC 0171 §A.3), so 0 is a real sequence and cannot
   *  double as the empty sentinel. */
  getMaxSequence(runId: string): Promise<number>;

  // ── interrupts ──
  insertInterrupt(record: InterruptRecord): Promise<void>;
  getInterrupt(interruptId: string): Promise<InterruptRecord | null>;
  getInterruptByToken(token: string): Promise<InterruptRecord | null>;
  getInterruptByNode(runId: string, nodeId: string): Promise<InterruptRecord | null>;
  /** Resolve an interrupt — CONDITIONAL on it still being open (resolved_at
   *  IS NULL). Returns true iff THIS call won the resolve (changed a row), so a
   *  concurrent lazy-timeout + periodic-sweep (or two votes) can't both emit
   *  `interrupt.resolved`/`run.failed` (ENG-6). An already-resolved interrupt
   *  returns false and is left untouched. */
  resolveInterrupt(interruptId: string, resolvedValue: unknown, resolvedAt: string): Promise<boolean>;
  listOpenInterrupts(runId: string): Promise<readonly InterruptRecord[]>;
  /** All UNRESOLVED interrupts across runs (oldest first, up to `limit`).
   *  Backs the RFC 0093 §D approval-gate timeout sweep
   *  (`executor/approvalGateTimeout.ts`). */
  listOpenInterruptsAll(limit: number): Promise<readonly InterruptRecord[]>;

  // ── webhooks ──
  insertWebhook(record: WebhookSubscriptionRecord): Promise<void>;
  getWebhook(subscriptionId: string): Promise<WebhookSubscriptionRecord | null>;
  /**
   * RFC 0201 §E / ADR 0747 — rotate an opted-in subscription's secret in ONE
   * statement: the current secret becomes `previousSecret`, `secret` becomes
   * the new (already-sealed) value. Doing it in SQL rather than read-modify-
   * write is what makes a second rotation inside an overlap retire the OLDEST
   * secret even when two rotations race: each UPDATE reads the row it writes.
   * Returns false when no row matched.
   */
  rotateWebhookSecret(
    subscriptionId: string,
    rotation: { secret: string; rotatedAt: number; previousSecretExpiresAt: number },
  ): Promise<boolean>;
  /**
   * `/grade-data` 2026-09-26 (WHROT-1) — NULL the at-rest `previous_secret` of every
   * subscription whose rotation overlap ended at or before `now`. Past that instant
   * the worker already refuses to sign with it (RFC 0201 §E.20); without this the
   * retired secret stayed in the row until the NEXT rotation or the row's delete,
   * i.e. indefinitely for a subscription rotated once. `rotated_at` and
   * `previous_secret_expires_at` are kept (rotation history, not key material).
   * Returns the number of rows cleared.
   */
  retireExpiredWebhookSecrets(now: number): Promise<number>;
  /**
   * WHROT-3 backfill — blank the enqueue-time `secret` copy on up to `limit`
   * terminal (`delivered`/`dead`) delivery rows still holding one: the rows
   * written before `markWebhookDeliveryDelivered` / the dead transition started
   * blanking. Bounded per call so a large backlog never becomes one long
   * statement; returns the rows changed (0 once the backlog is gone).
   */
  blankTerminalDeliverySecrets(limit: number): Promise<number>;
  /** Delete a subscription AND its `pending` deliveries, atomically (WHD-16):
   *  unregistering stops delivery. Delivered/dead rows are kept. */
  deleteWebhook(subscriptionId: string): Promise<void>;
  /** `tenantId` filter is exact-match on the owning tenant (RFC 0093 §A.3) —
   *  the delivery fanout and the tenant-scoped list/seam surfaces pass it so
   *  cross-tenant subscriptions never match. */
  listWebhooks(filter: { eventType?: string; tags?: readonly string[]; tenantId?: string }): Promise<readonly WebhookSubscriptionRecord[]>;

  // ── webhook deliveries (durable retry queue) ──
  /** Enqueue a delivery for the background worker (`webhookWorker.ts`) to attempt.
   *
   *  `requireSubscription` (RFC 0215 §B, ADR 0752): insert ONLY if the subscription
   *  still exists, atomically with respect to `deleteWebhook`. The fan-out reads
   *  `listWebhooks` and enqueues afterwards; without this an event racing an
   *  unregister inserts a fresh row AFTER the 204 and the worker attempts it.
   *  Returns false when the row was not inserted. Callers that enqueue for a
   *  subscription they do not persist (tests, the replay suppression lane) omit it. */
  enqueueWebhookDelivery(record: WebhookDeliveryRecord, opts?: { requireSubscription?: boolean }): Promise<boolean>;
  /**
   * Atomically claim up to `limit` *due* deliveries for `workerId`: rows with
   * `status='pending'`, `nextAttemptAt <= now`, and the claim lease absent or
   * expired. Sets the lease (`claimedBy=workerId`, `claimExpiresAt=now+leaseMs`)
   * and returns the claimed rows. MUST be multi-instance-safe — Postgres uses
   * `FOR UPDATE SKIP LOCKED`; sqlite a single write transaction.
   */
  claimDueWebhookDeliveries(
    workerId: string,
    now: number,
    leaseMs: number,
    limit: number,
    opts?: WebhookClaimOptions,
  ): Promise<readonly WebhookDeliveryRecord[]>;
  /** Mark a claimed delivery `delivered` (terminal). */
  /** Also blanks the row's enqueue-time `secret` copy (WHROT-2): since ADR 0747
   *  nothing on this revision reads it (the worker signs from the SUBSCRIPTION at
   *  send time, retries included), so keeping it only kept a possibly retired
   *  secret at rest for the delivery-retention window — unbounded by default
   *  (`OPENWOP_WEBHOOK_DELIVERY_RETENTION_DAYS` is opt-in). A row reaching `dead`
   *  is blanked the same way (WHROT-3, in `rescheduleWebhookDelivery`); only
   *  `pending` rows keep the copy, for a rollback to a pre-0747 revision. */
  markWebhookDeliveryDelivered(deliveryId: string, now: number): Promise<void>;
  /**
   * Reschedule a failed delivery: increment `attempts`, record `error`, clear the
   * lease. When `dead` is true the row becomes terminal `dead`; otherwise it
   * returns to `pending` with the caller-computed backoff `nextAttemptAt`.
   * A row already `delivered` is left alone (`/grade-data` 2026-09-26): a worker
   * whose lease lapsed mid-send must not re-arm a row a peer delivered — that
   * was a duplicate send, and would re-arm a row whose secret copy is blanked.
   */
  rescheduleWebhookDelivery(
    deliveryId: string,
    now: number,
    nextAttemptAt: number,
    dead: boolean,
    error: string,
  ): Promise<void>;
  /**
   * ADR 0395 (operator webhook-health panel) — READ over the existing queue:
   * deliveries for a set of subscriptions (server-side fan-in; the panel never
   * N+1s), optionally filtered by status, newest schedule first. A read, not a
   * new store.
   */
  listWebhookDeliveries(filter: {
    subscriptionIds?: readonly string[];
    status?: WebhookDeliveryRecord['status'];
    limit?: number;
  }): Promise<readonly WebhookDeliveryRecord[]>;
  /**
   * ADR 0395 — operator MANUAL RETRY: reset a `dead` (or stuck `pending`) row
   * back to a due `pending` with a fresh attempt budget and no lease. Returns
   * false when the delivery does not exist or is already `delivered`. Rides
   * the existing worker; no new sender.
   */
  retryWebhookDelivery(deliveryId: string, now: number): Promise<boolean>;

  // ── fire-once mutex (host-generated keys ONLY) ──
  /**
   * Atomically: if `key` is unknown, insert a `__pending__` placeholder and
   * return `{ claimed: true, existing: null }`. If `key` is already present,
   * return `{ claimed: false, existing: <the record> }`.
   *
   * Concurrent callers see exactly one `claimed: true`; the rest get the
   * existing record (which may itself be `__pending__` if the holder is
   * still building the response — caller MUST handle that case).
   *
   * ADR 0549 — **this is the daemons' distributed fire-once mutex, and NOTHING
   * ELSE.** It was previously named `claimIdempotency` and doubled as the HTTP
   * `Idempotency-Key` cache. That sharing was a critical defect: caller-supplied
   * keys landed in the same keyspace as machine-generated ones, so a request
   * carrying `Idempotency-Key: schedule-fire:<jobId>:<slot>` could win the
   * scheduler's claim and suppress the job. **Every key passed here MUST be
   * host-generated.** A caller-supplied value reaching this method is a security
   * bug, and `test/idempotency-lane-tripwire.test.ts` fails the build if a route
   * module calls it.
   *
   * Note the deliberate asymmetry with the HTTP lane: a claim here is NEVER
   * released on failure. Releasing would let a second instance re-fire work the
   * first instance may have partially performed; one skipped tick is the cheaper
   * error. The HTTP lane needs the opposite (release so the caller can retry),
   * which is precisely why the two cannot share an implementation.
   */
  claimOnce(key: string, createdAt: string): Promise<{ claimed: boolean; existing: IdempotencyRecord | null }>;
  /** Insert-or-replace a mutex marker (used to upgrade `__pending__` → a completion marker). */
  putOnce(record: IdempotencyRecord): Promise<void>;
  /**
   * Delete mutex rows whose key starts with `keyPrefix` and whose `createdAt`
   * is older than `olderThanIso`. Returns the number deleted.
   *
   * The daemons' keys are only needed for the brief concurrent-poll window, so
   * each daemon prunes its own prefix every tick to keep the table bounded.
   */
  pruneOnceByPrefix(keyPrefix: string, olderThanIso: string): Promise<number>;

  // ── RFC 0059 agent workspace (ADR 0551 — durable) ──
  /**
   * Read one workspace file, or null when absent FOR THIS OWNER.
   *
   * The owner triple is part of the key, so a miss for {T,W} can never surface
   * a file owned by {T2,W2} — the WCT-1 protocol-tier SECURITY invariant holds
   * structurally rather than by filtering after the read.
   */
  getWorkspaceFile(tenantId: string, workspaceId: string, path: string): Promise<WorkspaceFileRow | null>;
  /** List metadata (no bodies) for this owner, optionally prefix-filtered. */
  listWorkspaceFiles(tenantId: string, workspaceId: string, prefix?: string): Promise<Omit<WorkspaceFileRow, 'content'>[]>;
  /**
   * Atomic create/replace with optimistic concurrency.
   *
   * `ifMatch` is compared against the CURRENT row inside the same transaction
   * (sqlite) or a single conditional statement (postgres), so the check and the
   * write cannot straddle another writer. That is the whole point of moving off
   * the module Map: the previous CAS was instance-local, so two Cloud Run
   * instances could each believe they had won the same compare-and-set.
   *
   * Returns null when `ifMatch` does not match, with the current version so the
   * route can render `workspace_conflict`.
   */
  putWorkspaceFile(input: {
    tenantId: string;
    workspaceId: string;
    path: string;
    content: string;
    contentType: string;
    etagFor: (version: number, content: string) => string;
    ifMatch?: string;
    updatedAt: string;
  }): Promise<{ ok: true; row: WorkspaceFileRow } | { ok: false; currentVersion: number }>;
  /** Delete a file; true when one existed (so the route can 404). */
  deleteWorkspaceFile(tenantId: string, workspaceId: string, path: string): Promise<boolean>;

  // ── HTTP idempotency ledger (caller-supplied keys) ──
  /**
   * ADR 0549 — atomically claim `(tenantId, endpoint, key)` for a request whose
   * body digests to `requestDigest`.
   *
   * The tenant component is what makes this tenant-safe, and it MUST be the
   * tenant the request was AUTHORIZED under (post-`forbidden_tenant` check),
   * never a value read straight off the request. The endpoint component keeps
   * two routes from colliding on one key.
   *
   * Storage decides the outcome inside the same transaction as the claim, so
   * the route cannot introduce a check-then-act race between "is there a row"
   * and "what does it say".
   */
  claimIdempotentResponse(input: {
    tenantId: string;
    endpoint: string;
    key: string;
    requestDigest: string;
    createdAt: string;
    /**
     * ADR 0549 P1 — how long this claim is held before another caller may
     * reclaim it. Pass `idempotencyLeaseMs()`; do NOT hand-pick a value. A
     * lease shorter than the request timeout lets a merely-SLOW holder be
     * reclaimed, and then both it and the reclaimer create work — the exact
     * duplicate the ledger exists to prevent.
     */
    leaseMs: number;
  }): Promise<IdempotentClaim>;
  /**
   * Commit the final response for a claim this caller won. Never overwrites a
   * row that is already `completed`.
   */
  completeIdempotentResponse(input: {
    tenantId: string;
    endpoint: string;
    key: string;
    responseStatus: number;
    responseBody: string;
    runId?: string | null;
    updatedAt: string;
    /**
     * ADR 0549 P1 — compare-and-set. The write applies only if the row still
     * carries THIS token, so a holder whose lease expired and was reclaimed
     * cannot overwrite the response the reclaimer already committed.
     */
    claimToken: string;
  }): Promise<boolean>;
  /**
   * ADR 0549 P1 — give up a claim this caller holds, so the key is immediately
   * retryable instead of being 409-locked until the lease expires.
   *
   * DELETES the row rather than marking it `released`: the retry path then
   * becomes byte-identical to a first attempt, with no second "revive a
   * released row" code path to get wrong. Losing the digest is correct — the
   * attempt FAILED, so there is no response for a differing body to be
   * inconsistent with.
   *
   * A no-op when the row is already `completed`. That is what makes the
   * caller's `finally` safe without it having to reason about which errors
   * count as pre-commit: the state machine closes the window, not the handler.
   */
  releaseIdempotentResponse(input: {
    tenantId: string;
    endpoint: string;
    key: string;
    claimToken: string;
  }): Promise<void>;
  /**
   * Delete ledger rows created before `olderThanIso`. Returns the number
   * deleted. Driven by the ADR 0380 size-hygiene tick on the same TTL the
   * mutex table uses.
   *
   * This exists because splitting the lanes also split their retention: the
   * `pruneOnceByPrefix('')` sweep that used to be the HTTP cache's only
   * cleaner no longer reaches these rows. A cache without expiry is a defect,
   * not a policy choice.
   */
  pruneIdempotentResponses(olderThanIso: string): Promise<number>;

  // ── audit log ──
  /** Total audit rows — the RUNDATA-3 growth gauge (audit_log is unbounded
   *  BY DESIGN: security events persist past deletion; measure before deciding
   *  any retention for it). Emitted hourly by the retention sweep tick. */
  countAuditRows(): Promise<number>;
  appendAudit(input: {
    timestamp: string;
    principalId?: string;
    action: string;
    resource?: string;
    outcome?: string;
    payload?: unknown;
  }): Promise<void>;

  /** Read-side of the audit log (ADR 0028 — the governance audit VIEW
   *  composes over this; no second audit store exists). Newest first.
   *  `beforeIso` is an INCLUSIVE upper bound (timestamp <= beforeIso) — the
   *  paging cursor for reads past the per-call limit clamp; same-timestamp
   *  boundary rows repeat across pages, so pagers dedupe by auditId.
   *  `resource` is an EXACT-match pushdown (indexed: idx_audit_resource_ts) —
   *  a per-subject consumer MUST use it instead of newest-N-then-filter,
   *  which truncates the subject's history behind unrelated rows (the
   *  twin-recall reader shipped that shape and showed "never recalled" over
   *  real recalls once 500 other rows landed). */
  listAudit(filter?: { actionPrefix?: string; resource?: string; sinceIso?: string; beforeIso?: string; limit?: number }): Promise<
    Array<{
      auditId: string;
      timestamp: string;
      principalId?: string;
      action: string;
      resource?: string;
      outcome?: string;
      payload?: unknown;
    }>
  >;

  // ── invocation log (engine-side idempotency, `spec/v1/idempotency.md` Layer 2) ──
  /**
   * ADR 0549 P3 — keyed on the RFC 0150 §B **logical effect identity**
   * (`host/effectIdentity.ts`), which already folds in tenant, run, node,
   * logical-invocation ordinal and provider key.
   *
   * `attempt` is NOT part of the identity — §B retired the `attempt`-bearing
   * composition as a safety-fix. It is retained as a COLUMN because the spec
   * keeps it as telemetry and because ADR 0326 P3a's replay/fork fidelity needs
   * the per-attempt outcome sequence: a replay must reproduce "failed at
   * attempt 1, succeeded at attempt 2" rather than compressing it.
   *
   * So there are two reads, and the difference is the point:
   *   - `getInvocation` — EXACT `(identity, attempt)`. The replay/fork path.
   *   - `getLatestInvocation` — the newest outcome recorded for the identity,
   *     whatever attempt produced it. The LIVE path, and the read that is
   *     retry-stable.
   *
   * `runId`/`nodeId` ride along because they are the table's cascade-delete and
   * index columns, not because the identity needs them.
   */
  getInvocation(key: { runId: string; nodeId: string; attempt: number; invocationId: string }): Promise<unknown | null>;
  /** Retry-stable read — the newest recorded outcome for this logical effect. */
  getLatestInvocation(key: { runId: string; nodeId: string; invocationId: string }): Promise<unknown | null>;
  putInvocation(key: { runId: string; nodeId: string; attempt: number; invocationId: string }, result: unknown): Promise<void>;

  /**
   * ADR 0618 — the ATOMIC CLAIM the Layer-2 effect guard must be.
   *
   * `spec/v1/idempotency.md` §"Concurrent duplicates (Layer 2)" (Stable v1.7):
   *
   * > *the persist that guards the effect **MUST** be an atomic claim: exactly
   * > one executor wins the compare-and-set / insert-if-absent and fires, and
   * > the other observes the hit … A non-atomic read-then-write does **NOT**
   * > satisfy the exactly-once guarantee under concurrent delivery.*
   *
   * WHY THE MEMO CANNOT BE THE CLAIM. `putInvocation` is `INSERT OR REPLACE`
   * keyed `(run, node, attempt, providerKey)`. It always wins — so it can never
   * report a conflict, which is the one thing a claim exists to do — and its key
   * carries `attempt`, so two ATTEMPTS at one identity would each mint a row.
   * The claim is keyed on the RETRY-STABLE identity, without `attempt`, which is
   * the identity §B made retry-stable in the first place.
   *
   * TAKEOVER, and why it is not optional. A pure insert-if-absent converts a
   * duplicate into a LOST effect when the winner dies between claiming and
   * firing: the row is present, no result is ever written, and every later
   * executor declines forever. Layer 1 already answers this — v1.5 defines
   * "atomic reclaim of an expired pending owner" — so Layer 2 takes the same
   * shape: a claim older than `staleAfterMs` with NO recorded result may be
   * taken over, atomically, by exactly one contender.
   *
   * Returns `true` iff THIS caller now holds the claim and must fire.
   */
  claimInvocation(
    key: { runId: string; nodeId: string; invocationId: string },
    opts: { nowMs: number; staleAfterMs: number },
  ): Promise<boolean>;

  /** Release a claim whose effect did NOT fire, so a contender is not made to
   *  wait out `staleAfterMs` for a failure the holder already knows about.
   *  Best-effort: a crash simply falls back to the takeover path. */
  releaseInvocationClaim(key: { runId: string; nodeId: string; invocationId: string }): Promise<void>;

  /**
   * ADR 0591 — the durable effect ESCAPE ledger. A SEPARATE concern from the
   * invocation log above, and the separation is load-bearing.
   *
   * `putInvocation` MEMOIZES a result: one row per identity, overwritten, which
   * is right for dedup/replay. This APPENDS a fact: the effect for this
   * identity left the host, again. A second escape is a new row, never an
   * overwrite — that is the entire point, because counting the memo table
   * cannot distinguish "dedup suppressed the second fire" from "it fired twice
   * and the write overwrote the evidence" (measured; sqlite mig 42).
   *
   * THE CALLER DOES NOT NAME THE ROW, and that is a correctness requirement
   * rather than an ergonomic one. An earlier draft took an `escapeSeq` from the
   * caller and keyed on it. Every sequence a caller can produce is
   * process-local, so it restarts at 0 in the process that resumes after the
   * kill §C.7 is built around — and the resumed append then collides with the
   * pre-kill row for that identity (measured: `UNIQUE constraint failed`, count
   * frozen at 1). The row id is generated by the store, so an append is
   * incapable of addressing an existing row.
   */
  appendEffectEscape(entry: {
    runId: string;
    nodeId: string;
    invocationId: string;
    effectKind: string;
    createdAt: string;
  }): Promise<void>;
  /**
   * Per-identity escape counts for a run — the RFC 0158 §C.7 read.
   *
   * Returns a count PER `invocationId`, never a per-run scalar: §C.7:162 asserts
   * "per effect identity, not by end state", and an aggregate equals the
   * per-identity count only when the graph happens to hold one identity.
   *
   * The count is a FLOOR on escapes, not an exact tally — the row is written
   * when the escape is recorded, so an effect that escapes and then crashes
   * before the write is uncounted. Safe direction for a double-fire assertion:
   * it can miss a fire, never invent one, so a count ≥ 2 is always real.
   */
  listEffectEscapes(runId: string): Promise<Array<{ invocationId: string; nodeId: string; count: number }>>;

  /**
   * RFC 0173 §C.2 — the Layer-2 attempt rows for one run, for the
   * `GET /runs/{runId}/effects` projection.
   *
   * Reads the INVOCATION LOG rather than the escape ledger. Only these rows
   * carry `attempt`, which the projection schema REQUIRES (`minimum: 1`); the
   * claim and escape tables key on `invocation_id` and have no attempt column,
   * so a row sourced from them could not be represented without inventing the
   * one field that makes an attempt identifiable. Projecting escapes alone was
   * considered and rejected: a correctly-suppressed effect writes no escape, so
   * such a projection reads EMPTY on both a source run and its replay fork and
   * `v2-effect-seam-no-refire` would pass while witnessing nothing.
   */
  listRunEffects(runId: string): Promise<Array<{
    nodeId: string;
    attempt: number;
    /** The RFC 0150 §B logical invocation id. NOT `providerKey`: migration 39
     *  RENAMED that column to `invocation_id` — reading the initial CREATE TABLE
     *  and not the migrations is how the first draft of this query shipped a
     *  statement against a column that had not existed for months. */
    invocationId: string;
    completed: boolean;
    at: string;
  }>>;

  // ── BYOK secrets (encrypted at rest) ──
  /** Persist an encrypted secret record. Caller MUST encrypt before calling. */
  upsertEncryptedSecret(credentialRef: string, encryptedRecordJson: string, now: string): Promise<void>;
  /** Read back the encrypted record (caller decrypts). Returns null if absent. */
  getEncryptedSecret(credentialRef: string): Promise<string | null>;
  /** Remove a secret entirely. */
  deleteSecret(credentialRef: string): Promise<void>;
  /** List all stored credentialRefs (NEVER values). */
  listSecretRefs(): Promise<readonly string[]>;

  // ── Tenant-scoped BYOK secrets (KMS-encrypted, signed-in users) ──
  /** Persist a tenant-scoped encrypted secret. Caller MUST encrypt before calling. */
  upsertTenantSecret(tenantId: string, credentialRef: string, encryptedRecordJson: string, now: string): Promise<void>;
  /** Read back a tenant-scoped encrypted record. Returns null if absent. */
  getTenantSecret(tenantId: string, credentialRef: string): Promise<string | null>;
  /** Remove a tenant-scoped secret. */
  deleteTenantSecret(tenantId: string, credentialRef: string): Promise<void>;
  /** List a tenant's credentialRefs (NEVER values). */
  listTenantSecretRefs(tenantId: string): Promise<readonly string[]>;
  /** Remove every secret owned by a tenant. Used for account deletion. */
  deleteAllTenantSecrets(tenantId: string): Promise<number>;

  // ── engine-table retention (ADR 0287) ──
  /**
   * Prune TERMINAL runs (`succeeded|failed|canceled|cancelled|completed`) whose
   * `updated_at` is older than `cutoffIso`, WITH all their children (events,
   * interrupts, invocation_log, envelope_correlations, annotations,
   * agent_run_activity) in one transaction. WHOLE-run pruning only — thinning
   * events under a kept run would be replay-dishonest. Batched by `limit` runs
   * per call so a sweep tick stays bounded; call again to continue. Operator
   * opt-in: the daemon gates on `OPENWOP_RUN_RETENTION_DAYS` (unset/0 = never).
   */
  pruneTerminalRuns(cutoffIso: string, limit: number): Promise<{ runs: number; childRows: number }>;
  /** Prune webhook deliveries in a TERMINAL status (`delivered`/`dead`) whose
   *  `updated_at` (epoch ms) is older than `cutoffMs`. Pending/retrying rows are
   *  never touched. Returns rows deleted. */
  pruneWebhookDeliveries(cutoffMs: number): Promise<number>;

  // ── tenant hard delete (account deletion) ──
  /**
   * Hard-delete every row owned by `tenantId`. Returns per-table row
   * counts. Used by the account-deletion flow (P3.6.5).
   *
   * ADR 0284 correction note: the original contract hand-listed five tables,
   * which silently orphaned every OTHER tenant-keyed table (chat, user_agents,
   * webhooks, messaging, usage meters). Coverage is now BY INTROSPECTION — the
   * same doctrine as `reassignTenant`: every table with a `tenant_id` column,
   * plus explicit child cascades for the run-/session-/subscription-keyed
   * tables that carry no tenant column (events, interrupts, idempotency,
   * invocation_log, envelope_correlations, chat_messages, webhook_deliveries).
   * The named counts below are kept for callers/audit; everything else sums
   * into `otherRows`. `run_budget` (windowed rate counters keyed by opaque
   * bucket) is accepted residue — entries expire with their window.
   *
   * Note: this does NOT touch the audit log — security-relevant events
   * persist past account deletion by design (audit_log has no tenant column,
   * so introspection excludes it naturally).
   */
  deleteAllTenantData(tenantId: string): Promise<{
    runs: number;
    events: number;
    interrupts: number;
    workflows: number;
    secrets: number;
    notifications: number;
    pushSubscriptions: number;
    /** Rows deleted from introspected tables beyond the named ones + child cascades. */
    otherRows: number;
    /** How many tenant-keyed tables the introspection covered this run. */
    tablesCovered: number;
  }>;

  // ── tenant reassignment (anon → user migration) ──
  /**
   * Reassign every row owned by `fromTenant` to `toTenant`. Used when
   * an anonymous visitor signs up — their `anon:<sid>` work becomes
   * persistent under their new `user:<sha>` tenant id. Returns per-
   * table row counts so the caller can attribute audit entries.
   *
   * Idempotent: re-calling with no remaining rows returns zeros. Does
   * NOT touch BYOK secrets (handled out-of-band by the resolver —
   * anon secrets are ephemeral-only). Events/interrupts move implicitly
   * via their `run_id` foreign key (their rows carry no `tenant_id`).
   *
   * Covers every tenant-scoped store the source can hold in ONE transaction
   * (ADR 0003 Phase 4c): every SQL table with a `tenant_id` column (discovered
   * by schema introspection — complete by construction) PLUS host-extension
   * content rows inside `host_ext_kv` (a read-modify-write re-keying any JSON
   * `tenantId`/`orgId === from`). The access-control scaffolding (the personal-
   * workspace org + deterministic owner member, whose ROW KEYS encode the
   * tenant) is intentionally excluded — the destination re-seeds it. See
   * `tenantMigration.ts`. The four named counts are retained for callers + the
   * audit log; `tables` is the full per-table breakdown, `hostExt` the KV rows.
   */
  reassignTenant(fromTenant: string, toTenant: string): Promise<ReassignTenantResult>;

  // ── managed-provider per-day usage ──
  /**
   * Increment a tenant's token usage for a managed (server-held-key)
   * provider on a given UTC date. Upserts; first call for a (tenant,
   * date, provider) inserts a row with the supplied counts.
   *
   * Used by `src/providers/managedProvider.ts` to enforce per-user
   * daily caps against the operator's shared MiniMax (etc.) key.
   */
  incrementManagedUsage(
    tenantId: string,
    providerId: string,
    dateUtc: string,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void>;
  /** Read a tenant's accumulated tokens for a managed provider on a UTC date.
   *  Returns `{ inputTokens: 0, outputTokens: 0 }` when no row exists. */
  getManagedUsage(
    tenantId: string,
    providerId: string,
    dateUtc: string,
  ): Promise<{ inputTokens: number; outputTokens: number }>;
  /**
   * An additional SQL `LIKE` match for usage rows a tenant OWNS but is not keyed
   * by — its participants' per-subject buckets (ADR 0693 / ADR 0697 follow-up).
   *
   * Passed in rather than built here on purpose: `providers/managedUsageScope.ts`
   * is the ONE place ADR 0693 §2 allows a bucket key to be composed, and storage
   * must not become a second composer. Storage receives a pattern it does not
   * interpret.
   *
   * `escape` is mandatory rather than defaulted so an adapter cannot quietly run
   * the pattern unescaped — on a DELETE, a `%` reaching the planner as a wildcard
   * is the difference between one tenant and all of them.
   */
  /** Remove EVERY managed-usage row for `tenantId`, across dates and providers.
   *  Returns how many rows went.
   *
   *  ADR 0693 §4 — exists for subject ERASURE. Once the free tier meters a
   *  per-subject bucket, those rows are subject-linked personal data and a DSAR
   *  must be able to remove them; the rest of this surface can only ADD to a
   *  row. Takes a bucket id (a real tenant or a `managed:` bucket) because the
   *  caller composing the key is the one that knows which. NOT a normative
   *  protocol surface. */
  deleteManagedUsageForTenant(tenantId: string, alsoLike?: UsageLikeMatcher): Promise<number>;
  /** Remove EVERY media-usage row for `tenantId`, across dates. Returns how
   *  many rows went.
   *
   *  ADR 0693 §4 + phase 3 — the media twin of `deleteManagedUsageForTenant`.
   *  Once TTS/STT meter a per-subject bucket those rows are subject-linked
   *  personal data too, and erasing only the token buckets would leave half a
   *  DSAR done — which is the same "regression, not a partial success" the ADR
   *  refuses for the token half. NOT a normative protocol surface. */
  deleteMediaUsageForTenant(tenantId: string, alsoLike?: UsageLikeMatcher): Promise<number>;

  // ── media-generation usage (ADR 0106 — per-org cost governance) ──
  /** Accumulate a tenant's media-generation usage for a UTC date — `ttsChars`
   *  (text-to-speech characters) and `sttBytes` (speech-to-text decoded input
   *  bytes). Tenant = workspace = org at root (ADR 0015). Upserts (adds). */
  incrementMediaUsage(
    tenantId: string,
    dateUtc: string,
    ttsChars: number,
    sttBytes: number,
  ): Promise<void>;
  /** Read a tenant's accumulated media usage on a UTC date.
   *  Returns `{ ttsChars: 0, sttBytes: 0 }` when no row exists. */
  getMediaUsage(
    tenantId: string,
    dateUtc: string,
  ): Promise<{ ttsChars: number; sttBytes: number }>;

  // ── BYOK chat token usage (ADR 0173 — per-org LLM spend governance) ──
  /** Increment a tenant's BYOK LLM chat token usage for a given provider on a UTC
   *  date. Upserts (adds); first call for a (tenant, provider, date) inserts a row
   *  with the supplied counts. Used by `src/aiProviders/byokChatBudget.ts` to
   *  enforce a per-org daily token cap on BYOK-direct chat dispatch. Tenant =
   *  workspace = org at root (ADR 0015). */
  incrementByokChatUsage(
    tenantId: string,
    providerId: string,
    dateUtc: string,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void>;
  /** Read a tenant's accumulated BYOK chat tokens for a provider on a UTC date.
   *  Returns `{ inputTokens: 0, outputTokens: 0 }` when no row exists. */
  getByokChatUsage(
    tenantId: string,
    providerId: string,
    dateUtc: string,
  ): Promise<{ inputTokens: number; outputTokens: number }>;

  // ── envelope-correlation cache (cross-process replay safety) ──
  /**
   * Read back a previously-accepted envelope outcome for a given
   * (runId, correlationId). Returns null if no record exists. Backs
   * the persisted-dedup-state seam for `host.aiEnvelope.correlationReplay`
   * cross-process semantics: if a process dies between accepting the
   * first emission and persisting downstream side-effects, a recovered
   * process that re-emits the same correlationId reads back the
   * original outcome from this surface instead of re-running the
   * acceptor (which could now decide differently if e.g. capability
   * flags changed). Outcome JSON carries the already-redacted payload
   * — never the raw envelope — so SR-1 redaction-carry-forward holds
   * across the persistence boundary.
   */
  getEnvelopeCorrelation(
    runId: string,
    correlationId: string,
  ): Promise<{ outcome: unknown; envelopeType: string; recordedAt: string } | null>;
  /**
   * Persist (runId, correlationId) → outcome. Insert-or-replace.
   *
   * `recordedAt` MUST be an ISO-8601 UTC string (the `Z` form, e.g.
   * `new Date().toISOString()`). The sqlite backend stores it as TEXT
   * verbatim while the postgres backend stores it as TIMESTAMPTZ and
   * round-trips through `Date.toISOString()` on read — both round-trip
   * cleanly only for ISO-8601-Z input. Non-UTC-Z timestamps would
   * silently diverge between backends.
   */
  putEnvelopeCorrelation(
    runId: string,
    correlationId: string,
    outcome: unknown,
    envelopeType: string,
    recordedAt: string,
  ): Promise<void>;

  // ── chat sessions (Phase 2C.1) ──
  /**
   * Sample-namespaced chat-session history backing the new
   * `/v1/host/openwop-app/chat/sessions/*` routes. Two tables: session
   * headers (this method family) + per-session messages (below).
   * Sessions are tenant-scoped; the in-memory adapter holds them in
   * a Map keyed by tenantId; sqlite/postgres back them with the
   * `chat_sessions` + `chat_messages` tables added in their next
   * migration.
   */
  listChatSessions(tenantId: string, limit?: number): Promise<readonly ChatSessionRecord[]>;
  /** Insert-or-throw (caller picks the sessionId; collision is a
   *  programming error, not a wire-level conflict). */
  createChatSession(record: ChatSessionRecord): Promise<void>;
  getChatSession(tenantId: string, sessionId: string): Promise<ChatSessionRecord | null>;
  /** Patch the mutable fields (title, titleSource, updatedAt, messageCount).
   *  `sessionId`/`tenantId`/`createdAt` are immutable. */
  updateChatSession(
    tenantId: string,
    sessionId: string,
    patch: Partial<Pick<ChatSessionRecord, 'title' | 'titleSource' | 'updatedAt' | 'messageCount'>>,
  ): Promise<void>;
  /** ATC-3/4 — CAS the title ONLY if `title_source` still equals `expectTitleSource`
   *  (the auto-title path passes `'default'`). Returns true iff a row matched the
   *  precondition and was updated; false if a concurrent manual rename already moved
   *  `title_source` off the expected value (or the session is gone). This makes the
   *  auto-title check+write ATOMIC, closing the sub-ms TOCTOU the app-level re-read
   *  leaves and the concurrent-double-write window. */
  casChatSessionTitle(
    tenantId: string,
    sessionId: string,
    patch: { title: string; titleSource: NonNullable<ChatSessionRecord['titleSource']>; updatedAt: string },
    expectTitleSource: NonNullable<ChatSessionRecord['titleSource']>,
  ): Promise<boolean>;
  /** Cascade-delete: drops both the session header AND all messages.
   *  Returns true if a row was removed, false if absent (idempotent). */
  deleteChatSession(tenantId: string, sessionId: string): Promise<boolean>;
  /** Load messages for a session in insertion order (`created_at` then
   *  `message_id`, ascending — the chat replay order).
   *
   *  With no `opts`, returns the full thread (unchanged legacy behavior).
   *  With `opts.limit = N`, returns up to the N MOST-RECENT messages, ascending
   *  — and when `opts.before` is given, the N messages strictly OLDER than that
   *  cursor. This backs "load earlier messages" reverse pagination (ADR 0043
   *  Phase 3b); the route layer derives the next cursor + has-more from the
   *  result. The cursor is a `(createdAt, messageId)` tuple so messages sharing
   *  a millisecond timestamp page deterministically. */
  listChatSessionMessages(
    sessionId: string,
    opts?: { limit?: number; before?: { createdAt: string; messageId: string } },
  ): Promise<readonly ChatMessageRecord[]>;
  /** Exact message count for a session (SELECT COUNT(*)). The belt-and-braces
   *  truth for unread math — exact even for rows written outside the adapter's
   *  atomic counter bump (post-merge CS-CH-3 architect review). */
  countChatSessionMessages(sessionId: string): Promise<number>;
  /** Append a single message. The adapter bumps `chat_sessions.message_count`
   *  + `updated_at` ATOMICALLY with the insert (an earlier hardening — the old
   *  caller-side read-modify-write lost increments under concurrency; callers
   *  must NOT bump it again). */
  appendChatMessage(record: ChatMessageRecord): Promise<void>;
  /** Update an existing message's `content` (+ optional `meta`) in place, keyed by
   *  `(sessionId, messageId)`. `created_at`/`role` are immutable (thread order is
   *  stable). Returns true if a row was updated, false if no such message exists.
   *  Backs re-saving a run-backed `workflow_run` message as its state evolves
   *  (ADR 0067) — append can't (the messageId is unique). Does NOT touch
   *  `message_count` (no new message). */
  updateChatMessageContent(sessionId: string, messageId: string, content: string, meta: string | null): Promise<boolean>;
  /** The `author_subject` of a single message (for the edit-authz gate, ADR 0102
   *  Phase 2), or `undefined` if no such message exists. A present row with a null
   *  author returns `{ authorSubject: null }` (legacy/anon ⇒ owner-writable). */
  getChatMessageAuthor(sessionId: string, messageId: string): Promise<{ authorSubject: string | null } | undefined>;
  /** ADR 0195 — fetch ONE message row (role + prior content/meta drive the
   *  server-derived `editedAt` stamp and the tombstone merge). */
  getChatMessage(sessionId: string, messageId: string): Promise<ChatMessageRecord | undefined>;

  // ── notifications (PR #143) ──
  /**
   * Per-tenant inbox of action-needed signals. Emitted by the executor
   * + suspend manager when a HITL interrupt opens, a run fails, etc.
   * The /v1/notifications routes back the bell + panel in the FE app.
   *
   * Status lifecycle: `unread` → `read` (via updateNotificationStatus)
   *                          → `archived` (via updateNotificationStatus)
   *                          → deleted (via deleteNotification).
   * `read_at` / `archived_at` columns are set by the storage adapter on
   * transition; callers pass the target status.
   */
  insertNotification(record: NotificationRecord): Promise<void>;
  listNotifications(filter: {
    tenantId: string;
    /** ADR 0050 — when set, return this user's addressed rows PLUS the tenant's
     *  broadcast rows (`recipient_user_id IS NULL`). Omit for an admin/legacy
     *  view of every tenant row. */
    recipientUserId?: string;
    /** ADR 0050 Phase 3 — the caller's RBAC roles. A role-addressed row
     *  (`recipient_role` set) is visible only when its role is in this set;
     *  empty/absent ⇒ role rows are hidden (default-deny). Only consulted
     *  alongside `recipientUserId` (the scoped inbox view). */
    recipientRoles?: readonly string[];
    status?: NotificationStatus | readonly NotificationStatus[];
    /** Exclude `archived` rows by default — the inbox view doesn't
     *  surface them. Pass `includeArchived: true` from the Archived tab. */
    includeArchived?: boolean;
    /** Oldest-first when true; default newest-first. */
    ascending?: boolean;
    limit?: number;
  }): Promise<readonly NotificationRecord[]>;
  getNotification(notificationId: string): Promise<NotificationRecord | null>;
  /**
   * Move a notification to a new status. The adapter sets `read_at` /
   * `archived_at` automatically based on the target status. Returns
   * the updated record, or null if the row was absent.
   */
  updateNotificationStatus(
    notificationId: string,
    status: NotificationStatus,
    now: string,
  ): Promise<NotificationRecord | null>;
  /** Mark every unread row for the tenant as read. Returns the count touched.
   *  ADR 0050 — when `recipientUserId` is given, only rows that user can see
   *  (their addressed rows + tenant broadcasts) are cleared, never another
   *  member's addressed items. */
  markAllNotificationsRead(tenantId: string, now: string, recipientUserId?: string, recipientRoles?: readonly string[]): Promise<number>;
  deleteNotification(notificationId: string): Promise<boolean>;
  /** Drop every notification owned by a tenant (used by account-delete). */
  deleteAllTenantNotifications(tenantId: string): Promise<number>;
  /**
   * CMNT-11 — drop every notification in this tenant that NAMES a data subject.
   *
   * A notification carries the subject in up to three places: `recipient_user_id`
   * (who it was addressed to) and `metadata.actorId` / `metadata.recipientId`
   * (who caused it / who it is about — the comments emitter writes all three, and
   * the message body quotes the parent resource's title). Until this existed the
   * ONLY reclamation was `deleteAllTenantNotifications` ("used by account-delete")
   * — tenant-level, never per-subject — so a DSAR erased the comment and left a
   * notification naming its author standing.
   *
   * Tenant-scoped and fail-closed on a falsy tenant or subject: a subject eraser
   * that widens to "everything" on an empty key is worse than one that misses.
   * Returns the number of rows removed so the caller can report a real count
   * rather than a silent void.
   */
  deleteNotificationsForSubject(tenantId: string, subjectKey: string): Promise<number>;

  // ── Web Push subscriptions (PR #174) ──
  /**
   * Per-tenant push subscription rows. One per browser/device, identified
   * by the `endpoint` URL the browser hands us at `pushManager.subscribe()`
   * time. The same endpoint re-subscribing (e.g., key rotation, user
   * re-enabled permission) UPSERTs by endpoint — keeps the row count
   * matched to active browsers, not historical subscription attempts.
   */
  insertPushSubscription(record: PushSubscriptionRecord): Promise<void>;
  /** List every active subscription owned by a tenant. Used by the
   *  notification emitter to fan out a push delivery on emit. */
  listPushSubscriptions(tenantId: string): Promise<readonly PushSubscriptionRecord[]>;
  /** Look up a subscription by endpoint — used to detect duplicates
   *  and to delete one specific browser's row on permission-revoke. */
  getPushSubscriptionByEndpoint(endpoint: string): Promise<PushSubscriptionRecord | null>;
  /** Drop a single subscription. Returns true when a row was removed. */
  deletePushSubscription(subscriptionId: string): Promise<boolean>;
  /** Drop every subscription owned by a tenant — wired into the
   *  account-delete cascade. */
  deleteAllTenantPushSubscriptions(tenantId: string): Promise<number>;

  // ── user-authored agents (phase E1, 2026-05-28) ──
  // Pack-installed agents come through the AgentRegistry from RFC 0003
  // pack manifests. These rows back `POST /v1/host/openwop-app/agents` —
  // the Agents-tab authoring form. On boot the app reads every row and
  // registers it with the AgentRegistry; the existing GET /v1/agents
  // surface then merges both sources without consumers distinguishing.
  insertUserAgent(record: UserAgentRecord): Promise<void>;
  /** List every user-authored agent owned by a tenant. Used by the
   *  agents-tab list view (filtered to the caller's tenant). */
  listUserAgents(tenantId: string): Promise<readonly UserAgentRecord[]>;
  /** Cross-tenant listing — used by the boot-time registry loader so
   *  every user-authored agent is registered in the process-local
   *  `AgentRegistry` without first enumerating tenants. The registry
   *  itself is not tenant-scoped; tenant-isolation lives at the
   *  storage + route layers. */
  listAllUserAgents(): Promise<readonly UserAgentRecord[]>;
  /** Read one user-authored agent WITHIN a tenant (ADR 0379 P1: the tenant is
   *  part of the predicate, not a caller-side post-check — a cross-tenant id
   *  returns null, indistinguishable from absent). */
  getUserAgent(tenantId: string, agentId: string): Promise<UserAgentRecord | null>;
  /** By-id-alone read — the ONE besides `listAllUserAgents` (ADR 0379 P1):
   *  exclusively for the registry miss-hook (`hydrateUserAgentIntoRegistry`),
   *  which has no tenant in scope; the loaded manifest carries its true
   *  `ownerTenant` and every consumer gates via `agentVisibleToTenant`.
   *  Tripwire-pinned to that single caller. Retired when Phase 2 re-keys the
   *  registry by (tenant, agentId). */
  getUserAgentAnyTenant(agentId: string): Promise<UserAgentRecord | null>;
  /** Remove one user-authored agent WITHIN a tenant (ADR 0379 P1 predicate).
   *  Returns true when a row was removed. Pack-installed agents aren't
   *  reachable through this surface (different storage). */
  deleteUserAgent(tenantId: string, agentId: string): Promise<boolean>;
  /** Update one user-authored agent's mutable fields (the editable
   *  "Instructions" panel — systemPrompt + persona-shaping metadata).
   *  `agentId`/`createdAt` are immutable. ADR 0379 P1: `expectedTenantId` is
   *  in the WHERE predicate, so a silent cross-tenant move is impossible; the
   *  ONE legitimate tenant move (the boot `_anon` → `default` legacy migration
   *  in `loadUserAgentsIntoRegistry`) passes the OLD tenant explicitly and
   *  writes the new one from the record. Returns true when a row matched. */
  updateUserAgent(expectedTenantId: string, record: UserAgentRecord): Promise<boolean>;

  // ── messaging relay-gateway (demo host-extension; NON-normative) ──
  // Device tokens are persisted as a SHA-256 hash only (see RelayDeviceRecord).
  upsertRelayDevice(record: RelayDeviceRecord): Promise<void>;
  getRelayDevice(relayId: string): Promise<RelayDeviceRecord | null>;
  /** Look up an active device by the SHA-256 hash of its presented token. */
  getRelayDeviceByTokenHash(tokenHash: string): Promise<RelayDeviceRecord | null>;
  /** List a tenant's relay devices (newest registration first). Backs the
   *  connector deliverability probe — "is there a live device that can actually
   *  deliver outbound for this channel right now?". */
  listRelayDevices(tenantId: string): Promise<readonly RelayDeviceRecord[]>;

  // ── agent-attributed run activity index (RFC 0086) ──
  /** Record (append-only, idempotent on runId) that a run is attributed to a
   *  roster member. Written once at run creation; immutable — live status is
   *  read from the runs table at query time. */
  recordAgentRunAttribution(row: AgentRunAttributionRow): Promise<void>;
  /** List agent-attributed runs via the index, joined to the live run row:
   *  filter by tenant, optional roster member, optional run status; newest
   *  first. Returns full RunRecords so callers project them as usual. */
  listAgentRunActivity(filter: {
    tenantId: string;
    rosterId?: string;
    status?: string;
    limit?: number;
  }): Promise<readonly RunRecord[]>;
  /** ADR 0380 §2 — delete activity rows whose run no longer exists (residue of
   *  runs swept BEFORE the deleteRun cascade covered this table). One-shot via
   *  app-migration v3; idempotent + concurrency-safe (a guarded DELETE).
   *  Returns the number deleted. */
  deleteOrphanAgentRunActivity(): Promise<number>;

  // ── autonomous-run budget (windowed counter) ──
  /** Atomically increment the run-budget counter for `bucket` (a `tenant:window`
   *  key) and return the new count. `windowStart` (epoch ms) is stamped on
   *  insert so rolled-over windows can be pruned. Multi-instance-safe (single
   *  upsert) — concurrent callers get distinct monotonically-increasing counts,
   *  so a ceiling compared against the returned value is enforced exactly once. */
  consumeRunBudget(bucket: string, windowStart: number): Promise<number>;
  /** Delete run-budget rows for windows older than `olderThanWindowStart`
   *  (epoch ms). Best-effort housekeeping; returns the count removed. */
  pruneRunBudget(olderThanWindowStart: number): Promise<number>;

  /** Append an egress to a relay's outbound queue. */
  enqueueRelayOutbound(record: ChatEgressEnvelope): Promise<void>;
  /** Pull pending egress for a relay, oldest first. */
  listRelayOutbound(relayId: string, limit: number): Promise<readonly ChatEgressEnvelope[]>;
  /** Delete acked egress rows; returns the count removed. */
  ackRelayOutbound(relayId: string, egressIds: readonly string[]): Promise<number>;
  /** Drop a relay's whole queue (on revoke). */
  deleteRelayOutbound(relayId: string): Promise<void>;
  upsertMessagingConnector(record: MessagingConnectorRecord): Promise<void>;
  getMessagingConnector(connectorId: string): Promise<MessagingConnectorRecord | null>;
  listMessagingConnectors(tenantId: string | undefined): Promise<readonly MessagingConnectorRecord[]>;
  upsertMessagingSession(record: MessagingSessionRecord): Promise<void>;
  getMessagingSession(sessionKey: string): Promise<MessagingSessionRecord | null>;
  listMessagingSessions(tenantId: string | undefined): Promise<readonly MessagingSessionRecord[]>;
  deleteMessagingSession(sessionKey: string): Promise<boolean>;
  // policies (per-connector access control) / routing / identity / delivery log
  upsertMessagingPolicy(record: MessagingPolicyRecord): Promise<void>;
  getMessagingPolicy(connectorId: string): Promise<MessagingPolicyRecord | null>;
  upsertMessagingRoutingRule(record: MessagingRoutingRuleRecord): Promise<void>;
  listMessagingRoutingRules(tenantId: string | undefined): Promise<readonly MessagingRoutingRuleRecord[]>;
  deleteMessagingRoutingRule(ruleId: string): Promise<boolean>;
  upsertMessagingIdentity(record: MessagingIdentityRecord): Promise<void>;
  getMessagingIdentity(identityId: string): Promise<MessagingIdentityRecord | null>;
  listMessagingIdentities(tenantId: string | undefined): Promise<readonly MessagingIdentityRecord[]>;
  deleteMessagingIdentity(identityId: string): Promise<boolean>;
  appendDeliveryLog(record: DeliveryLogRecord): Promise<void>;
  listDeliveryLog(filter: {
    tenantId: string | undefined;
    channel?: string;
    direction?: 'inbound' | 'outbound';
    status?: string;
    limit?: number;
  }): Promise<readonly DeliveryLogRecord[]>;
  appendMessagingTurn(record: MessagingTurnRecord): Promise<void>;
  /**
   * Return the most-recent `limit` turns for a session, oldest → newest.
   * `tenantId` is required defense-in-depth so a collision of
   * `${channel}:${conversationId}` across tenants cannot leak turns.
   */
  listMessagingTurns(sessionKey: string, limit: number, tenantId: string): Promise<readonly MessagingTurnRecord[]>;

  // ── pairing + allowlist (per-connector access gates) ──
  appendMessagingPairing(record: MessagingPairingRecord): Promise<void>;
  getMessagingPairingByCode(connectorId: string, code: string): Promise<MessagingPairingRecord | null>;
  listMessagingPairings(connectorId: string | undefined): Promise<readonly MessagingPairingRecord[]>;
  deleteMessagingPairing(pairingId: string): Promise<boolean>;
  addMessagingAllowlist(entry: MessagingAllowlistEntry): Promise<void>;
  getMessagingAllowlist(connectorId: string, channel: string, peerId: string): Promise<MessagingAllowlistEntry | null>;
  listMessagingAllowlist(connectorId: string | undefined): Promise<readonly MessagingAllowlistEntry[]>;
  deleteMessagingAllowlist(connectorId: string, channel: string, peerId: string): Promise<boolean>;

  // ── host-extension durability (generic key→JSON store) ──
  // A single small table backing the reference app-extension stores (Kanban
  // boards, agent roster, org-chart) so they survive a restart on the file /
  // Postgres backends. Generic on purpose — a host-ext service serializes its
  // whole collection to one key, rather than the core Storage interface
  // fanning out a method per entity. NOT a normative protocol surface.
  kvGet(key: string): Promise<string | null>;
  kvSet(key: string, value: string): Promise<void>;
  /** Read-through scan of every (key,value) whose key starts with `keyPrefix`.
   *  Backs the per-entity host-ext collections (one row per board/card/roster
   *  entry/...), so a list reads live rows rather than a per-instance cache. */
  kvList(keyPrefix: string): Promise<ReadonlyArray<{ key: string; value: string }>>;
  /**
   * `kvList` narrowed in the DATABASE to rows whose raw value CONTAINS `needle`
   * (a literal substring — LIKE metacharacters are escaped). A SUPERSET filter by
   * construction: it can only drop rows that do not contain the text, so a caller
   * that needs rows whose JSON holds a given string value loses nothing, and still
   * applies its exact filter to what comes back. OPTIONAL: callers fall back to
   * `kvList` (complete, just slower) where a backend lacks it.
   */
  kvListContaining?(keyPrefix: string, needle: string): Promise<ReadonlyArray<{ key: string; value: string }>>;
  /** Delete one key. Returns true if a row existed. */
  kvDelete(key: string): Promise<boolean>;
  /** Atomically set `key` to `next` iff its current stored value equals
   *  `expected` (`expected: null` ⇒ swap only if the key is absent). Returns
   *  whether the swap occurred and the value observed at the call. This is the
   *  atomic building block for compare-and-set / read-modify-write host
   *  surfaces that must stay correct ACROSS instances — unlike kvGet+kvSet,
   *  which races. Backends implement it as a single atomic statement /
   *  transaction. NOT a normative protocol surface. */
  kvCompareAndSwap(
    key: string,
    expected: string | null,
    next: string,
  ): Promise<{ swapped: boolean; actual: string | null }>;

  // ── cross-instance pub/sub (host-ext live fan-out) ──
  // Publishes a small payload to a logical channel and delivers it to every
  // subscriber across ALL host instances. Backs the Kanban SSE board-change
  // fan-out so a mutation on one instance reaches SSE clients on every
  // instance. On Postgres this is LISTEN/NOTIFY; on sqlite (single node) it is
  // an in-process emitter. NOT a normative protocol surface.
  /** Publish `payload` to a logical `channel` (delivered cross-instance). */
  publish(channel: string, payload: string): Promise<void>;
  /** Subscribe to a logical `channel`. Returns an async unsubscribe. */
  subscribe(channel: string, handler: (payload: string) => void): Promise<() => Promise<void>>;

  // ── app metadata (ADR 0052) ──
  // App-tier key/value store in `__app_meta`, distinct from the schema-version
  // axis. Records `app_version` (fresh-vs-upgrade) + `app_migration_version`
  // (the §D5 app-migration counter).
  /** Read an `__app_meta` value, or null when absent. */
  getAppMeta(key: string): Promise<string | null>;
  /** Upsert an `__app_meta` value (stamps `updated_at`). */
  setAppMeta(key: string, value: string): Promise<void>;

  // ── lifecycle ──
  close(): Promise<void>;
}
