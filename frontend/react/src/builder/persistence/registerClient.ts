/**
 * Thin client for `/v1/host/openwop-app/workflows`. The Run button calls
 * `register()` to ensure the catalog can resolve the workflowId, then
 * dispatches `POST /v1/runs` through the normal runs client.
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';

interface RegisterBody {
  workflowId: string;
  nodes: ReadonlyArray<{
    nodeId: string;
    typeId: string;
    config?: Record<string, unknown>;
    /** RFC 0065 — author hint forwarded to the BE workflow-definition
     *  row so consumers can pick the canonical artifact deterministically.
     *  Advisory; engine ignores the value. */
    outputRole?: 'primary' | 'secondary';
  }>;
  edges?: ReadonlyArray<{
    edgeId: string;
    sourceNodeId: string;
    targetNodeId: string;
    sourceOutput?: string;
    targetInput?: string;
    triggerRule?: string;
    condition?: { path: string; op: string; value?: unknown };
    label?: string;
  }>;
}

export async function registerWorkflow(body: RegisterBody): Promise<{ workflowId: string; nodeCount: number }> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/workflows`, fetchOpts({
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  }));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`register_workflow_failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<{ workflowId: string; nodeCount: number }>;
}

/**
 * Fetch a server-registered workflow definition by id (the spec
 * `GET /v1/workflows/:id`). Returns the canonical WorkflowDefinition, or null on
 * 404. Lets the builder open a workflow that lives only server-side — e.g. one
 * authored by the Workflow Architect (ADR 0073) — not just localStorage ones.
 */
export async function fetchRegisteredWorkflow(workflowId: string): Promise<unknown | null> {
  const res = await fetch(`${config.baseUrl}/v1/workflows/${encodeURIComponent(workflowId)}`, fetchOpts({
    headers: authedHeaders(),
  }));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`load_workflow_failed (${res.status})`);
  return res.json();
}
