/**
 * Unified review inbox client (ADR 0068) — the FE surface for the host
 * `/host/openwop-app/reviews/*` projection over runtime interrupts + pending
 * approvals. The normalized `ReviewRequest` shape lets one card model render in
 * chat, the side panel, and the inbox without knowing the source semantics.
 *
 * Mirrors the backend `host/reviewProjection.ts` shape.
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const BASE = '/host/openwop-app/reviews';

export type ReviewSource = 'interrupt' | 'approval';
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'resolved';

export interface ReviewAction {
  action: string;
  label?: string;
  requiresValue?: boolean;
  valueSchema?: unknown;
}

export interface ReviewProvenanceRef {
  kind: 'run' | 'node' | 'board' | 'card' | 'page' | 'roster' | 'artifact';
  ref: string;
  label?: string;
}

/** The concrete asset under review — inline drafted `content` or a durable
 *  artifact binding. Rendered by detected type (markdown / email / text). */
export interface ReviewAsset {
  label?: string;
  content?: string;
  artifactId?: string;
  revisionId?: string;
  /** ADR 0459 grade-fix — the artifact's registered TYPE (e.g. `kicktodo.plan-revision`),
   *  when known. `AssetPreview` dispatches a typed asset through the review-renderer
   *  registry (a humanized card) instead of the raw markdown/JSON path; absent ⇒ the
   *  markdown fallback (untyped content is unchanged). */
  artifactTypeId?: string;
  /** MIME type of a media-backed asset (ADR 0458 §2.4) — set only when the bound
   *  artifact's source is `media`, so `AssetPreview` renders the image/video
   *  inline. Never guessed: absent when unknown. Lockstep with the backend
   *  `host/reviewProjection.ts` ReviewAsset. */
  mimeType?: string;
  /** The media serve URL for a media-backed asset. Model-influenced — re-sanitized
   *  by the shared `mediaSrc` allowlist before it reaches a raw `<img>`/`<video>`. */
  url?: string;
}

export interface ReviewRequest {
  reviewId: string;
  source: ReviewSource;
  kind: string;
  /** Initiating workflow engine id + human name (for "from <Workflow>"). */
  workflowId?: string;
  workflowName?: string;
  status: ReviewStatus;
  tenantId: string;
  orgId?: string;
  runId?: string;
  nodeId?: string;
  interruptId?: string;
  approvalId?: string;
  /** ADR 0311 P2 — the chat conversation this approval traces back to. */
  conversationId?: string;
  artifactId?: string;
  revisionId?: string;
  requestedBy?: { kind: 'user' | 'agent' | 'system'; id: string; label?: string };
  requestedAt: string;
  dueAt?: string;
  risk?: { level: 'low' | 'medium' | 'high' | 'critical'; reasons: string[] };
  /** Multi-approver / quorum progress (ADR 0070), present only for a quorum gate. */
  policy?: { requiredApprovals: number; approvals: number; rejections: number; rejectionPolicy?: string };
  summary?: string;
  /** ADR 0478 §3 — the proposing AGENT'S stated reasoning (attributed claim). */
  reasoning?: string;
  /** Reviewer note recorded at decision time (resolved rows only). */
  decisionNote?: string;
  /** ADR 0473 — composed-workflow proposal payload: the card renders the LIVE
   *  draft (steps + role badges) and the approve echoes `liveDefinitionHash`
   *  back as `expectedDefinitionHash` (approve-what-you-see, server-enforced).
   *  Lockstep with the backend `host/reviewProjection.ts` block. */
  /** ADR 0501 step 4 — ids only; the preview is FETCHED at render, never projected
   *  (a stored diff goes stale between the coach's proposal and the decision). */
  planProposal?: {
    enrollmentId: string;
    proposalId: string;
  };
  composedWorkflow?: {
    definitionHash: string;
    agentProfileId?: string;
    nodeCount: number;
    edgeCount: number;
    expiresAt?: string;
    expired?: boolean;
    runInputs?: Record<string, unknown>;
    liveDefinitionHash?: string;
    editedSinceProposed?: boolean;
    steps?: { nodeId: string; typeId: string; role: string }[];
    /** ADR 0476 §3 — the propose-time static cost floor. */
    estimatedFloorUsd?: number;
    estimatedAiNodes?: number;
  };
  /** The concrete asset(s) under review, for an inline rendered preview. */
  assets?: ReviewAsset[];
  actions: ReviewAction[];
  provenanceRefs: ReviewProvenanceRef[];
}

