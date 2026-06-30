/**
 * Unified review projection (ADR 0068) — ONE user-facing review model over the
 * two distinct human-review owners, without collapsing their runtime semantics.
 *
 *   - runtime interrupts  (owner: OpenWOP runtime — pause/resume a running run)
 *   - pending approvals   (owner: host/approvalService — pre-execution proposals)
 *
 * This module is READ-FIRST + a thin mapper. It NEVER becomes a third state
 * owner: status, finality, and decision history are read from the source record
 * (the interrupt store / the approval store). Actions are DERIVED from the source
 * after authorization and dispatched to the source's existing resolve path
 * (`resolveAndResume` / `handleConversationResolve` / `claimApproval` /
 * `rejectApproval`) — see `routes/reviews.ts`.
 *
 * Non-normative; `/v1/host/openwop-app/reviews/*`. No new wire (a STANDARD
 * cross-host review list would need an OpenWOP RFC — this is host-local).
 *
 * @see docs/adr/0068-unified-review-projection.md
 */

import type { Storage } from '../storage/storage.js';
import type { InterruptRecord, RunRecord } from '../types.js';
import { timeoutApprovalGateIfDue } from '../executor/approvalGateTimeout.js';
import { resolveEffectiveAccess } from './accessControlService.js';
import { getApproval, listApprovals, type PendingApproval, type ApprovalStatus } from './approvalService.js';
import { tallyDecisions } from './reviewDecisionLedger.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.reviewProjection');

/** Bound on the global open-interrupt scan for the inbox (no tenant index on
 *  interrupts — tenant lives on the run). A cold read path; truncation is logged
 *  so a half-shown inbox is never mistaken for "all clear".
 *
 *  KNOWN LIMITATION (ADR 0068): the scan is GLOBAL then tenant-filtered, so in a
 *  busy multi-tenant deployment a tenant's interrupts past the first 500 OPEN rows
 *  (across all tenants) would not surface. This host is effectively single-tenant
 *  (`_anon`/`default`), so it's a non-issue here; a true multi-tenant deployment
 *  needs a tenant-indexed open-interrupt query in the runtime store (out of scope —
 *  it would change the runtime store, not host-extension code). Never a LEAK:
 *  other tenants' rows are filtered out, only the caller's own may be undercounted. */
const INTERRUPT_SCAN_LIMIT = 500;

export type ReviewSource = 'interrupt' | 'approval';
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'resolved';

export interface ReviewAction {
  /** Canonical action verb — `approve`/`reject` (approvals) or `resolve` (interrupts). */
  action: string;
  label?: string;
  /** When true, the POST body MUST carry `value` (the typed interrupt resume). */
  requiresValue?: boolean;
  /** The interrupt's resume schema, when the UI should render a typed form. */
  valueSchema?: unknown;
}

export interface ReviewProvenanceRef {
  kind: 'run' | 'node' | 'board' | 'card' | 'page' | 'roster' | 'artifact';
  ref: string;
  label?: string;
}

/** A concrete asset under review — the thing the human is approving. Either
 *  inline `content` (the drafted text the gate bundled) or a durable artifact
 *  binding (`artifactId`/`revisionId`). The frontend renders it by detected
 *  type (markdown / email / text), never as raw output. */
export interface ReviewAsset {
  label?: string;
  content?: string;
  artifactId?: string;
  revisionId?: string;
}

export interface ReviewRequest {
  reviewId: `interrupt:${string}` | `approval:${string}`;
  source: ReviewSource;
  kind: string;
  /** The initiating workflow's engine id + its human name (run.metadata.workflowName
   *  ?? workflowId). Lets a card say "from <Workflow>" instead of a raw run/wf id. */
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
  /** A human-readable one-liner for the card (the approval proposal / interrupt prompt). */
  summary?: string;
  /** The concrete asset(s) under review, for an inline rendered preview. */
  assets?: ReviewAsset[];
  actions: ReviewAction[];
  provenanceRefs: ReviewProvenanceRef[];
}

/** Authorization context the projection needs (the deciding subject). */
export interface ReviewAuthCtx {
  tenantId: string;
  /** The caller's subject ref (req.userId ?? principal.principalId), for org RBAC. */
  subjectRef?: string;
}

