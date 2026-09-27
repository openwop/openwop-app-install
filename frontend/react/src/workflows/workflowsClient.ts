/**
 * Neutral workflows-list client (ADR 0163 Phase 6).
 *
 * The caller's tenant-scoped workflows (the Phase 1 ownership index,
 * `GET /host/openwop-app/workflows`). Lives here — not in the builder's
 * `backendStore` — so the builder, the agent portfolio editor, and the project
 * workflows tab all share ONE workflow-list client without cross-area coupling
 * (architect review R-extract). `backendStore.listWorkflows` delegates to this.
 */

import { getWorkflowDefinitionRaw } from '../client/workflowsClient.js';
import { assertSynced, authedHeaders, config, fetchOpts } from '../client/config.js';

export interface WorkflowSummaryDTO {
  workflowId: string;
  name: string;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
  /** ADR 0369 — present only on unpromoted builder drafts (never listed by default). */
  transient?: boolean;
  /** ADR 0369 — present when archived (listed only with `includeArchived`). */
  archivedAt?: string;
  publishedRevision?: string;
  publishedBehindHead?: boolean;
  /** ADR 0596 (`WFAU-2`) — present when a MODEL authored this workflow. Host-
   *  stamped on the write choke, denormalized onto the ownership row (the only
   *  thing this list projects from), and sticky across later human saves. */
  authoredVia?: string;
  /** ADR 0482 — present only when the owner set a daily budget. */
  budget?: { dailyUsd: number; hardCap: boolean };
  /** ADR 0482 — today's folded spend (present only beside `budget`; includes
   *  debug/eval spend — the counter is money-truth, never segmented). */
  spentTodayUsd?: number;
}

/** The caller's owned workflows (scoped + IDOR-safe on the backend). Throws on
 *  a non-OK response; callers add their own fallback where needed. */
export async function listWorkflowSummaries(opts: { includeArchived?: boolean } = {}): Promise<WorkflowSummaryDTO[]> {
  const qs = opts.includeArchived ? '?includeArchived=true' : '';
  const res = await fetch(`${config.baseUrl}/host/openwop-app/workflows${qs}`, fetchOpts({ headers: authedHeaders() }));
  // ADR 0434 — MUST be the typed `SyncFailureError`, not a plain Error: callers
  // distinguish "server refused" from "offline" via `isOfflineError`, and a
  // plain Error reads as offline, which is what let a 401/429 silently render
  // device-local drafts as the account's workflow list.
  await assertSynced(res);
  return ((await res.json()) as { workflows: WorkflowSummaryDTO[] }).workflows;
}

/** ADR 0369 lifecycle verbs. Non-OK throws with the server's error `reason`
 *  in the message (`workflow_referenced`, `workflow_untested`) so callers can
 *  localize by reason instead of parroting the English server string. */
async function lifecycleVerb(workflowId: string, verb: 'archive' | 'unarchive' | 'promote'): Promise<void> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/workflows/${encodeURIComponent(workflowId)}/${verb}`,
    fetchOpts({ method: 'POST', headers: authedHeaders() }),
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { details?: { reason?: string } } | undefined;
    throw new Error(body?.details?.reason ?? `${verb}_${res.status}`);
  }
}
export const archiveWorkflow = (id: string): Promise<void> => lifecycleVerb(id, 'archive');
export const unarchiveWorkflow = (id: string): Promise<void> => lifecycleVerb(id, 'unarchive');
export const promoteWorkflow = (id: string): Promise<void> => lifecycleVerb(id, 'promote');

/** ADR 0474 — the run-detail revision chip read (owner-gated host-ext).
 *  ADR 0475 extends the same read into the run PROVENANCE surface: the
 *  launch/debug/redrive stamps the normative RunSnapshot omits. */
export interface RunRevisionInfo {
  runId: string;
  workflowId: string;
  definitionRevision?: string;
  definitionResolvedFrom?: string;
  headMoved?: boolean;
  launch?: 'draft';
  launchResolved?: string;
  debug?: { fromNodeId?: string; mode?: string; pinnedNodes?: string[] };
  redriveOf?: string;
}

export async function getRunRevision(runId: string): Promise<RunRevisionInfo | null> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/runs/${encodeURIComponent(runId)}/revision`,
    fetchOpts({ headers: authedHeaders() }),
  );
  if (!res.ok) return null; // fail-soft: the chip is contextual, never blocking
  return (await res.json()) as RunRevisionInfo;
}

