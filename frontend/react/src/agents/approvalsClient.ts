/**
 * Approval-inbox client — the "agents propose, humans dispose" queue.
 *
 *   GET  /v1/host/openwop-app/approvals[?status=pending]   — the queue
 *   POST /v1/host/openwop-app/approvals/{id}/claim          — sign off + start the run
 *   POST /v1/host/openwop-app/approvals/{id}/reject         — dismiss the proposal
 *
 * Tenant scoping is the backend's job (caller's principal); the client never
 * sends a tenantId.
 */

import { authedHeaders, config, fetchOpts } from '../client/config.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** A source the action's draft was derived from (citation chip on the card). */
export interface AssistantSourceRef {
  kind: string;
  externalId: string;
  url?: string;
  /** ADR 0027 — the RFC 0021 trust vocabulary; `'untrusted'` ⇒ provider-derived. */
  contentTrust?: 'trusted' | 'untrusted';
}

/** The rich card metadata for an assistant-action approval — the typed
 *  PendingAction projected by the backend onto the approval row so the inbox
 *  renders risk tier, taint, citations, recipient diff, and the draft. */
export interface AssistantActionView {
  actionId: string;
  kind: string;
  draft: string;
  status: string;
  payload?: Record<string, unknown>;
  riskLevel?: 'low' | 'medium' | 'high';
  requiredScopes?: string[];
  reason?: string;
  sourceRefs?: AssistantSourceRef[];
  recipientDiff?: { before: string[]; after: string[] };
  derivedFromUntrusted?: boolean;
  editedAt?: string;
}

export interface PendingApproval {
  approvalId: string;
  rosterId: string;
  persona: string;
  workflowId: string;
  /** Discriminator; absent ⇒ 'run-proposal' (back-compat). */
  kind?: 'run-proposal' | 'assistant-action' | 'content-publish';
  /** Set for assistant-action approvals — the typed draft this gate decides. */
  actionId?: string;
  /** Set for content-publish approvals (ADR 0066) — the CMS page this gate
   *  publishes on claim / returns to draft on reject. */
  orgId?: string;
  pageId?: string;
  pageTitle?: string;
  /** Embedded card metadata for assistant-action rows (null if the action
   *  vanished). Absent for run-proposals. */
  action?: AssistantActionView | null;
  boardId?: string;
  cardId?: string;
  cardTitle?: string;
  proposal: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
  runId?: string;
  note?: string;
}

const base = `${config.baseUrl}/v1/host/openwop-app/approvals`;
const assistantBase = `${config.baseUrl}/v1/host/openwop-app/assistant`;
const jsonHeaders = (): HeadersInit => authedHeaders({ 'content-type': 'application/json' });

export async function listApprovals(status?: ApprovalStatus): Promise<PendingApproval[]> {
  const url = status ? `${base}?status=${encodeURIComponent(status)}` : base;
  const res = await fetch(url, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw new Error(`listApprovals returned ${res.status}`);
  return ((await res.json()) as { items: PendingApproval[] }).items;
}

/** Affirmative sign-off. For a run-proposal this starts the proposed run and
 *  returns its `runId`; for an assistant-action it decides the action through
 *  the shared approval loop and returns `{ actionId, status }` (NO runId — the
 *  caller must not navigate to a run). The response is polymorphic on the
 *  approval kind, so both fields are optional. */
export async function claimApproval(
  approvalId: string,
  note?: string,
): Promise<{ runId?: string; actionId?: string; status?: string }> {
  const res = await fetch(`${base}/${encodeURIComponent(approvalId)}/claim`, fetchOpts({
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify(note ? { note } : {}),
  }));
  if (!res.ok) throw new Error(`claimApproval returned ${res.status}`);
  return (await res.json()) as { runId?: string; actionId?: string; status?: string };
}

/** Edit a still-pending assistant-action draft (ADR 0023 §12 T4). The edit
 *  stamps `editedAt` and the action faces the approver again before any
 *  execution; kind/sources/taint are immutable server-side. */
export async function editAssistantAction(actionId: string, patch: { draft: string }): Promise<void> {
  const res = await fetch(`${assistantBase}/pending-actions/${encodeURIComponent(actionId)}`, fetchOpts({
    method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch),
  }));
  if (!res.ok) throw new Error(`editAssistantAction returned ${res.status}`);
}

/** Dismiss the proposal; the card is parked in the board's terminal column. */
export async function rejectApproval(approvalId: string, note?: string): Promise<void> {
  const res = await fetch(`${base}/${encodeURIComponent(approvalId)}/reject`, fetchOpts({
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify(note ? { note } : {}),
  }));
  if (!res.ok) throw new Error(`rejectApproval returned ${res.status}`);
}
