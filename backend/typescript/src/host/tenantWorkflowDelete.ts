/**
 * ADR 0913 (Book AI P1 + P2) — deleting a tenant's workflow, and erasing every
 * workflow and run a feature created for one subject.
 *
 * `deleteTenantWorkflow` is the recipe the tenant `DELETE
 * /host/openwop-app/workflows/:id` route ran inline, moved here unchanged so
 * trusted server code (a feature's own teardown) can run the SAME rules instead
 * of a copy that drifts. Authorization is the caller's: the route checks
 * `requireWorkflowWrite` first, and a feature calls this from its own
 * already-authorized delete path.
 *
 * `eraseWorkflowSubject` is the feature seam. A feature that instantiated
 * chains with `from-chain { subject }` passes the same label back, and the host:
 *   1. refuses under a tenant legal hold (ADR retention hold), deleting nothing;
 *   2. for each owned workflow carrying the label, cancels then deletes its runs
 *      (an index-backed `listRuns({tenantId, workflowId})`; no tenant scan);
 *   3. deletes the workflow through `deleteTenantWorkflow`.
 * It reports what it deleted and what it could not, so the caller can tell the
 * person the truth (`complete: false` names the reason per workflow).
 */

import type { Storage } from '../storage/storage.js';
import type { RunRecord } from '../types.js';
import { deleteRegisteredWorkflow } from './workflowsRegistry.js';
import { getOwned, removeOwnership, isSharedWorkflowId, listOwnedBySubject } from './workflowOwnership.js';
import { hasJobForWorkflow } from './schedulingService.js';
import { workflowRoomLive } from './collab/workflowCollabResource.js';
import { getRetentionHold } from './retentionHold.js';
import { cancelRunAndCascade } from './runCancel.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.tenantWorkflowDelete');

export type TenantWorkflowDeleteRefusal = 'not_owned' | 'workflow_referenced' | 'workflow_scheduled' | 'workflow_room_live';

export type TenantWorkflowDeleteOutcome =
  | { deleted: true; removed: boolean }
  | { deleted: false; reason: TenantWorkflowDeleteRefusal };

export async function deleteTenantWorkflow(storage: Storage, tenantId: string, workflowId: string): Promise<TenantWorkflowDeleteOutcome> {
  // ADR 0163 R2 — only the owning tenant may delete.
  const owned = await getOwned(tenantId, workflowId);
  if (!owned) return { deleted: false, reason: 'not_owned' };
  // ADR 0789 — deleting a SHARED definition removes it from THIS tenant only.
  // The row (and its revisions, which the deletion hooks would cascade by id
  // for every tenant) belongs to every seeded tenant, and the runs the
  // `hasRunForWorkflow` check below sees may be anyone's. The schedule guard
  // still applies: a job of this tenant's firing against it must go first.
  if (isSharedWorkflowId(workflowId)) {
    if (await hasJobForWorkflow(tenantId, workflowId)) return { deleted: false, reason: 'workflow_scheduled' };
    await removeOwnership(tenantId, workflowId);
    return { deleted: true, removed: true };
  }
  // ADR 0369 — runs re-resolve their definition by id at replay/`:fork`
  // (no per-run snapshot), so deleting a referenced definition orphans
  // run history. Refuse and point at archive instead.
  if (await storage.hasRunForWorkflow(workflowId)) return { deleted: false, reason: 'workflow_referenced' };
  // RI-9 — refuse while a schedule fires against this definition.
  if (await hasJobForWorkflow(tenantId, workflowId)) return { deleted: false, reason: 'workflow_scheduled' };
  // ADR 0481 (code-review H2) — deleting under a live room destroys the Y.Doc
  // beneath connected editors.
  if (await workflowRoomLive(workflowId)) return { deleted: false, reason: 'workflow_room_live' };
  const removed = deleteRegisteredWorkflow(workflowId, [tenantId]);
  await removeOwnership(tenantId, workflowId);
  return { deleted: true, removed };
}

export interface WorkflowSubjectErasure {
  /** True only when every labelled workflow and all of its runs are gone. */
  complete: boolean;
  workflowsDeleted: string[];
  runsDeleted: number;
  /** Workflows that remain, and why. `legal_hold` means nothing was touched. */
  refused: Array<{ workflowId: string; reason: TenantWorkflowDeleteRefusal | 'legal_hold' | 'runs_remaining' }>;
}

/** Page size for the per-workflow run sweep, and a ceiling on pages so a
 *  pathological workflow cannot hold the caller forever. 200 × 50 = 10,000 runs
 *  per workflow per call; beyond that the result is `runs_remaining` and a
 *  second call continues. */
const RUN_PAGE = 200;
const MAX_PAGES = 50;

/** Cancel and delete a run and its sub-workflow child runs (depth-first). A
 *  child runs a SHARED sub-chain definition, so it is not found by the parent
 *  workflow's id; it carries the same subject's data, so it goes with the
 *  parent. `deleteRun` does not cascade children (no FK cascade). */
async function deleteRunTree(storage: Storage, tenantId: string, run: RunRecord, reason: string, depth = 0): Promise<number> {
  let n = 0;
  if (depth < 8) {
    for (const child of await storage.listRunsByParent(run.runId)) {
      if (child.tenantId === tenantId) n += await deleteRunTree(storage, tenantId, child, reason, depth + 1);
    }
  }
  // A live run is cancelled first, so its executor stops writing to a row that
  // is about to be deleted.
  await cancelRunAndCascade(storage, run, reason);
  if (await storage.deleteRun(run.runId)) n += 1;
  return n;
}

export async function eraseWorkflowSubject(
  storage: Storage,
  tenantId: string,
  subject: string,
  opts: { reason: string },
): Promise<WorkflowSubjectErasure> {
  const out: WorkflowSubjectErasure = { complete: true, workflowsDeleted: [], runsDeleted: 0, refused: [] };
  const workflows = await listOwnedBySubject(tenantId, subject);
  if (workflows.length === 0) return out;
  if (await getRetentionHold(tenantId)) {
    return { complete: false, workflowsDeleted: [], runsDeleted: 0, refused: workflows.map((w) => ({ workflowId: w.workflowId, reason: 'legal_hold' as const })) };
  }
  for (const w of workflows) {
    let drained = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const runs = await storage.listRuns({ tenantId, workflowId: w.workflowId, limit: RUN_PAGE });
      const mine = runs.filter((r) => r.workflowId === w.workflowId && r.tenantId === tenantId);
      if (mine.length === 0) { drained = true; break; }
      for (const run of mine) out.runsDeleted += await deleteRunTree(storage, tenantId, run, opts.reason);
    }
    if (!drained) {
      out.complete = false;
      out.refused.push({ workflowId: w.workflowId, reason: 'runs_remaining' });
      continue;
    }
    const outcome = await deleteTenantWorkflow(storage, tenantId, w.workflowId);
    if (outcome.deleted) out.workflowsDeleted.push(w.workflowId);
    else { out.complete = false; out.refused.push({ workflowId: w.workflowId, reason: outcome.reason }); }
  }
  log.info('workflow_subject_erased', { tenantId, subject, reason: opts.reason, workflows: out.workflowsDeleted.length, runs: out.runsDeleted, refused: out.refused.length });
  return out;
}
