/**
 * ADR 0474 — the ONE re-resolve helper for a run's definition.
 *
 * A run created against a revisioned definition carries
 * `run.metadata.definitionRevision` (stamped by `insertRunWithStartContext`).
 * Replay/`:fork`/resume MUST re-execute against exactly that content — the
 * head may have moved since. Resolution order:
 *
 *   1. the PINNED revision row, when the run is stamped and the row survives;
 *   2. the catalog funnel by id (legacy runs, pruned revisions, and the three
 *      documented insert-seam bypasses) — exactly the pre-ADR-0474 behavior,
 *      so this helper is a strictly monotone improvement.
 *
 * `resolvedFrom` makes the honesty visible: surfaces that re-resolve tell the
 * user whether they got the as-run definition or today's head.
 *
 * ADR 0823 D3 — `relaunch`: a lane that MINTS a new run from an existing one
 * (`:fork`, redrive) re-authorizes it like a launch, BEFORE either branch — a run
 * may only be copied into executing a workflow its tenant may run (a run minted
 * through the pre-0823 hole resolves to `null`, the caller's existing not-found).
 * A CONTINUATION of the same run (resume, interrupt resume, the dispatch sweeper)
 * passes no `relaunch`: it was authorized when it was created, and it carries no
 * principal to re-check an operator's launch against.
 */

import type { RunRecord } from '../types.js';
import type { WorkflowDefinition } from '../executor/types.js';
import { getRevision } from './workflowRevisions.js';
import { isWorkflowForeignTo } from './workflowOwnership.js';
import { assertWorkflowFeatureLaunchable, type LaunchSubject } from './workflowFeatureGate.js';

export interface ResolvedRunDefinition {
  definition: WorkflowDefinition;
  resolvedFrom: 'revision' | 'head';
}

export async function resolveRunDefinition(
  run: RunRecord,
  catalog: { getWorkflow(workflowId: string): Promise<{ workflowId: string; definition: WorkflowDefinition } | null> },
  opts: { relaunch?: { operator: boolean; subject?: LaunchSubject } } = {},
): Promise<ResolvedRunDefinition | null> {
  if (opts.relaunch && !opts.relaunch.operator && await isWorkflowForeignTo(run.tenantId, run.workflowId)) return null;
  const resolved = await resolveRunDefinitionInner(run, catalog);
  // ADR 0820 §7 / G6 — a RELAUNCH mints a new run, so it passes the owning-feature
  // gate like a launch (typed throw, nothing minted). A continuation of the same
  // run (resume, interrupt resume, the sweeper) does not: an in-flight run
  // finishes past its gate (strategy §6 "Downgrade: running workflows").
  if (resolved && opts.relaunch) {
    await assertWorkflowFeatureLaunchable(run.tenantId, run.workflowId, resolved.definition, opts.relaunch.subject);
  }
  return resolved;
}

async function resolveRunDefinitionInner(
  run: RunRecord,
  catalog: { getWorkflow(workflowId: string): Promise<{ workflowId: string; definition: WorkflowDefinition } | null> },
): Promise<ResolvedRunDefinition | null> {
  const pinned = (run.metadata as Record<string, unknown> | undefined)?.definitionRevision;
  if (typeof pinned === 'string' && pinned.length > 0) {
    const row = await getRevision(run.workflowId, pinned);
    if (row) return { definition: row.definition, resolvedFrom: 'revision' };
  }
  const wf = await catalog.getWorkflow(run.workflowId);
  return wf ? { definition: wf.definition, resolvedFrom: 'head' } : null;
}