/** A decide/list failure with the canonical envelope's typed fields preserved.
 *  `reason` (details.reason) is load-bearing for ADR 0473: `proposal_stale` /
 *  `proposal_expired` are 409s that mean "still pending — re-review", the
 *  OPPOSITE of the classic already-resolved 409 (review F1). */
export class ReviewRequestError extends Error {
  constructor(
    message: string,
    readonly errorCode: string,
    readonly httpStatus: number,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'ReviewRequestError';
  }
}

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  // Every /reviews endpoint returns a JSON body (no 204), so no empty-body cast.
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string; details?: { reason?: unknown } };
    const reason = typeof err.details?.reason === 'string' ? err.details.reason : undefined;
    throw new ReviewRequestError(
      `${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`,
      err.error ?? 'http_error',
      res.status,
      reason,
    );
  }
  return body as T;
}

/** List reviews. Omitted status ⇒ the pending inbox. */
export async function listReviews(status?: ReviewStatus, opts: { conversationId?: string; boardId?: string } = {}): Promise<ReviewRequest[]> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  // ADR 0311 P2 — conversation-scoped reviews (the chat strip). Server-side,
  // post-authz narrowing.
  if (opts.conversationId) params.set('conversationId', opts.conversationId);
  // ADR 0311 P3 — board-scoped reviews (the board's Needs-review lane).
  if (opts.boardId) params.set('boardId', opts.boardId);
  const q = params.size > 0 ? `?${params.toString()}` : '';
  return (await http<{ items: ReviewRequest[] }>(`${BASE}${q}`)).items;
}

/**
 * ADR 0501 step 4 — what accepting this coach proposal WOULD do.
 *
 * A discriminated union, mirroring the backend, because the distinction is the point:
 * `advice-only` means there is nothing executable to preview (and accept will refuse),
 * which is NOT the same as a computed diff that happens to be empty. Collapsing them
 * would render "no changes to your plan" — a confident answer nobody earned.
 *
 * Fetched at RENDER, deliberately: the plan can move between the proposal and the
 * decision, and re-validation at accept is what actually protects the participant.
 */
export type ProposalPreview =
  | { kind: 'advice-only' }
  | { kind: 'changes'; changes: Array<{ lane: string; line: string; day?: number; fromDate?: string; toDate?: string }> };

export async function fetchProposalPreview(enrollmentId: string, proposalId: string): Promise<ProposalPreview> {
  return http<ProposalPreview>(
    `/host/openwop-app/kicktodo/enrollments/${encodeURIComponent(enrollmentId)}/proposals/${encodeURIComponent(proposalId)}/preview`,
  );
}

export async function getReview(reviewId: string): Promise<ReviewRequest> {
  return http<ReviewRequest>(`${BASE}/${encodeURIComponent(reviewId)}`);
}

/**
 * Decide a review. `value` carries the typed interrupt resume (for a
 * `requiresValue` action); `note` is the optional reviewer comment. The backend
 * dispatches to the source owner and is stale-safe (409 on a resolved review).
 */
export async function decideReview(
  reviewId: string,
  action: string,
  body: { value?: unknown; note?: string; expectedDefinitionHash?: string } = {},
): Promise<{ reviewId: string; status: string; runId?: string }> {
  return http(`${BASE}/${encodeURIComponent(reviewId)}/actions/${encodeURIComponent(action)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
