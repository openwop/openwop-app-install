/**
 * Workflow-definition reads (ADR 0378 P2a) — a thin wrapper over the SDK's
 * `workflows.get` (the spec `GET /v1/workflows/{workflowId}`, which returns the
 * stored definition verbatim). The walkthrough steps panel fetches the def ONCE
 * per launch to derive the full step list + position; the parse is defensive
 * (the SDK types the response `unknown`) and a failure yields `null` — position
 * simply stays unknown, never blocking the walkthrough.
 */
import { WopError } from '@openwop/openwop';
import { getSdkClient } from './runsClient.js';
import { isNotFoundCode, normalizeErrorCode } from './v2Wire.js';

/**
 * The stored workflow definition, verbatim, through the major-2 SDK client
 * (`GET /workflows/{workflowId}`). Returns `null` on a not-found rather than
 * throwing, because every caller degrades to a reduced UI instead of an error.
 *
 * ADR 0730 C.4 — this is the ONE owner of the definition read for the SPA.
 * Four call sites each held their own `fetch(\`${config.baseUrl}/v1/workflows/…\`)`
 * and each wanted a different slice of the same document (`variables`,
 * `inputSchema`, `nodes`, the whole thing). Four raw v1 fetches is four places
 * that must be re-pointed at every wire move, and the v1 spelling of this
 * operation is on the retirement clock; one owner is one edit.
 *
 * A not-found arrives two ways and BOTH are real: `WopError.status === 404`
 * from the transport, and the major-2 error alias, where `run_not_found` and
 * `workflow_not_found` both collapse to the single code `not_found`
 * (`isNotFoundCode`). Testing only the status would let an aliased envelope
 * escape as a thrown error to callers written to expect `null`.
 */
export async function getWorkflowDefinitionRaw(workflowId: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = (await getSdkClient().workflows.get(workflowId)) as unknown;
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  } catch (err) {
    if (err instanceof WopError && (err.status === 404 || isNotFoundCode(err.envelope ? normalizeErrorCode(err.envelope.error) : undefined))) return null;
    throw err;
  }
}

export interface WorkflowDefNode {
  nodeId: string;
  typeId: string;
  config?: Record<string, unknown>;
}

export async function getWorkflowDefinition(workflowId: string): Promise<{ nodes: WorkflowDefNode[] } | null> {
  try {
    const raw = await getWorkflowDefinitionRaw(workflowId);
    if (!raw || !Array.isArray(raw.nodes)) return null;
    const nodes: WorkflowDefNode[] = [];
    for (const n of raw.nodes as unknown[]) {
      const o = n as Record<string, unknown>;
      if (typeof o.nodeId !== 'string' || typeof o.typeId !== 'string') continue;
      nodes.push({ nodeId: o.nodeId, typeId: o.typeId, ...(o.config && typeof o.config === 'object' ? { config: o.config as Record<string, unknown> } : {}) });
    }
    return { nodes };
  } catch {
    return null; // best-effort — the walkthrough runs fine without a step list
  }
}