// ── mappers ──────────────────────────────────────────────────────────────

/** Derive the action list for an OPEN interrupt from its kind + data. An
 *  `approval`-kind gate with a declared `data.actions` allowlist surfaces those
 *  verbs; every other open interrupt is resolved with a typed value. */
function interruptActions(it: InterruptRecord): ReviewAction[] {
  if (it.kind === 'approval') {
    const data = (it.data ?? {}) as { actions?: unknown };
    const allowed = Array.isArray(data.actions) ? data.actions.filter((a): a is string => typeof a === 'string') : [];
    if (allowed.length > 0) {
      return allowed.map((a) => ({ action: a, requiresValue: false }));
    }
  }
  return [{ action: 'resolve', requiresValue: true, valueSchema: it.resumeSchema }];
}

function interruptRisk(it: InterruptRecord): ReviewRequest['risk'] {
  const data = (it.data ?? {}) as { risk?: { level?: unknown; reasons?: unknown } };
  const risk = data.risk;
  const level = risk?.level;
  if (risk && (level === 'low' || level === 'medium' || level === 'high' || level === 'critical')) {
    const reasons = Array.isArray(risk.reasons) ? risk.reasons.filter((r): r is string => typeof r === 'string') : [];
    return { level, reasons };
  }
  return undefined;
}

/** Read an artifact binding (ADR 0069) from a source record's data, if present.
 *  A review that approves generated work pins an IMMUTABLE `(artifactId,
 *  revisionId)` so the decision can never drift to a mutated "latest". */
function artifactBinding(data: { artifactId?: unknown; revisionId?: unknown }): { artifactId?: string; revisionId?: string } {
  return {
    ...(typeof data.artifactId === 'string' ? { artifactId: data.artifactId } : {}),
    ...(typeof data.revisionId === 'string' ? { revisionId: data.revisionId } : {}),
  };
}

/** Project an OPEN interrupt (+ its run) into a ReviewRequest. The caller has
 *  already verified `run.tenantId === ctx.tenantId`. */
export function interruptToReview(it: InterruptRecord, run: RunRecord): ReviewRequest {
  const data = (it.data ?? {}) as {
    prompt?: unknown; summary?: unknown; conversationId?: unknown;
    artifactId?: unknown; revisionId?: unknown;
    options?: unknown;
  };
  const summary = typeof data.prompt === 'string' ? data.prompt : typeof data.summary === 'string' ? data.summary : undefined;
  const meta = (run.metadata ?? {}) as { workflowName?: unknown; actingUserId?: unknown };
  // The workflow's human name — what initiated this approval. `workflowName` is
  // set by some dispatchers; otherwise the engine workflowId is still far more
  // meaningful than the opaque run id (the frontend humanizes it further via its
  // SavedWorkflow registry).
  const workflowName = (typeof meta.workflowName === 'string' && meta.workflowName) || run.workflowId;
  const actingUserId = typeof meta.actingUserId === 'string' ? meta.actingUserId : undefined;
  // The concrete content under review: the gate bundles upstream string outputs
  // as `options[]` (key/label/content); also surface a pinned artifact binding.
  const optionAssets: ReviewAsset[] = Array.isArray(data.options)
    ? data.options
        .filter((o): o is { label?: string; content?: string } => !!o && typeof o === 'object')
        .map((o) => ({
          ...(typeof o.label === 'string' ? { label: o.label } : {}),
          ...(typeof o.content === 'string' ? { content: o.content } : {}),
        }))
        .filter((a) => a.content || a.label)
    : [];
  const binding = artifactBinding(data);
  const assets: ReviewAsset[] = [
    ...optionAssets,
    ...(binding.artifactId ? [{ ...binding }] : []),
  ];
  return {
    reviewId: `interrupt:${it.interruptId}`,
    source: 'interrupt',
    kind: it.kind,
    workflowId: run.workflowId,
    workflowName,
    status: it.resolvedAt ? 'resolved' : 'pending',
    tenantId: run.tenantId,
    runId: it.runId,
    nodeId: it.nodeId,
    interruptId: it.interruptId,
    ...binding,
    // Attribute to the initiating human when known; otherwise the named workflow
    // (never the bare literal "workflow" — that told the reviewer nothing).
    requestedBy: actingUserId
      ? { kind: 'user', id: actingUserId }
      : { kind: 'system', id: it.runId, label: workflowName },
    requestedAt: it.createdAt,
    ...(it.expiresAt ? { dueAt: it.expiresAt } : {}),
    ...(interruptRisk(it) ? { risk: interruptRisk(it) } : {}),
    ...(summary ? { summary } : {}),
    ...(assets.length > 0 ? { assets } : {}),
    actions: interruptActions(it),
    provenanceRefs: [
      { kind: 'run', ref: it.runId },
      { kind: 'node', ref: it.nodeId },
      ...(typeof data.artifactId === 'string' ? [{ kind: 'artifact' as const, ref: data.artifactId }] : []),
    ],
  };
}

