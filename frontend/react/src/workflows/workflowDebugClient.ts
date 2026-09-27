/**
 * ADR 0475 — the workflow debug-loop client (pins / execute-from-step /
 * redrive). A SEPARATE module from workflowsClient deliberately: the chat
 * composer's workflow-mention pipeline imports workflowsClient into the ENTRY
 * chunk, and the debug loop is builder/runs-page territory — splitting keeps
 * the entry-bundle budget honest.
 */

import { authedHeaders, config, fetchOpts } from '../client/config.js';

const HOST_WF = (workflowId: string): string =>
  `${config.baseUrl}/host/openwop-app/workflows/${encodeURIComponent(workflowId)}`;

/** One draft-side debug pin: "when debugging, pretend this node completed
 *  with THIS output". Never read by published/production launches. */
export interface WorkflowDebugPin {
  nodeId: string;
  output: Record<string, unknown>;
  sourceRunId?: string;
  createdAt: string;
}

export async function listDebugPins(workflowId: string): Promise<WorkflowDebugPin[]> {
  const res = await fetch(`${HOST_WF(workflowId)}/pins`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw new Error(`pins_${res.status}`);
  return ((await res.json()) as { items: WorkflowDebugPin[] }).items;
}

export async function putDebugPin(workflowId: string, nodeId: string, output: Record<string, unknown>): Promise<void> {
  const res = await fetch(
    `${HOST_WF(workflowId)}/pins/${encodeURIComponent(nodeId)}`,
    fetchOpts({ method: 'PUT', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ output }) }),
  );
  if (!res.ok) throw new Error(`pin_put_${res.status}`);
}

export async function deleteDebugPin(workflowId: string, nodeId: string): Promise<void> {
  const res = await fetch(
    `${HOST_WF(workflowId)}/pins/${encodeURIComponent(nodeId)}`,
    fetchOpts({ method: 'DELETE', headers: authedHeaders() }),
  );
  if (!res.ok) throw new Error(`pin_delete_${res.status}`);
}

export async function clearDebugPins(workflowId: string): Promise<void> {
  const res = await fetch(`${HOST_WF(workflowId)}/pins`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`pins_clear_${res.status}`);
}

/** Bulk-prefill pins from a settled run's REAL outputs (failed-run→editor).
 *  `unmatched` reports outputs whose nodes no longer exist on the head. */
export async function prefillPinsFromRun(workflowId: string, runId: string): Promise<{ pinned: string[]; unmatched?: string[] }> {
  const res = await fetch(
    `${HOST_WF(workflowId)}/pins/from-run`,
    fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ runId }) }),
  );
  if (!res.ok) throw new Error(`pins_from_run_${res.status}`);
  return (await res.json()) as { pinned: string[]; unmatched?: string[] };
}

/** Execute-from-step. A 422 with `missingPins` names the exact upstream nodes
 *  that still need a pin — surfaced as a typed error so the UI can act. */
export class MissingPinsError extends Error {
  constructor(public readonly missingPins: string[]) {
    super('missing_pins');
    this.name = 'MissingPinsError';
  }
}

export interface DebugRunStart {
  runId: string;
  pinnedNodes: string[];
  skipped: string[];
  executing: string[];
}

export async function startDebugRun(
  workflowId: string,
  fromNodeId: string,
  mode: 'from-here' | 'only' = 'from-here',
  inputs?: Record<string, unknown>,
): Promise<DebugRunStart> {
  const res = await fetch(
    `${HOST_WF(workflowId)}/debug-run`,
    fetchOpts({
      method: 'POST',
      headers: authedHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ fromNodeId, mode, ...(inputs ? { inputs } : {}) }),
    }),
  );
  if (res.status === 422) {
    const body = (await res.json().catch(() => undefined)) as { details?: { missingPins?: string[] } } | undefined;
    throw new MissingPinsError(body?.details?.missingPins ?? []);
  }
  if (!res.ok) throw new Error(`debug_run_${res.status}`);
  return (await res.json()) as DebugRunStart;
}

/** Bulk redrive of terminal failed/cancelled runs — fresh runs on the AS-RUN
 *  revision. Per-run outcome; partial success is explicit, never silent. */
export interface RedriveResult {
  runId: string;
  redriveRunId?: string;
  error?: string;
}

export async function redriveRuns(runIds: string[]): Promise<RedriveResult[]> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/runs/redrive`,
    fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ runIds }) }),
  );
  if (!res.ok) throw new Error(`redrive_${res.status}`);
  return ((await res.json()) as { results: RedriveResult[] }).results;
}
