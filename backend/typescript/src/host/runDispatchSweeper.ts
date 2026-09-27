/**
 * Multi-instance run-dispatch crash-recovery sweeper — and, since ADR 0551 P1,
 * the durable dispatch-outbox worker.
 *
 * TWO LANES, ONE DAEMON (ADR 0551's boundaries table forbids a second
 * executor/daemon, and ADR 0548 invariant 2 puts dispatch behind one seam):
 *
 *   - the OUTBOX lane (fast, every tick) drains `dispatch_outbox` rows written
 *     atomically with their runs. It answers "was this accepted run ever
 *     started?" — the question `setImmediate` could not answer across a process
 *     death.
 *   - the ORPHAN lane (slow, every Nth tick) is the pre-existing lease sweep. It
 *     answers "did the instance running this run die mid-flight?" and remains
 *     the safety net for every run with no outbox row (forks, seam probes, runs
 *     created before the migration).
 *
 * Neither lane executes anything itself: both hand off to `executeRun`, and the
 * run-dispatch LEASE stays the execution fence.
 *
 * Every dispatch path funnels through `executor.executeRun`, which stamps a
 * dispatch lease (`setRunDispatchLease`) on the run for this instance. The lease
 * outlives the maximum legal runtime (`RUN_DISPATCH_LEASE_MS`), so an alive run
 * is never re-dispatched.
 *
 * When an instance crashes mid-run, the run is left `pending`/`running` with a
 * lease that eventually expires. This sweeper claims those orphans
 * (`claimOrphanedRuns` — atomic, multi-instance-safe) and re-dispatches them via
 * `executeRun`, which is idempotent against the Layer-2 invocation log (completed
 * nodes replay from cache rather than re-executing). A `createdAt` grace window
 * ensures freshly-dispatched runs are never raced by the sweep; `waiting-*` and
 * terminal runs are excluded by status (they are not stuck — they are parked or
 * done).
 *
 * `sweepOrphanedRuns` is exported so tests can drive one pass deterministically;
 * `startRunDispatchSweeper` runs it on a slow poll for the live server.
 */

import type { Storage } from '../storage/storage.js';
import { runUnderWorkerContract } from '../storage/eventEraAdapter.js';
import type { HostAdapterSuite } from './index.js';
import { executeRun, emitTerminalFailure, RUN_DISPATCH_LEASE_MS } from '../executor/executor.js';
import { forkDispatchOptions } from '../executor/forkInterrupts.js';
import { getInstanceId } from './instanceId.js';
import { createLogger } from '../observability/logger.js';
import { recordDispatchRecovery, recordOutboxBacklog } from '../observability/metricSeams.js';
import { resolveRunDefinition } from './resolveRunDefinition.js';
import { failRunClosedOnDispatchError } from './runDispatch.js';
import { randomUUID } from 'node:crypto';
import type { RunRecord } from '../types.js';
import {
  authorityFromWorkload,
  readRecordedAuthority,
  recordAuthorityAction,
  runWithAuthority,
  type AuthorityFacts,
} from './authorityContext.js';
import {
  HOST_WORKER_SCOPES,
  isWorkloadIdentityEnabled,
  mintWorkloadCredential,
  resolveWorkloadIdentity,
  verifyWorkloadCredential,
} from './workloadIdentity.js';
import { unwindOnDispatchTerminal } from './compensationRuntime.js';

const log = createLogger('runDispatchSweeper');

/** Runs younger than this are never swept (avoids racing a fresh dispatch). */
export const GRACE_MS = 120_000;
/** Re-dispatch ceiling: an orphan still `pending`/`running` this long after
 *  creation is presumed genuinely stuck (a host bug or a node hung past the
 *  run-duration ceiling without hitting a boundary check). Rather than
 *  re-dispatch it on every sweep forever, the sweeper fails it terminally so it
 *  reaches a clean end state instead of looping. ~6 lease windows. */
const MAX_REDISPATCH_AGE_MS = 3_600_000;
/** Orphans re-claimed per pass. */
const CLAIM_BATCH = 10;
/**
 * Tick cadence. This is the OUTBOX lane's cadence: an accepted run whose
 * process died before the wakeup hint fired waits at most one tick past its
 * `nextAttemptAt`, so "eventual start" is seconds.
 */
