/**
 * Thin client for `/host/openwop-app/workflows`. The Run button calls
 * `register()` to ensure the catalog can resolve the workflowId, then
 * dispatches `POST /v1/runs` through the normal runs client.
 */

import { getWorkflowDefinitionRaw } from '../../client/workflowsClient.js';
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

interface RegisterBody {
  workflowId: string;
  /** ADR 0440 P1 — MUST be supplied by every caller. The route replaces the
   *  definition wholesale, so a POST without metadata ERASES it (walkthrough
   *  flags, handoff gates, retention, deferred-param aliases, chain
   *  provenance). Compose it with `definitionMetadataFor(wf)`. */
  metadata?: Record<string, unknown>;
  /** ADR 0197 — JSON Schema for the run-input form (validated + preserved
   *  by the backend's workflowDefinitionValidation). */
  inputSchema?: Record<string, unknown>;
  variables?: unknown;
  configurableSchema?: unknown;
  nodes: ReadonlyArray<{
    nodeId: string;
    typeId: string;
    config?: Record<string, unknown>;
    /** Pinned per-port input values. Runtime-safe today only because every call
     *  site spreads `{...def}` (TS skips excess-property checks on spreads) —
     *  but this type is the one a future author reads as the contract, and an
     *  omission here is how the field gets dropped next time. */
    inputs?: Record<string, unknown>;
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
  const res = await fetch(`${config.baseUrl}/host/openwop-app/workflows`, fetchOpts({
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
 * `GET /workflows/{workflowId}`, major-2 client). Returns the canonical
 * WorkflowDefinition, or null when it is not found. Lets the builder open a workflow that lives only server-side — e.g. one
 * authored by the Workflow Architect (ADR 0073) — not just localStorage ones.
 */
export async function fetchRegisteredWorkflow(workflowId: string): Promise<unknown | null> {
  return getWorkflowDefinitionRaw(workflowId);
}
