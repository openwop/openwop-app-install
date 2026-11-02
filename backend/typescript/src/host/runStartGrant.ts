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

/**
 * ADR 0975 D11 — grants are NAMED, several per workflow id. The conversation
 * workflow is the host's one chat, so more than one feature may need to admit a
 * conversation scoped to ITS OWN agent (the Challenge Author for an operator,
 * KickBot for a participant). Each grant stamps its own name and its follow-up
 * predicate accepts only its own stamp, so two grants never admit each other's
 * runs. A second, DIFFERENT predicate under the same name is still a boot bug.
 */
const grants = new Map<string, Map<string, RunStartGrant>>();

/** Register the start predicate `name` for runs of `workflowIds`. */
export function registerRunStartGrant(workflowIds: readonly string[], name: string, grant: RunStartGrant): void {
  for (const id of workflowIds) {
    const named = grants.get(id) ?? new Map<string, RunStartGrant>();
    if (named.has(name) && named.get(name) !== grant) throw new Error(`run start grant ${name} for ${id} is already registered`);
    named.set(name, grant);
    grants.set(id, named);
  }
}

/** The first stamp a registered grant admits this start with (registration
 *  order), else null. A grant that throws refuses; the next is still asked. */
export async function runStartGrantFor(req: Request, start: RunStartRequest): Promise<RunStartStamp | null> {
  for (const [name, grant] of grants.get(start.workflowId) ?? []) {
    try {
      const stamp = await grant(req, start);
      if (stamp && typeof stamp.grant === 'string' && stamp.grant.length > 0) return stamp;
    } catch (err) {
      log.warn('run_start_grant_failed', { workflowId: start.workflowId, grant: name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return null;
}

/** Test seam: forget every registration. */
export function resetRunStartGrantsForTests(): void {
  grants.clear();
}
