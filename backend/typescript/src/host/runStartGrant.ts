/**
 * ADR 0975 D8 — a RUN-START grant: a feature may admit the start of a run of
 * one of ITS workflows for a caller who does not hold the tenant-wide
 * `runs:create`, by its own authority predicate.
 *
 * `runs:create` is all-or-nothing across a workspace. The KickTodo operator
 * (ADR 0910) is deliberately narrower: a viewer member plus `host:kicktodo:manage`
 * and `host:byok:manage` while an activation is live. With authorization
 * enforcement on, that operator could not open the Studio's Challenge Author
 * chat — the only way to start a Challenge Factory run (measured on kicktodo.com,
 * 2026-10-26: `authorization.denied runs:create`).
 *
 * The seam is consulted ONLY when the scope check refused (`POST /runs` keeps
 * every other gate: principal/tenant authorize, residency, the launch gate). An
 * admitted start is STAMPED on the run under `RUN_START_GRANT_METADATA_KEY`, a key
 * callers cannot write (`stripCallerAttribution`), so the feature's follow-up
 * predicates (`runApprovalGrant.ts`) can tell a grant-started run from any other.
 *
 * A grant that throws is a refusal, never a pass.
 */
import type { Request } from 'express';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.runStartGrant');

/** The host-written run-metadata key an admitted start is stamped under. */
export const RUN_START_GRANT_METADATA_KEY = 'openwop-app.startGrant';

export interface RunStartRequest {
  tenantId: string;
  workflowId: string;
  /** The caller's `metadata` as sent (untrusted — the predicate decides what it may mean). */
  metadata: Record<string, unknown>;
}

/** What an admitted start records on the run: which grant, and what it was scoped to. */
export interface RunStartStamp {
  grant: string;
  agentId?: string;
}

export type RunStartGrant = (req: Request, start: RunStartRequest) => Promise<RunStartStamp | null>;

const grants = new Map<string, RunStartGrant>();

/** Register the start predicate for runs of `workflowIds`. One owner per workflow id. */
export function registerRunStartGrant(workflowIds: readonly string[], grant: RunStartGrant): void {
  for (const id of workflowIds) {
    if (grants.has(id) && grants.get(id) !== grant) throw new Error(`run start grant for ${id} is already registered`);
    grants.set(id, grant);
  }
}

/** The stamp when a registered grant admits this start, else null. */
export async function runStartGrantFor(req: Request, start: RunStartRequest): Promise<RunStartStamp | null> {
  const grant = grants.get(start.workflowId);
  if (!grant) return null;
  try {
    const stamp = await grant(req, start);
    return stamp && typeof stamp.grant === 'string' && stamp.grant.length > 0 ? stamp : null;
  } catch (err) {
    log.warn('run_start_grant_failed', { workflowId: start.workflowId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Test seam: forget every registration. */
export function resetRunStartGrantsForTests(): void {
  grants.clear();
}
