/**
 * Unified review inbox client (ADR 0068) — the FE surface for the host
 * `/v1/host/openwop-app/reviews/*` projection over runtime interrupts + pending
 * approvals. The normalized `ReviewRequest` shape lets one card model render in
 * chat, the side panel, and the inbox without knowing the source semantics.
 *
 * Mirrors the backend `host/reviewProjection.ts` shape.
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const BASE = '/v1/host/openwop-app/reviews';

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
  artifactId?: string;
  revisionId?: string;
  requestedBy?: { kind: 'user' | 'agent' | 'system'; id: string; label?: string };
  requestedAt: string;
  dueAt?: string;
  risk?: { level: 'low' | 'medium' | 'high' | 'critical'; reasons: string[] };
  /** Multi-approver / quorum progress (ADR 0070), present only for a quorum gate. */
  policy?: { requiredApprovals: number; approvals: number; rejections: number; rejectionPolicy?: string };
  summary?: string;
  /** The concrete asset(s) under review, for an inline rendered preview. */
  assets?: ReviewAsset[];
  actions: ReviewAction[];
  provenanceRefs: ReviewProvenanceRef[];
}

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  // Every /reviews endpoint returns a JSON body (no 204), so no empty-body cast.
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
  }
  return body as T;
}

/** List reviews. Omitted status ⇒ the pending inbox. */
export async function listReviews(status?: ReviewStatus): Promise<ReviewRequest[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  return (await http<{ items: ReviewRequest[] }>(`${BASE}${q}`)).items;
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
  body: { value?: unknown; note?: string } = {},
): Promise<{ reviewId: string; status: string; runId?: string }> {
  return http(`${BASE}/${encodeURIComponent(reviewId)}/actions/${encodeURIComponent(action)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