/** Enrich an interrupt review with live quorum progress (ADR 0070) from the
 *  durable decision ledger, when the gate declares `requiredApprovals > 1`. */
async function withQuorumPolicy(review: ReviewRequest, it: InterruptRecord): Promise<ReviewRequest> {
  const data = (it.data ?? {}) as { requiredApprovals?: unknown; rejectionPolicy?: unknown };
  const required = typeof data.requiredApprovals === 'number' && data.requiredApprovals > 1 ? data.requiredApprovals : 0;
  if (required === 0) return review;
  const tally = await tallyDecisions(it.interruptId);
  return {
    ...review,
    policy: {
      requiredApprovals: required,
      approvals: tally.accepts.length,
      rejections: tally.rejects.length,
      ...(typeof data.rejectionPolicy === 'string' ? { rejectionPolicy: data.rejectionPolicy } : {}),
    },
  };
}

/** Enrich an approval review with live quorum progress (ADR 0070) from the
 *  durable decision ledger, when the approval carries a multi-approver policy. */
async function withApprovalQuorumPolicy(review: ReviewRequest, a: PendingApproval): Promise<ReviewRequest> {
  const required = a.policy && a.policy.requiredApprovals > 1 ? a.policy.requiredApprovals : 0;
  if (required === 0) return review;
  const tally = await tallyDecisions(a.approvalId);
  return { ...review, policy: { requiredApprovals: required, approvals: tally.accepts.length, rejections: tally.rejects.length } };
}

function approvalStatusToReview(s: ApprovalStatus): ReviewStatus {
  return s; // 'pending' | 'approved' | 'rejected' map 1:1
}

/** Project a PendingApproval into a ReviewRequest. Actions are only offered
 *  while pending (a resolved approval is an audit row, not actionable). */
export function approvalToReview(a: PendingApproval): ReviewRequest {
  const kind = a.kind ?? 'run-proposal';
  const provenance: ReviewProvenanceRef[] = [];
  if (a.boardId) provenance.push({ kind: 'board', ref: a.boardId });
  if (a.cardId) provenance.push({ kind: 'card', ref: a.cardId, ...(a.cardTitle ? { label: a.cardTitle } : {}) });
  if (a.pageId) provenance.push({ kind: 'page', ref: a.pageId, ...(a.pageTitle ? { label: a.pageTitle } : {}) });
  if (a.rosterId) provenance.push({ kind: 'roster', ref: a.rosterId, ...(a.persona ? { label: a.persona } : {}) });
  const actions: ReviewAction[] = a.status === 'pending'
    ? [{ action: 'approve', label: kind === 'run-proposal' ? 'Approve & run' : 'Approve' }, { action: 'reject', label: 'Reject' }]
    : [];
  return {
    reviewId: `approval:${a.approvalId}`,
    source: 'approval',
    kind,
    ...(a.workflowId ? { workflowId: a.workflowId, workflowName: a.workflowId } : {}),
    status: approvalStatusToReview(a.status),
    tenantId: a.tenantId,
    ...(a.orgId ? { orgId: a.orgId } : {}),
    approvalId: a.approvalId,
    ...(a.runId ? { runId: a.runId } : {}),
    requestedBy: a.rosterId
      ? { kind: 'agent', id: a.rosterId, ...(a.persona ? { label: a.persona } : {}) }
      : { kind: 'system', id: a.approvalId },
    requestedAt: a.createdAt,
    ...(a.proposal ? { summary: a.proposal } : {}),
    actions,
    provenanceRefs: provenance,
  };
}

