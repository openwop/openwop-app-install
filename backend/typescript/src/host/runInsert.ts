/**
 * ADR 0099 — the single run-insert seam.
 *
 * Every run-creation path funnels its `storage.insertRun` through here so that
 * cross-cutting run-start decisions (tool-output compaction, future contributors)
 * are frozen into `run.metadata` at creation EXACTLY ONCE, regardless of which
 * subsystem started the run (POST /v1/runs, the scheduler/heartbeat starter,
 * Kanban + trigger-bridge ingestion, MCP-initiated runs, CRM, sub-workflows, …).
 * This is the "single owner" the architecture wants — a new run-creation path
 * inherits the stamp by using this helper instead of `storage.insertRun`
 * directly, rather than silently missing it.
 *
 * The tenant is derived from the run itself (`run.tenantId`), so migrating a call
 * site is a one-line swap. `stampRunStartContext` never overwrites an existing
 * key, so a `:fork`-copied decision is preserved (read verbatim, never
 * re-resolved) and the stamp is a no-op when no contributor is registered or the
 * feature is OFF.
 *
 * ADR 0551 P1 adds a second thing this seam owns: the DISPATCH INTENT. A caller
 * that passes `enqueueDispatch` gets a dispatch-outbox row written in the same
 * atomic storage operation as the run itself, so "the run exists" and "something
 * will start it" become one fact instead of two. Being the single insert seam is
 * what makes that possible to state once rather than per route.
 */

import { CURRENT_ENGINE_VERSION } from '../storage/eventEra.js';
import type { InsertRunOptions, Storage } from '../storage/storage.js';
import type { RunRecord } from '../types.js';
import { stampRunStartContext, type RunStartContext } from './runStartContext.js';
import { extractRunAttribution } from './agentRunActivityIndex.js';
import { revisionHashOf } from './definitionHash.js';
import type { WorkflowDefinition } from '../executor/types.js';

/**
 * ADR 0551 P1 — how far in the future a new outbox row's `nextAttemptAt` sits.
 *
 * The in-process wakeup hint (`setImmediate(executeRun)`) and the durable worker
 * are two paths to the same dispatch, so without a window they can both fire and
 * two `executeRun` calls race on one run. The hint gets this long to move the run
 * out of `pending`; after that the worker treats the run as never started.
 *
 * This delay is a DE-DUPLICATION window, not the durability mechanism — the ROW
 * is. If the process dies at any point, the row is still there and still due.
 * It is short (an order of magnitude under the orphan sweeper's 120s grace)
 * because "eventual start" should mean seconds, not minutes.
 */
export const DISPATCH_OUTBOX_HINT_GRACE_MS = 10_000;

export async function insertRunWithStartContext(
  storage: Storage,
  run: RunRecord,
  ctx?: Partial<RunStartContext> & {
    /** ADR 0474 — the definition this run was created against; stamps
     *  `run.metadata.definitionRevision` (the lifecycle-stripped content
     *  hash) so replay/`:fork`/resume can re-resolve the EXACT definition.
     *  Never overwrites (a fork-copied pin is preserved verbatim). */
    definition?: WorkflowDefinition;
    /**
     * ADR 0551 P1 — this run is ACCEPTED WORK: the caller is about to promise a
     * start (a `201`, a scheduled fire) and will kick the in-process wakeup
     * hint. Appends a dispatch-outbox row in the SAME atomic storage operation
     * as the run insert, so the promise survives losing this process.
     *
     * Set it only where the run's definition is re-resolvable from the catalog
     * or its pinned revision (`resolveRunDefinition`) — the durable worker has
     * nothing but the run record to work from, so a run started against an
     * ad-hoc in-memory definition (the workflow-debug lane) must NOT enqueue;
     * it would be re-dispatched against the wrong definition.
     */
    enqueueDispatch?: boolean;
    /**
     * ADR 0549 H56 — the caller holds an HTTP `Idempotency-Key` claim for this
     * run: commit it `completed` in the SAME storage transaction as the run
     * insert (see `InsertRunOptions.idempotencyCommit`). Passed through
     * verbatim; this seam adds nothing to it — it exists so that a caller
     * cannot insert the run in one write and commit the ledger in another,
     * which is the two-window duplicate H56 closes.
     */
    idempotencyCommit?: InsertRunOptions['idempotencyCommit'];
  },
): Promise<void> {
  if (ctx?.definition && (run.metadata as Record<string, unknown> | undefined)?.definitionRevision === undefined) {
    run.metadata = { ...(run.metadata ?? {}), definitionRevision: revisionHashOf(ctx.definition) };
  }
  // ADR 0099 Phase 2 — derive the attributed agent (for per-agent lossy opt-in)
  // from the run's own attribution block, via the shared convention reader.
  // `agentProfile` is keyed by ROSTER id (upsertAgentProfile(tenantId, rosterId)),
  // so the rosterId is the profile-lookup key.
  // version-negotiation.md §Engine version -- the WRITER's version, at write
  // time, unconditionally: a fork's row is written now, by this engine, so a
  // parent-copied value would describe the wrong writer. (Contrast
  // `definitionRevision` above, which is a pin and must NOT be overwritten.)
  run.metadata = { ...(run.metadata ?? {}), engineVersion: CURRENT_ENGINE_VERSION };
  const attribution = extractRunAttribution(run.metadata);
  const agentId = ctx?.agentId ?? attribution?.rosterId;
  run.metadata = await stampRunStartContext(run.metadata, {
    tenantId: ctx?.tenantId ?? run.tenantId,
    ...(agentId ? { agentId } : {}),
    // ADR 0604 (TOCWF-1) — forwarded so a per-run-decision contributor can tell
    // a fresh metadata blob from a `:fork`-copied one. See RunStartContext.
    ...(ctx?.derivedFromRun ? { derivedFromRun: true } : {}),
  });
  const opts: InsertRunOptions = {
    ...(ctx?.enqueueDispatch ? { dispatchOutbox: { nextAttemptAt: Date.now() + DISPATCH_OUTBOX_HINT_GRACE_MS } } : {}),
    ...(ctx?.idempotencyCommit ? { idempotencyCommit: ctx.idempotencyCommit } : {}),
  };
  await storage.insertRun(run, Object.keys(opts).length > 0 ? opts : undefined);
}
