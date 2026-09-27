/**
 * ADR 0477 — the workflow-evaluations client. Separate module (the
 * fleet/debug-client precedent): builder-only surface, kept out of the chat
 * entry chunk.
 */

import { authedHeaders, config, fetchOpts } from '../client/config.js';

const HOST_WF = (workflowId: string): string =>
  `${config.baseUrl}/host/openwop-app/workflows/${encodeURIComponent(workflowId)}`;

export interface EvalAssertionDTO {
  kind: string;
  [k: string]: unknown;
}

export interface EvalCaseDTO {
  caseId: string;
  name?: string;
  inputs?: Record<string, unknown>;
  pins?: Array<{ nodeId: string; output: Record<string, unknown> }>;
  assertions: EvalAssertionDTO[];
}

export interface WorkflowEvalSetDTO {
  workflowId: string;
  evalSetId: string;
  name: string;
  requiredForPromote: boolean;
  /** ADR 0480 — online invariant scoring of production runs. */
  online?: { enabled: boolean; sampleRate?: number; judge?: boolean; assertions: unknown[] };
  cases: EvalCaseDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface EvalCaseResultDTO {
  caseId: string;
  runId: string;
  status: 'running' | 'passed' | 'failed' | 'timed_out';
  assertions: Array<{ kind: string; pass: boolean; detail?: string }>;
}

export interface WorkflowEvalResultDTO {
  workflowId: string;
  evalSetId: string;
  resultId: string;
  revisionHash: string;
  status: 'running' | 'complete' | 'incomplete';
  cases: EvalCaseResultDTO[];
  startedAt: string;
  finishedAt?: string;
}

export async function listEvalSets(workflowId: string): Promise<WorkflowEvalSetDTO[]> {
  const res = await fetch(`${HOST_WF(workflowId)}/eval-sets`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw new Error(`eval_sets_${res.status}`);
  return ((await res.json()) as { items: WorkflowEvalSetDTO[] }).items;
}

/** Create/replace. Server-side validation errors carry the canonical envelope
 *  `message` — surfaced verbatim (they name the offending case/assertion). */
export async function putEvalSet(workflowId: string, evalSetId: string, body: {
  name: string; requiredForPromote?: boolean; cases: EvalCaseDTO[];
}): Promise<void> {
  const res = await fetch(
    `${HOST_WF(workflowId)}/eval-sets/${encodeURIComponent(evalSetId)}`,
    fetchOpts({ method: 'PUT', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body) }),
  );
  if (res.status === 404) throw new Error('eval_set_put_404'); // unsynced draft — localized by the drawer (F6)
  if (!res.ok) {
    const payload = (await res.json().catch(() => undefined)) as { message?: string } | undefined;
    throw new Error(payload?.message ?? `eval_set_put_${res.status}`);
  }
}

export async function deleteEvalSet(workflowId: string, evalSetId: string): Promise<void> {
  const res = await fetch(
    `${HOST_WF(workflowId)}/eval-sets/${encodeURIComponent(evalSetId)}`,
    fetchOpts({ method: 'DELETE', headers: authedHeaders() }),
  );
  if (!res.ok) throw new Error(`eval_set_delete_${res.status}`);
}

export async function runEvalSet(workflowId: string, evalSetId: string): Promise<{ resultId: string; cases: number }> {
  const res = await fetch(
    `${HOST_WF(workflowId)}/eval-sets/${encodeURIComponent(evalSetId)}/run`,
    fetchOpts({ method: 'POST', headers: authedHeaders() }),
  );
  if (!res.ok) {
    // ux-review F2 — the refusal is often NAMED (capability refusal, quota):
    // surface the envelope message; fall back to the typed code.
    const payload = (await res.json().catch(() => undefined)) as { message?: string } | undefined;
    throw new Error(payload?.message ?? `eval_run_${res.status}`);
  }
  return (await res.json()) as { resultId: string; cases: number };
}

export async function listEvalResults(workflowId: string, evalSetId?: string): Promise<WorkflowEvalResultDTO[]> {
  const qs = evalSetId ? `?evalSetId=${encodeURIComponent(evalSetId)}` : '';
  const res = await fetch(`${HOST_WF(workflowId)}/eval-results${qs}`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw new Error(`eval_results_${res.status}`);
  return ((await res.json()) as { items: WorkflowEvalResultDTO[] }).items;
}

/** ADR 0480 — one day's online-eval counts (counts + opaque run refs only). */
export interface OnlineEvalBucketDTO {
  day: string;
  evaluated: number;
  passed: number;
  failed: number;
  judged: number;
  judgeSkipped: number;
  sampledOut: number;
  failures: Array<{ runId: string; failedKinds: string[]; at: string }>;
}

export async function listOnlineBuckets(workflowId: string, evalSetId: string): Promise<OnlineEvalBucketDTO[]> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/workflows/${encodeURIComponent(workflowId)}/eval-sets/${encodeURIComponent(evalSetId)}/online`,
    fetchOpts({ headers: authedHeaders() }),
  );
  if (!res.ok) throw new Error(`eval_online_${res.status}`);
  return ((await res.json()) as { items: OnlineEvalBucketDTO[] }).items;
}