export const POLL_INTERVAL_MS = 5_000;
/**
 * The orphan lane runs every Nth tick, preserving its original 30s cadence.
 * Crash recovery via lease expiry isn't latency-critical (the lease itself is
 * ~12 minutes), and it scans ALL pending/running runs, so it should not run at
 * the outbox lane's rate.
 */
export const ORPHAN_SWEEP_EVERY_N_TICKS = 6;

/**
 * How many poll intervals an in-flight tick may occupy before the daemon
 * reports itself wedged. Generous — a slow storage pass is normal and must not
 * cry wolf — but far below the orphan cadence, so a wedge is visible long
 * before a recovery is actually missed.
 */
export const WEDGE_TICKS = 12;

/** Outbox rows claimed per pass. */
const OUTBOX_CLAIM_BATCH = 20;
/**
 * How long an outbox claim is held. Short on purpose: the claim only covers
 * DECIDING what to do with the row and handing off to `executeRun`, never the
 * run itself (that is the dispatch lease's job). If this worker dies mid-decision
 * the row is re-claimable a minute later rather than at the end of a run-length
 * lease.
 */
export const OUTBOX_LEASE_MS = 60_000;
/**
 * Backoff between outbox delivery attempts for a row that could not be
 * discharged (typically: the run's definition is not resolvable yet).
 */
const OUTBOX_RETRY_BACKOFF_MS = 30_000;
/**
 * Deliveries before a row is marked `dead`. A row only fails to discharge for
 * reasons that do not fix themselves (a deleted workflow), so this is small.
 * Dead rows are retained for the ADR 0551 P2 operator surface; the run itself
 * still reaches a terminal state through the orphan lane's abandon ceiling.
 */
const OUTBOX_MAX_ATTEMPTS = 5;

export interface RunSweeperDeps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
}

/**
 * Claim and re-dispatch one batch of orphaned runs. Returns the number
 * re-dispatched (0 when none are orphaned). Exported for deterministic tests —
 * pass a fixed `now`; the running sweeper passes `Date.now()`.
 */