// ── visibility ─────────────────────────────────────────────────────────────

/** A content-publish approval is visible only to a caller who can manage members
 *  in its org (mirrors routes/approvals.ts list gating — the SAME check, reused). */
async function approvalVisible(a: PendingApproval, ctx: ReviewAuthCtx): Promise<boolean> {
  if (a.kind !== 'content-publish') return true;
  if (!ctx.subjectRef || !a.orgId) return false;
  const access = await resolveEffectiveAccess(ctx.tenantId, { subject: ctx.subjectRef, orgId: a.orgId });
  return access.scopes.includes('host:members:manage');
}

// ── list / get ───────────────────────────────────────────────────────────

export interface ListReviewsOpts {
  /** Filter. Omitted ⇒ the pending inbox (open interrupts + pending approvals). */
  status?: ReviewStatus;
}

/**
 * List reviews for a tenant. The pending inbox composes open runtime interrupts
 * (bounded global scan, joined to their run for tenant isolation) and pending
 * host approvals (tenant-indexed). A non-pending status filter returns only
 * approval-source history (resolved interrupts are not retained as open rows).
 */
export async function listReviews(storage: Storage, ctx: ReviewAuthCtx, opts: ListReviewsOpts = {}): Promise<ReviewRequest[]> {
  const wantPending = opts.status === undefined || opts.status === 'pending';
  const out: ReviewRequest[] = [];

  // Interrupts — only meaningful for the pending inbox (the store holds OPEN ones).
  if (wantPending) {
    const open = await storage.listOpenInterruptsAll(INTERRUPT_SCAN_LIMIT);
    if (open.length === INTERRUPT_SCAN_LIMIT) {
      log.warn('review_interrupt_scan_truncated', { limit: INTERRUPT_SCAN_LIMIT, tenantId: ctx.tenantId });
    }
    const runCache = new Map<string, RunRecord | null>();
    for (const it of open) {
      // A conversation gate is a live chat exchange, not a human review request.
      if (it.kind === 'conversation') continue;
      // RFC 0093 §D lazy enforcement: an overdue approval gate auto-rejects here
      // and drops out of the inbox.
      if (await timeoutApprovalGateIfDue(storage, it)) continue;
      let run = runCache.get(it.runId);
      if (run === undefined) { run = await storage.getRun(it.runId); runCache.set(it.runId, run); }
      if (!run || run.tenantId !== ctx.tenantId) continue; // tenant isolation (no existence leak)
      out.push(await withQuorumPolicy(interruptToReview(it, run), it));
    }
  }

  // Approvals — tenant-indexed; map the review status filter to the approval status.
  const approvalStatus: ApprovalStatus | undefined =
    opts.status === 'pending' || opts.status === 'approved' || opts.status === 'rejected' ? opts.status : undefined;
  if (opts.status === undefined || approvalStatus !== undefined) {
    const approvals = await listApprovals(ctx.tenantId, approvalStatus);
    for (const a of approvals) {
      if (await approvalVisible(a, ctx)) out.push(await withApprovalQuorumPolicy(approvalToReview(a), a));
    }
  }

  return out;
}

/** A resolved single review, or null when it is absent OR not visible to the
 *  caller (the route maps null → 404, never 403, to avoid an existence leak). */
export async function getReview(storage: Storage, ctx: ReviewAuthCtx, reviewId: string): Promise<ReviewRequest | null> {
  const sep = reviewId.indexOf(':');
  if (sep <= 0) return null;
  const source = reviewId.slice(0, sep);
  const sourceId = reviewId.slice(sep + 1);

  if (source === 'interrupt') {
    const it = await storage.getInterrupt(sourceId);
    if (!it || it.kind === 'conversation') return null; // a chat gate is not a review
    const run = await storage.getRun(it.runId);
    if (!run || run.tenantId !== ctx.tenantId) return null;
    return withQuorumPolicy(interruptToReview(it, run), it);
  }
  if (source === 'approval') {
    const a = await getApproval(sourceId);
    if (!a || a.tenantId !== ctx.tenantId) return null;
    if (!(await approvalVisible(a, ctx))) return null;
    return withApprovalQuorumPolicy(approvalToReview(a), a);
  }
  return null;
}
