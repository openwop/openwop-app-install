/**
 * Neutral workflows-list client (ADR 0163 Phase 6).
 *
 * The caller's tenant-scoped workflows (the Phase 1 ownership index,
 * `GET /v1/host/openwop-app/workflows`). Lives here — not in the builder's
 * `backendStore` — so the builder, the agent portfolio editor, and the project
 * workflows tab all share ONE workflow-list client without cross-area coupling
 * (architect review R-extract). `backendStore.listWorkflows` delegates to this.
 */

import { authedHeaders, config, fetchOpts } from '../client/config.js';

export interface WorkflowSummaryDTO {
  workflowId: string;
  name: string;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

/** The caller's owned workflows (scoped + IDOR-safe on the backend). Throws on
 *  a non-OK response; callers add their own fallback where needed. */
export async function listWorkflowSummaries(): Promise<WorkflowSummaryDTO[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/workflows`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw new Error(`list_workflows_${res.status}`);
  return ((await res.json()) as { workflows: WorkflowSummaryDTO[] }).workflows;
}