export async function sweepOrphanedRuns(
  deps: RunSweeperDeps,
  workerId: string,
  now: number = Date.now(),
): Promise<number> {
  const { storage, hostSuite } = deps;
  const staleBeforeIso = new Date(now - GRACE_MS).toISOString();
  const orphans = await storage.claimOrphanedRuns(workerId, now, staleBeforeIso, RUN_DISPATCH_LEASE_MS, CLAIM_BATCH);
  const abandonBefore = now - MAX_REDISPATCH_AGE_MS;
  let redispatched = 0;
  for (const run of orphans) {
    // A run still orphaned this long after creation is presumed genuinely stuck;
    // fail it terminally rather than re-dispatch it on every sweep forever.
    if (Date.parse(run.createdAt) < abandonBefore) {
      log.error('abandoning chronically-orphaned run (exceeded re-dispatch ceiling)', {
        runId: run.runId,
        status: run.status,
        ageMs: now - Date.parse(run.createdAt),
      });
      try {
        // RFC 0151 §B — a resumed run that had already committed effects must
        // not have its plan stranded because the sweeper gave up on it.
        await unwindOnDispatchTerminal(storage, run.runId, 'dispatch-abandoned');
        await emitTerminalFailure({
          storage,
          runId: run.runId,
          error: {
            code: 'dispatch_abandoned',
            message: `Run repeatedly orphaned and re-dispatched for over ${Math.round(MAX_REDISPATCH_AGE_MS / 60000)} minutes; abandoned by the dispatch sweeper.`,
          },
        });
      } catch (err) {
        // Best-effort: a failed terminal-emit must not crash the sweep. The run
        // keeps its (now fresh) lease and the next sweep re-attempts the abandon.
        log.warn('failed to abandon orphaned run', { runId: run.runId, error: err instanceof Error ? err.message : String(err) });
      }
      // ADR 0551 P2 — the orphan lane's terminal outcome. `dead` in BOTH lanes
      // means "this intent was given up on", which is the thing worth alerting
      // on; the `lane` label is what tells an operator which mechanism gave up.
      recordDispatchRecovery('orphan', 'dead');
      continue;
    }
    // ADR 0474 — a pinned run recovers against the EXACT definition it ran.
    const resolved = await resolveRunDefinition(run, hostSuite.workflowCatalog);
    if (!resolved) {
      log.warn('orphan run workflow not found — skipping re-dispatch', { runId: run.runId, workflowId: run.workflowId });
      // Not terminal: this lane has no attempt budget, so the run is simply
      // left for the next sweep (until the abandon ceiling above catches it).
      recordDispatchRecovery('orphan', 'retried');
      continue;
    }
    const wf = { workflowId: run.workflowId, definition: resolved.definition };
    log.warn('re-dispatching orphaned run (owning instance presumed crashed)', {
      runId: run.runId,
      status: run.status,
      previousOwner: run.dispatchOwner ?? null,
    });
    redispatched++;
    recordDispatchRecovery('orphan', 'dispatched');
    // ADR 0556 P3 / RFC 0154 — the authority this worker re-dispatches under.
    // Recorded-first: the run already carries the authority it was created with,
    // and re-running it under a freshly minted worker identity would be exactly
    // the "remint broader authority" the ADR forbids — a crash would become an
    // authority upgrade. A run with no recorded authority (every run created
    // before this shipped, and every ordinary user request) gets the worker's
    // OWN bounded identity instead, never a copied caller credential.
    const authority = await sweeperAuthority(run);
    setImmediate(() => {
      const dispatch = async (): Promise<void> => {
        try {
          // ADR 0740 — `claimOrphanedRuns` above IS this run's atomic execution
          // claim (it stamped this instance as owner with a live lease), so tell
          // `executeRun` not to contend: to its claim, that stamp is exactly what
          // a duplicate delivery looks like, and recovery would refuse itself.
          //
          // ADR 0755 (FORKINT-2) — a FORK recovers the way the `:fork` route
          // dispatches it: from its persisted checkpoint (so the copied prefix
          // never re-executes and an inherited gate is re-created with the
          // source's deadline) and, for replay, against the source's invocations.
          await executeRun(storage, run, wf.definition, {
            policyResolver: hostSuite.providerPolicyResolver,
            executionPreclaimed: true,
            ...forkDispatchOptions(run),
          });
        } catch (err) {
          log.error('orphan run re-dispatch failed', { runId: run.runId, error: err instanceof Error ? err.message : String(err) });
        }
      };
      if (!authority) {
        void dispatch();
        return;
      }
      void runWithAuthority(authority, () => {
        recordAuthorityAction('dispatch', 'allow');
        return dispatch();
      });
    });
  }
  return redispatched;
}

/**
 * ADR 0551 P1 — drain one batch of the durable dispatch outbox.
 *
 * Returns the number of runs this pass actually handed to `executeRun`. Exported
 * so tests can drive one deterministic pass; the daemon passes `Date.now()`.
 *
 * ## Why a row is only retired on OBSERVED evidence
 *
 * The worker never says "I dispatched it, so we're done". It retires a row only
 * when it can SEE that the run left `pending` — which is a fact written by
 * `executeRun` itself, durably, before any node runs. So the sequence for a
 * healthy run is two claims: the first dispatches and leaves the row pending
 * (with one attempt counted, and the second delivery scheduled), the second
 * observes `running` and deletes the row. If this process dies between those
 * two, the row is simply still there and still due — and if the run never
 * leaves `pending` at all, the attempt count retires the row as `dead` rather
 * than re-dispatching it forever.
 *
 * That is also what makes DUPLICATE DELIVERY safe, which is the second half of
 * the P1 exit criterion. A row delivered twice (the first holder's lease expired
 * while it was slow, say) does not produce two executions: the second delivery
 * re-reads the run, finds it out of `pending` or holding a live dispatch lease,
 * and discharges the intent without invoking anything. Duplicate delivery is
 * therefore not merely tolerated by replay — it is refused up front, and replay
 * remains the backstop rather than the mechanism.
 */
