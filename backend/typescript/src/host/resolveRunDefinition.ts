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
 */

import type { RunRecord } from '../types.js';
import type { WorkflowDefinition } from '../executor/types.js';
import { getRevision } from './workflowRevisions.js';

export interface ResolvedRunDefinition {
  definition: WorkflowDefinition;
  resolvedFrom: 'revision' | 'head';
}

export async function resolveRunDefinition(
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