/** ADR 0474 — one row of a workflow's revision history. */
export interface WorkflowRevisionRow {
  revisionHash: string;
  createdAt: string;
  name?: string;
  nodeCount: number;
  supersedes?: string;
  createdBy?: string;
  published: boolean;
  isHead: boolean;
}

/** ADR 0474 — the owner-gated revision history (newest first, capped 100). */
export async function listWorkflowRevisions(workflowId: string): Promise<WorkflowRevisionRow[]> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/workflows/${encodeURIComponent(workflowId)}/revisions`,
    fetchOpts({ headers: authedHeaders() }),
  );
  if (!res.ok) throw new Error(`revisions_${res.status}`);
  return ((await res.json()) as { items: WorkflowRevisionRow[] }).items;
}

/** ADR 0474 — restore a prior revision as the new head (append-only history;
 *  the response discloses removed nodes that runs had recorded, mirroring the
 *  builder-save contract). */
export async function rollbackWorkflow(workflowId: string, revisionHash: string): Promise<{ removedReferencedNodeIds?: string[] }> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/workflows/${encodeURIComponent(workflowId)}/rollback`,
    fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ revisionHash }) }),
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { details?: { reason?: string } } | undefined;
    throw new Error(body?.details?.reason ?? `rollback_${res.status}`);
  }
  return (await res.json()) as { removedReferencedNodeIds?: string[] };
}

/** ADR 0482 — a workflow's daily budget (null when unset). */
export interface WorkflowBudgetInfo {
  dailyUsd: number;
  hardCap: boolean;
  updatedAt: string;
}

/** ADR 0482 — the owner-gated budget read: the budget (null when unset) +
 *  today's folded spend. Throws on non-OK (the dialog surfaces it). */
export async function getWorkflowBudget(workflowId: string): Promise<{ budget: WorkflowBudgetInfo | null; spentTodayUsd: number }> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/workflows/${encodeURIComponent(workflowId)}/budget`,
    fetchOpts({ headers: authedHeaders() }),
  );
  if (!res.ok) throw new Error(`budget_get_${res.status}`);
  return (await res.json()) as { budget: WorkflowBudgetInfo | null; spentTodayUsd: number };
}

/** ADR 0482 — set the daily budget. Validation mirrors the server's
 *  (dailyUsd finite > 0); a 400 surfaces as `budget_put_400`. */
export async function putWorkflowBudget(workflowId: string, input: { dailyUsd: number; hardCap: boolean }): Promise<WorkflowBudgetInfo> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/workflows/${encodeURIComponent(workflowId)}/budget`,
    fetchOpts({ method: 'PUT', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(input) }),
  );
  if (!res.ok) throw new Error(`budget_put_${res.status}`);
  return ((await res.json()) as { budget: WorkflowBudgetInfo }).budget;
}

/** ADR 0482 — clear the budget (`dailyUsd: null` is the server's clear form). */
export async function clearWorkflowBudget(workflowId: string): Promise<void> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/workflows/${encodeURIComponent(workflowId)}/budget`,
    fetchOpts({ method: 'PUT', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ dailyUsd: null }) }),
  );
  if (!res.ok) throw new Error(`budget_clear_${res.status}`);
}

/** One declared run input of a workflow — the `variables[]` contract Phase 1 lifts
 *  from a chain's `parameters` (workflow-definition.schema.json). A run supplies
 *  values for these via `POST /v1/runs.inputs`; a `required` variable with no
 *  `defaultValue` must be answered before the run can start. */
export interface RunVariable {
  name: string;
  /** JSON-Schema type hint (string / number / integer / boolean / …); absent ⇒ string. */
  type?: string;
  description?: string;
  required: boolean;
  defaultValue?: unknown;
}

/** The workflow's declared run inputs (`definition.variables`), via the spec
 *  endpoint `GET /workflows/{workflowId}` on the major-2 client (ADR 0730 C.4).
 *  Returns `[]` when the workflow declares none (a zero-input workflow runs
 *  directly), and also when the workflow is gone — a missing definition and a
 *  definition with no variables lead to the same UI, a plain run. Any other
 *  failure throws so the caller can fall back. */
export async function getWorkflowRunInputs(workflowId: string): Promise<RunVariable[]> {
  const def = await getWorkflowDefinitionRaw(workflowId);
  return def && Array.isArray(def.variables) ? (def.variables as RunVariable[]) : [];
}
