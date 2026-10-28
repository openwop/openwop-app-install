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
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { pinMismatches } from './chainPinRule.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.runInsert');

/** grade-data D-3 — the node pins a definition carries: a chain expansion's
 *  (`expandedFrom.nodePins`, ADR 0766 D3) and a directly submitted definition's
 *  (`nodePins`, D-6). */
function definitionNodePins(def: WorkflowDefinition): Record<string, string> | undefined {
  const meta = def.metadata as { nodePins?: Record<string, string>; expandedFrom?: { nodePins?: Record<string, string> } } | undefined;
  const pins = { ...(meta?.expandedFrom?.nodePins ?? {}), ...(meta?.nodePins ?? {}) };
  return Object.keys(pins).length > 0 ? pins : undefined;
}
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

/**
 * ADR 0941 D2b — a post-insert observer. Fires AFTER `storage.insertRun`
 * commits, for every run created through this seam (fresh starts, `:fork`,
 * redrive and sub-workflow children alike), so a feature can index runs it
 * cares about without core importing it (the `registerRunStartContributor`
 * shape, on the write-after side).
 *
 * Hooks are keyed (a repeated boot overwrites the slot), MUST be idempotent,
 * and are fail-soft: a throw is logged and never fails the insert, which has
 * already committed. A hook must not write `run.metadata` (the row is stored);
 * a decision that belongs on the run is a run-start contributor instead.
 */
export type RunInsertedHook = (run: Readonly<RunRecord>, ctx: { derivedFromRun: boolean }) => Promise<void>;

const runInsertedHooks = new Map<string, RunInsertedHook>();

export function registerRunInsertedHook(key: string, fn: RunInsertedHook): void {
  runInsertedHooks.set(key, fn);
}

async function fireRunInsertedHooks(run: RunRecord, derivedFromRun: boolean): Promise<void> {
  for (const [key, hook] of runInsertedHooks) {
    try {
      await hook(run, { derivedFromRun });
    } catch (err) {
      log.warn('run_inserted_hook_failed', { key, runId: run.runId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

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
    /** ADR 0987 D2 — concurrency admission, counted inside the insert (see
     *  `InsertRunOptions.admission`). A refusal throws `AdmissionRefusedError`
     *  and nothing is written. */
    admission?: InsertRunOptions['admission'];
  },
): Promise<void> {
  if (ctx?.definition && (run.metadata as Record<string, unknown> | undefined)?.definitionRevision === undefined) {
    run.metadata = { ...(run.metadata ?? {}), definitionRevision: revisionHashOf(ctx.definition) };
  }
  // grade-data D-3 — the definition says which node versions it was built
  // against; say so on the run when this host runs a DIFFERENT one, instead of
  // running, forking and exporting it silently. Stamped once, like the revision
  // pin above: a fork keeps its parent's record verbatim. Only node modules
  // already loaded are compared (a pack node resolves lazily; an unloaded one is
  // unknown here, not a mismatch).
  if (ctx?.definition && (run.metadata as Record<string, unknown> | undefined)?.nodePinMismatches === undefined) {
    const registry = getNodeRegistry();
    const mismatches = pinMismatches(definitionNodePins(ctx.definition), (typeId) => registry.get(typeId)?.version);
    if (mismatches.length > 0) {
      run.metadata = { ...(run.metadata ?? {}), nodePinMismatches: mismatches };
      log.warn('run_node_pin_mismatch', { runId: run.runId, workflowId: run.workflowId, mismatches });
    }
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
    // ADR 0942 D4 / D10.4 — lineage, read from the row being inserted (host-written).
    ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
    ...(run.forkMode ? { forkMode: run.forkMode } : {}),
    // ADR 0831 P2 — read-only view of the blob being stamped.
    metadata: run.metadata ?? {},
    // ADR 0943 D2 — read-only, for per-node decisions (agent bindings).
    ...(ctx?.definition ? { definition: ctx.definition } : {}),
    // ADR 0959 D8 — which workflow this run is (the playbook stamp keys on it).
    workflowId: run.workflowId,
  });
  const opts: InsertRunOptions = {
    ...(ctx?.enqueueDispatch ? { dispatchOutbox: { nextAttemptAt: Date.now() + DISPATCH_OUTBOX_HINT_GRACE_MS } } : {}),
    ...(ctx?.idempotencyCommit ? { idempotencyCommit: ctx.idempotencyCommit } : {}),
    ...(ctx?.admission ? { admission: ctx.admission } : {}),
  };
  await storage.insertRun(run, Object.keys(opts).length > 0 ? opts : undefined);
  if (runInsertedHooks.size > 0) await fireRunInsertedHooks(run, ctx?.derivedFromRun === true);
}