export async function sweepDispatchOutbox(
  deps: RunSweeperDeps,
  workerId: string,
  now: number = Date.now(),
): Promise<number> {
  const { storage, hostSuite } = deps;
  // ADR 0551 P2 — the backlog observation, taken BEFORE the claim so the depth
  // reported is the queue an operator would have seen, not the residue of the
  // batch this pass just leased. Wrapped because instrumentation must never
  // break the work it measures: a stats read that fails must cost a sample, not
  // a sweep.
  try {
    recordOutboxBacklog({ ...(await storage.dispatchOutboxStats()), nowMs: now });
  } catch (err) {
    log.warn('dispatch outbox backlog observation failed', { error: err instanceof Error ? err.message : String(err) });
  }
  const claimed = await storage.claimDispatchOutbox(workerId, now, OUTBOX_LEASE_MS, OUTBOX_CLAIM_BATCH);
  let dispatched = 0;
  for (const row of claimed) {
    const run = await storage.getRun(row.runId);
    // The run is gone (deleted / retention-swept). The intent is moot; keeping
    // the row would re-deliver forever against nothing.
    if (!run) {
      await storage.completeDispatchOutbox(row.runId);
      recordDispatchRecovery('outbox', 'run-missing');
      continue;
    }
    // Already started — by the in-process wakeup hint on the happy path, or by
    // an earlier delivery of this same row. `executeRun` writes `running`
    // durably before executing any node, so this is evidence, not inference.
    if (run.status !== 'pending') {
      await storage.completeDispatchOutbox(row.runId);
      recordDispatchRecovery('outbox', 'discharged');
      continue;
    }
    // Still `pending`, but an instance holds a live dispatch lease on it: it is
    // between `run.started` and the status write, or a sweeper just claimed it.
    // Leave that owner alone; the orphan lane owns it from here.
    if (run.dispatchLeaseExpiresAt != null && run.dispatchLeaseExpiresAt > now) {
      await storage.completeDispatchOutbox(row.runId);
      recordDispatchRecovery('outbox', 'discharged');
      continue;
    }

    // ADR 0474 — dispatch against the EXACT definition the run was created
    // with, exactly as the orphan lane does.
    const resolved = await resolveRunDefinition(run, hostSuite.workflowCatalog);
    if (!resolved) {
      const dead = row.attempts + 1 >= OUTBOX_MAX_ATTEMPTS;
      log.warn('dispatch outbox: run workflow not found', {
        runId: row.runId, workflowId: run.workflowId, attempts: row.attempts + 1, dead,
      });
      await storage.rescheduleDispatchOutbox(
        row.runId,
        now + OUTBOX_RETRY_BACKOFF_MS,
        dead,
        `workflow not found: ${run.workflowId}`,
      );
      recordDispatchRecovery('outbox', dead ? 'dead' : 'retried');
      continue;
    }

    log.info('dispatch outbox: starting a run the wakeup hint never started', {
      runId: row.runId, workflowId: run.workflowId, attempts: row.attempts,
    });
    dispatched++;
    // ADR 0556 P3 — the SAME authority treatment the orphan lane below gets.
    // Both lanes hand a run to `executeRun` from a background worker with no
    // live request principal, so attributing one and not the other would leave
    // half the dispatch surface unrecorded — and which half depends only on
    // which lane happened to pick the run up.
    const authority = await sweeperAuthority(run);
    // Fire-and-forget with the same fail-closed tail as the inline dispatch
    // path: a run that cannot start must reach a NAMED terminal state, never
    // sit `pending` while a poller burns its budget on a blind timeout.
    setImmediate(() => {
      const dispatch = (): void => {
        void executeRun(storage, run, resolved.definition, { policyResolver: hostSuite.providerPolicyResolver, ...forkDispatchOptions(run) /* ADR 0755 FORKINT-2 */ })
          .catch(async (err) => {
            const message = err instanceof Error ? err.message : String(err);
            log.error('dispatch outbox re-dispatch failed', { runId: row.runId, error: message });
            await failRunClosedOnDispatchError(storage, row.runId, message);
          });
      };
      if (!authority) {
        dispatch();
        return;
      }
      runWithAuthority(authority, () => {
        recordAuthorityAction('dispatch', 'allow');
        dispatch();
      });
    });
    // The row stays `pending` on purpose — see the doc comment. The next
    // delivery observes the run out of `pending` and retires it.
    //
    // But that next delivery is SCHEDULED here rather than left to the claim
    // lease lapsing, and it COUNTS the attempt. Otherwise a run that never
    // leaves `pending` — the degraded path where `executeRun` throws before its
    // status write AND the fail-closed marking also fails — is re-dispatched on
    // every lease expiry until the orphan lane's one-hour abandon ceiling. The
    // `attempts` column exists for exactly this bound, and a queue that can
    // re-deliver without limit is not bounded.
    const exhausted = row.attempts + 1 >= OUTBOX_MAX_ATTEMPTS;
    await storage.rescheduleDispatchOutbox(
      row.runId,
      now + OUTBOX_RETRY_BACKOFF_MS,
      exhausted,
      exhausted
        ? `dispatched ${row.attempts + 1}x and the run never left pending`
        : 'dispatched; awaiting evidence the run started',
    );
    // `dead` wins over `dispatched` when both are true in one pass: the row is
    // retired here and will never be delivered again, so reporting the dispatch
    // would leave the terminal transition uncounted — and `dead` is the outcome
    // an operator alerts on.
    recordDispatchRecovery('outbox', exhausted ? 'dead' : 'dispatched');
  }
  return dispatched;
}

