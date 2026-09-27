/**
 * Approval-inbox client — the "agents propose, humans dispose" queue.
 *
 *   GET  /host/openwop-app/approvals[?status=pending]   — the queue
 *   POST /host/openwop-app/approvals/{id}/claim          — sign off + start the run
 *   POST /host/openwop-app/approvals/{id}/reject         — dismiss the proposal
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
  kind?: 'run-proposal' | 'assistant-action' | 'content-publish' | 'campaign-spend' | 'commerce-spend' | 'strategy-activation' | 'strategy-checkin' | 'pm-scenario-select';
  /** PMXU-2 (ADR 0590) — pm-scenario-select rows: the scenario the gate adopts
   *  as plan of record on claim / leaves un-adopted on reject. The backend has
   *  always sent this; the client type never declared it, so the reviewer saw
   *  only the free-text proposal string. */
  scenarioSelect?: { listId: string; sessionId: string; scenarioId: string; scenarioName?: string };
  /** Set for strategy-activation approvals (ADR 0230 §B3) — the strategy this
   *  gate activates on claim / leaves draft on reject. */
  strategyId?: string;
  strategyTitle?: string;
  /** campaign-spend rows (campaign gap plan §5B B3): what the spend gate is holding. */
  spendKind?: 'publish' | 'budget' | 'audience' | 'order' | 'refund';
  platform?: string;
  dailyBudgetMinor?: number;
  /** R2 UCP-P2-B1 — commerce-spend rows (an agent about to spend real money) carry
   *  the authorized amount STRUCTURALLY. The backend has always sent these; the
   *  client type never declared them, so the inbox rendered only the prose
   *  `proposal` — and that prose was built with a hardcoded `/100`, i.e. the one
   *  figure an approver saw was 100× wrong for a zero-decimal currency. A
   *  structured amount cannot drift from the charge the way a sentence can. */
  amountMinor?: number;
  amountCurrency?: string;
  /** Set for assistant-action approvals — the typed draft this gate decides. */
  actionId?: string;
  /** Set for content-publish approvals (ADR 0066) — the CMS page this gate
   *  publishes on claim / returns to draft on reject. */
  orgId?: string;
  pageId?: string;
  pageTitle?: string;
  /** ADR 0593 D4 (CMSAU-1/CMSAU-18) — the page version the review is PINNED to.
   *  The backend has always carried it; the client type never declared it, so
   *  the reviewer could not be told which version they were signing off on. */
  pageVersion?: number;
  /** ADR 0593 D4 (CMSAU-4) — locales carrying machine-drafted overlays, derived
   *  from the durable `aiDrafted` stamps at queue AND repin time. The only
   *  provenance a reviewer used to see was an English sentence rebuilt from one
   *  submit's sweep, which emptied itself on the first resubmit. */
  aiDraftedLocales?: string[];
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
  /** SGU-1 (ADR 0230 §B3) — the deciding subject (opaque principal id), stamped
   *  server-side at resolve (approvalService `resolveApproval`, ADR 0592 §8). The
   *  backend has always sent it on resolved rows; the client type never declared
   *  it, so no decide surface could show WHO signed off a governance gate. Absent
   *  on legacy rows and on system/agent-resolved decisions. Name-resolve it
   *  before display — never render the raw `user:<hash>` on screen. */
  decidedBy?: string;
  runId?: string;
  note?: string;
}

/**
 * ADR 0593 D3 (CMSAU-2) — a typed API error carrying the envelope's stable
 * `error` CODE + `details`, mirroring `CmsApiError` (ADR 0592 §1/§6).
 *
 * Every non-2xx used to become `new Error(\`claimApproval returned ${res.status}\`)`,
 * discarding body, code and details — so the approval gate's single most
 * important safeguard, the stale-review 409, reached both inboxes as the raw
 * dev string `claimApproval returned 409`, while the CMS header (which DOES
 * parse the envelope) showed a different message for the same decision. Two
 * decide surfaces disagreeing about what just happened.
 */
export class ApprovalApiError extends Error {
  constructor(
    message: string,
    /** The envelope's stable error code (`conflict`, `not_found`, …) or null. */
    public readonly code: string | null,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApprovalApiError';
  }
}

