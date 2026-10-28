/**
 * ADR 0975 D1 — a RUN-scoped way to decide an approval gate, for a caller who does
 * not hold the tenant-wide `approvals:respond` scope.
 *
 * `approvals:respond` is all-or-nothing across a workspace: holding it decides
 * every member's gates there. The KickTodo operator (ADR 0910) is deliberately
 * narrower — authoring and publication only — so its activation carries no
 * `approvals:respond`, and the Challenge Factory's own outline and lesson gates
 * were undecidable by the one person allowed to run it in `host-kicktodo`
 * (measured on kicktodo.com, 2026-10-25: `403 forbidden_scope`).
 *
 * The seam lets a feature admit a decider for gates on runs of ITS OWN workflows,
 * by its own authority predicate, without widening any role. It only ever ADDS a
 * decider for a run the caller can already address (`loadOwnedRun`'s tenant gate
 * still runs first), and an approver ACL on the gate, the quorum rules and the
 * autonomy self-approval refusal all still apply after it.
 *
 * A grant that throws is a refusal, never a pass.
 */
import type { Request } from 'express';
import type { RunRecord } from '../types.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.runApprovalGrant');

export type RunApprovalGrant = (req: Request, run: RunRecord) => Promise<boolean>;

const grants = new Map<string, RunApprovalGrant>();

/** Register the decider predicate for approval gates on runs of `workflowIds`.
 *  One owner per workflow id: a second registration for the same id is a boot bug. */
export function registerRunApprovalGrant(workflowIds: readonly string[], grant: RunApprovalGrant): void {
  for (const id of workflowIds) {
    if (grants.has(id) && grants.get(id) !== grant) throw new Error(`run approval grant for ${id} is already registered`);
    grants.set(id, grant);
  }
}

/** Does a registered grant admit this caller as a decider on `run`'s gates? */
export async function holdsRunApprovalGrant(req: Request, run: RunRecord): Promise<boolean> {
  const grant = grants.get(run.workflowId);
  if (!grant) return false;
  try {
    return (await grant(req, run)) === true;
  } catch (err) {
    log.warn('run_approval_grant_failed', { workflowId: run.workflowId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Test seam: forget every registration. */
export function resetRunApprovalGrantsForTests(): void {
  grants.clear();
}