/**
 * The workload identity a re-dispatch runs under (ADR 0556 P3, RFC 0154 §A).
 *
 * Two lanes, and the order between them is the safety property:
 *
 *  1. the run's RECORDED authority, when it has one. A crash-recovery
 *     re-dispatch is a continuation of work already authorized, so it inherits
 *     that authorization rather than acquiring a new one.
 *  2. otherwise a credential this host MINTS for itself — short-lived,
 *     audience-bound, scoped to `HOST_WORKER_SCOPES`, and immediately verified
 *     back through the same path a peer's credential would take. Round-tripping
 *     it rather than fabricating a principal is deliberate: the worker's
 *     identity is subject to every check an external identity is, so a bug in
 *     the audience or trust-root logic fails the host's own workers first.
 *
 * `null` when the profile is not configured — the sweeper then behaves exactly
 * as it did before P3, because a host that advertises nothing must not act as if
 * it had an identity layer.
 */
async function sweeperAuthority(run: RunRecord): Promise<AuthorityFacts | null> {
  const recorded = readRecordedAuthority(run.metadata);
  if (recorded) return recorded;
  if (!isWorkloadIdentityEnabled()) return null;
  try {
    const token = await mintWorkloadCredential({
      subject: SWEEPER_WORKLOAD_SUBJECT,
      tenantId: run.tenantId,
      scopes: HOST_WORKER_SCOPES,
    });
    const verified = await verifyWorkloadCredential(token);
    if (!verified.ok) {
      log.error('sweeper_workload_credential_unverifiable', { cause: verified.cause });
      return null;
    }
    const resolved = await resolveWorkloadIdentity(verified.identity, 'verified-credential', {
      verified: { tenantId: verified.tenantId, scopes: verified.scopes },
    });
    if (!resolved.ok) {
      log.error('sweeper_workload_identity_unresolved', { cause: resolved.cause });
      return null;
    }
    return authorityFromWorkload(resolved.principal, randomUUID());
  } catch (err) {
    // Fail CLOSED on the identity, not on the sweep: the run still recovers, it
    // simply recovers without a workload identity attached, which is the
    // pre-P3 behaviour rather than a widened one.
    log.error('sweeper_workload_identity_error', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** The opaque name this host's dispatch worker presents. Never a hostname or an
 *  instance id — those describe the deployment, and the subject is hashed into
 *  an opaque principal precisely so the deployment is not published. */
const SWEEPER_WORKLOAD_SUBJECT = 'worker/run-dispatch-sweeper';

export interface RunDispatchSweeper {
  stop(): void;
}

/**
 * Start the polling dispatch daemon for the running server. One pass at a time
 * (a slow pass never overlaps the next tick). Returns a handle whose `stop()`
 * clears the timer (call on graceful shutdown).
 *
 * ONE timer drives both lanes — the outbox every tick, the orphan sweep every
 * `ORPHAN_SWEEP_EVERY_N_TICKS` — rather than two daemons with two cadences.
 * A lane throwing must not stop the other, so each is caught separately.
 */
/**
 * Bound one sweeper pass, so a lane that never settles becomes a lane that
 * failed. Without this the daemon's re-entry guard (`if (running) return;`)
 * turns a single hung storage call into permanent silence — both lanes stop,
 * nothing is logged, and the host keeps declaring a recovery bound no mechanism
 * is producing (RFC 0158 §B.5).
 *
 * The timer is `unref()`d so a pending deadline cannot hold the process open at
 * shutdown, and cleared on the happy path so a healthy daemon leaves nothing
 * behind.
 */
async function withDeadline<T>(work: Promise<T>, lane: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${lane} pass exceeded ${POLL_INTERVAL_MS * WEDGE_TICKS}ms — abandoning it so the daemon keeps ticking`)),
      POLL_INTERVAL_MS * WEDGE_TICKS,
    );
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function startRunDispatchSweeper(deps: RunSweeperDeps, workerId: string = getInstanceId()): RunDispatchSweeper {
  // ONE timer, but each lane has its OWN re-entry guard and its OWN cadence.
  //
  // They used to share a single `running` flag and the orphan lane fired every
  // Nth TICK. That coupling has two failure modes, and a test found both:
  //
  //   1. A hung outbox pass never released the shared flag, so every later tick
  //      returned at the guard and BOTH lanes stopped forever — silently, since
  //      nothing threw. (#3056 is the same shape: `shellRefreshing` left set by a
  //      continuation that never resumed, `/` stale for 16+ minutes, zero errors.)
  //   2. Bounding each pass with a deadline fixes the permanent stall but not the
  //      coupling: counting orphan cadence in TICKS means a slow outbox stretches
  //      every tick, degrading orphan recovery from 30s to minutes. The first
  //      version of this fix did exactly that and the test still failed — which is
  //      how the coupling was found rather than assumed.
  //
  // So the orphan cadence is now WALL-CLOCK, not tick-counted, and neither lane
  // can starve the other.
  let outboxRunning = false;
  let orphanRunning = false;
  let lastOrphanSweepAt = 0;
  let wedgeReported = false;
  let outboxStartedAt = 0;

  const runLane = async (
    name: string,
    guard: () => boolean,
    setGuard: (v: boolean) => void,
    work: () => Promise<unknown>,
  ): Promise<void> => {
    if (guard()) return;
    setGuard(true);
    try {
      await withDeadline(work(), name);
    } catch (err) {
      log.warn(`${name} tick error`, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setGuard(false);
    }
  };

  const tick = (): void => {
    const now = Date.now();
    if (outboxRunning && !wedgeReported && now - outboxStartedAt > POLL_INTERVAL_MS * WEDGE_TICKS * 2) {
      wedgeReported = true;
      log.error('run dispatch daemon: outbox lane wedged past its deadline', {
        workerId,
        stalledMs: now - outboxStartedAt,
        note: 'the orphan lane is unaffected — it has its own guard and cadence',
      });
    }
    if (!outboxRunning) {
      outboxStartedAt = now;
      wedgeReported = false;
      void runLane('dispatch outbox', () => outboxRunning, (v) => { outboxRunning = v; },
        () => sweepDispatchOutbox(deps, workerId));
    }
    if (now - lastOrphanSweepAt >= POLL_INTERVAL_MS * ORPHAN_SWEEP_EVERY_N_TICKS) {
      lastOrphanSweepAt = now;
      void runLane('orphan sweep', () => orphanRunning, (v) => { orphanRunning = v; },
        () => sweepOrphanedRuns(deps, workerId));
    }
  };
  const timer = setInterval(() => runUnderWorkerContract(tick), POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('run dispatch daemon started', {
    workerId,
    pollIntervalMs: POLL_INTERVAL_MS,
    orphanSweepEveryNTicks: ORPHAN_SWEEP_EVERY_N_TICKS,
  });
  return { stop: () => clearInterval(timer) };
}