/**
 * ADR 0593 D3 — map a KNOWN decide failure to a `notifications`-namespace i18n
 * key, so BOTH inboxes and the CMS header render the SAME localized sentence
 * for the same backend state. Conservative like `cmsErrorInfo`: an unmapped
 * code returns null and the caller keeps the backend's raw message, which is
 * more specific than any generic string would be.
 *
 * The `details.reason` discriminator is what makes this possible — the backend
 * already ships `stale_review` / `review_closed` / `unpinned_review`
 * structurally, and a code alone (`conflict`) could not tell them apart.
 */
export function approvalErrorInfo(e: unknown): { key: string; options?: Record<string, unknown> } | null {
  if (!(e instanceof ApprovalApiError)) return null;
  const reason = typeof e.details?.reason === 'string' ? e.details.reason : null;
  if (reason === 'stale_review') return { key: 'approvalStaleReview' };
  if (reason === 'unpinned_review') return { key: 'approvalUnpinnedReview' };
  if (reason === 'review_closed') {
    return e.details?.subject === 'deleted'
      ? { key: 'approvalClosedPageDeleted' }
      : { key: 'approvalClosedNotInReview', options: { status: String(e.details?.status ?? '') } };
  }
  if (e.code === 'forbidden_scope') return { key: 'approvalForbidden' };
  if (e.code === 'not_found') return { key: 'approvalGone' };
  if (e.code === 'conflict') return { key: 'approvalAlreadyDecided' };
  return null;
}

/** Parse a failed response into `ApprovalApiError` — the ONE place a non-2xx
 *  becomes an error, so no lane can regress to a status-code string. */
async function throwApiError(res: Response, ctx: string): Promise<never> {
  let code: string | null = null;
  let message = '';
  let details: Record<string, unknown> | undefined;
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown; details?: unknown };
    if (typeof body?.error === 'string') code = body.error;
    if (typeof body?.message === 'string') message = body.message;
    if (body?.details && typeof body.details === 'object') details = body.details as Record<string, unknown>;
  } catch { /* non-JSON */ }
  throw new ApprovalApiError(message || `${ctx} returned ${res.status}`, code, res.status, details);
}

const base = `${config.baseUrl}/host/openwop-app/approvals`;
const assistantBase = `${config.baseUrl}/host/openwop-app/assistant`;
const jsonHeaders = (): HeadersInit => authedHeaders({ 'content-type': 'application/json' });

export async function listApprovals(status?: ApprovalStatus): Promise<PendingApproval[]> {
  const url = status ? `${base}?status=${encodeURIComponent(status)}` : base;
  const res = await fetch(url, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) await throwApiError(res, 'listApprovals');
  return ((await res.json()) as { items: PendingApproval[] }).items;
}

/**
 * SGU-1 — a BOUNDED read of one approval kind's most-recent rows. Used by the
 * strategy-activation decided-history provenance group so it fetches only that
 * kind's last `limit` rows (server-filtered + capped) instead of pulling the
 * tenant's entire all-kinds approval history to the browser to render a handful.
 */
export async function listApprovalsByKind(
  kind: NonNullable<PendingApproval['kind']>,
  opts?: { limit?: number },
): Promise<PendingApproval[]> {
  const params = new URLSearchParams({ kind });
  if (opts?.limit) params.set('limit', String(opts.limit));
  const res = await fetch(`${base}?${params.toString()}`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) await throwApiError(res, 'listApprovalsByKind');
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
  if (!res.ok) await throwApiError(res, 'claimApproval');
  return (await res.json()) as { runId?: string; actionId?: string; status?: string };
}

/** Edit a still-pending assistant-action draft (ADR 0023 §12 T4). The edit
 *  stamps `editedAt` and the action faces the approver again before any
 *  execution; kind/sources/taint are immutable server-side. */
export async function editAssistantAction(actionId: string, patch: { draft: string }): Promise<void> {
  const res = await fetch(`${assistantBase}/pending-actions/${encodeURIComponent(actionId)}`, fetchOpts({
    method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch),
  }));
  if (!res.ok) await throwApiError(res, 'editAssistantAction');
}

/** Dismiss the proposal; the card is parked in the board's terminal column. */
export async function rejectApproval(approvalId: string, note?: string): Promise<void> {
  const res = await fetch(`${base}/${encodeURIComponent(approvalId)}/reject`, fetchOpts({
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify(note ? { note } : {}),
  }));
  if (!res.ok) await throwApiError(res, 'rejectApproval');
}
