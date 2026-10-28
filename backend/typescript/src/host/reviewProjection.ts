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
import { mayViewApproval } from './approvalAudience.js';
import { gateAclOf, gateApproverRefs, isEligibleApprover, policyApproverRefs, type ApproverRefs } from './approverResolution.js';
import type { EffectiveAccess } from './accessControlService.js';
import { isTerminalRunStatus } from '@openwop/openwop';
import { getApproval, listApprovals, getAssistantActionProjector, type PendingApproval, type ApprovalStatus } from './approvalService.js';
import { getArtifact, getArtifactRevision } from './artifactProjection.js';
import { tallyDecisions } from './reviewDecisionLedger.js';
import { getRegisteredWorkflowAsync } from './workflowsRegistry.js';
import { definitionHashOf } from './definitionHash.js';
import { staticCostFloor } from './workflowCostEstimate.js';
import { nodeRoleMap } from './nodeCatalogBuilder.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.reviewProjection');

/** Bound on the global open-interrupt scan for the inbox (no tenant index on
 *  interrupts — tenant lives on the run). A cold read path; truncation is logged
 *  so a half-shown inbox is never mistaken for "all clear".
 *
 *  Tenant-scoped (#4215) and restricted to NON-terminal runs (ADR 0778 D3) on
 *  both real adapters; an adapter without `listOpenInterruptsForTenant` falls
 *  back to the global scan, filtered per row below. CORRECTED (ADR 0778): this
 *  comment used to call the scan "GLOBAL then tenant-filtered", which had been
 *  false since #4215. */
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
  /** MIME type of a media-backed asset (ADR 0458 §2.4) — set only when the bound
   *  artifact's source is `media`, so the FE renders an image/video inline. Never
   *  guessed: absent when unknown. Lockstep with `chat/reviews/reviewClient.ts`. */
  mimeType?: string;
  /** The media serve URL for a media-backed asset (the bound artifact's single
   *  revision content). Model-influenced — re-sanitized by the FE `mediaSrc`
   *  allowlist before it reaches a raw `<img>`/`<video>`. */
  url?: string;
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
  /** ADR 0905 — the same pinned send review the approval inbox displays. */
  emailSend?: PendingApproval['emailSend'];
  /** ADR 0311 P2 — the chat conversation an approval traces back to (a filed
   *  todo's origin); the chat review strip filters on it. */
  conversationId?: string;
  artifactId?: string;
  revisionId?: string;
  requestedBy?: { kind: 'user' | 'agent' | 'system'; id: string; label?: string };
  requestedAt: string;
  dueAt?: string;
  risk?: { level: 'low' | 'medium' | 'high' | 'critical'; reasons: string[] };
  /** ADR 0778 D8 — may THIS caller decide it? Present only when the route
   *  supplied the caller (`ReviewAuthCtx.decider`). `false` means the server
   *  would refuse; the SPA hides the decide buttons then. Advisory — the decide
   *  route re-checks. Absent on approval-source reviews without a declared
   *  approver list: that lane's authority has personal-owner and superadmin
   *  arms this projection does not re-derive, so it does not guess. */
  canDecide?: boolean;
  /** Multi-approver / quorum progress (ADR 0070), present only for a quorum gate. */
  policy?: { requiredApprovals: number; approvals: number; rejections: number; rejectionPolicy?: string };
  /** A human-readable one-liner for the card (the approval proposal / interrupt prompt). */
  summary?: string;
  /** ADR 0478 §3 — the proposing AGENT'S stated reasoning (attributed claim). */
  reasoning?: string;
  /** Reviewer note recorded at decision time — surfaced on resolved cards (the
   *  ADR 0473 OQ1 posture: the note IS the feedback record; automatic agent
   *  re-engagement is deliberately not wired). */
  decisionNote?: string;
  /** ADR 0473 — composed-workflow proposal payload: the approve-what-you-see
   *  pin + provenance the review card needs. The definition itself is read
   *  live from the owned-workflow route (the draft is tenant-owned and
   *  builder-editable); this block lets the card detect edits (live hash ≠
   *  pinned hash) and send the hash it displayed back with the approve. */
  /**
   * ADR 0501 step 4 — the two ids the card needs to FETCH the preview of what accepting
   * this proposal would do. Deliberately ids ONLY.
   *
   * The approval row's `planProposal` also carries `note` (the coach's free text —
   * `declarePiiFields('kicktodo.plan-proposal', ['note'])`) and `coachSubject`. Neither
   * is copied here: the card already renders the note through the summary under its own
   * visibility rule, and a second copy on a differently-gated projection is how a PII
   * field quietly acquires a second exposure path.
   *
   * And the preview itself is NOT projected. It must be computed at READ time against
   * the live plan — a stored diff is a snapshot that goes stale between the coach's
   * proposal and the participant's decision, which would be a confident answer that is
   * no longer true. Same reason `composedWorkflow` re-derives `editedSinceProposed`
   * below instead of trusting the pinned hash.
   */
  planProposal?: {
    enrollmentId: string;
    proposalId: string;
  };
  /** ADR 0862 D1/D3 — an assistant action's card as the approver must see it: every
   *  field the executor consumes (the projector's per-kind `CARD_FIELDS`, redacted) and
   *  the `contentHash` the approve MUST echo as `expectedContentHash`. Pending rows only. */
  /** The fields an open interrupt's answer form needs, so a reviewer can answer
   *  a typed (`requiresValue`) review on the card itself (ADR 0778 D10
   *  correction). A CLOSED allowlist per kind — never the raw `data`, which can
   *  carry anything a node put there. Absent for a kind the card cannot answer
   *  inline (credential, external-event, low-confidence, unknown). */
  answerForm?: ReviewAnswerForm;
  assistantAction?: {
    actionId: string;
    kind: string;
    contentHash: string;
    payload: Record<string, unknown>;
  };
  composedWorkflow?: {
    definitionHash: string;
    agentProfileId?: string;
    nodeCount: number;
    edgeCount: number;
    expiresAt?: string;
    /** Computed at projection time: past `expiresAt` ⇒ the decide refuses
     *  (409 `proposal_expired`); the review projects as `expired`, actionless. */
    expired?: boolean;
    /** The frozen run inputs the approved dispatch will carry — part of what
     *  the reviewer approves, so the card MUST be able to show them (review
     *  F8; bounded at propose time). */
    runInputs?: Record<string, unknown>;
    /** ADR 0476 §3 — the static composition cost floor computed at PROPOSE
     *  time (approve-what-you-see includes what it roughly costs). */
    estimatedFloorUsd?: number;
    estimatedAiNodes?: number;
    /** The hash of the definition AS THE CARD DISPLAYS IT — the value the
     *  approve MUST send back as `expectedDefinitionHash` (approve-what-you-
     *  see). Absent when the draft no longer resolves on this instance. */
    liveDefinitionHash?: string;
    /** live ≠ propose-time pin — the card shows the edited-since-proposed
     *  notice (informational; the live hash is still approvable, F1 rule). */
    editedSinceProposed?: boolean;
    /** The LIVE definition's step list with the pack `role` taxonomy for the
     *  per-node risk badges (`unclassified` when a node declares none —
     *  policy-equivalent to side-effect, fail-closed). Capped; `nodeCount`
     *  carries the true total. */
    steps?: { nodeId: string; typeId: string; role: string }[];
  };
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
  /** ADR 0778 D8 — what the decide route would check, computed ONCE per request
   *  by the route: `holdsRespond` = the D2 floor (`approvals:respond`), and
   *  `reviewerRef` = the D6 reviewer identity. Absent ⇒ no `canDecide`. */
  decider?: { holdsRespond: boolean; reviewerRef?: string };
  /** ADR 0862 — the two REQUEST-level exits the assistant card's read gate honours
   *  (wildcard operator; own personal workspace). Absent ⇒ neither applies. */
  viewerExits?: { isOperator: boolean; isPersonalOwner: boolean };
}

/** Per-request memo for the per-row authority reads (ADR 0778 C14): one
 *  eligibility resolution per distinct (reviewer, ACL, org), one effective-access
 *  resolution per (subject, org). Unmemoized, 500 rows would re-run the group
 *  expansion and the member scans 500 times. */
interface ReadMemo {
  eligible: Map<string, Promise<boolean>>;
  access: Map<string, Promise<EffectiveAccess>>;
}

function newReadMemo(): ReadMemo {
  return { eligible: new Map(), access: new Map() };
}

function memoEligible(memo: ReadMemo, reviewerRef: string, refs: ApproverRefs, ctx: { tenantId: string; orgId?: string }): Promise<boolean> {
  const key = JSON.stringify([reviewerRef, refs, ctx.tenantId, ctx.orgId ?? null]);
  let hit = memo.eligible.get(key);
  if (!hit) {
    hit = isEligibleApprover(reviewerRef, refs, ctx).then((r) => r.eligible).catch(() => false);
    memo.eligible.set(key, hit);
  }
  return hit;
}

/** ADR 0778 D8 — the decide authority for an interrupt review, mirroring the
 *  route: non-approval kinds are answerable by anyone who can see them; an
 *  approval gate with a declared ACL admits its approvers (and their delegates);
 *  an open one needs the D2 floor. */
async function interruptCanDecide(it: InterruptRecord, run: RunRecord, ctx: ReviewAuthCtx, memo: ReadMemo): Promise<boolean | undefined> {
  const decider = ctx.decider;
  if (!decider) return undefined;
  const acl = gateAclOf(it.data);
  // A declared ACL binds on EVERY kind (`assertEligibleApprover` does not read
  // the kind), so it decides here before the kind does (grade-code `APCD-8`).
  if (!acl.declared) {
    if (it.kind !== 'approval') return true;
    // An open QUORUM gate counts identified voters only: a caller with no
    // reviewer identity (an `apikey:`) is refused there whatever its scopes.
    const required = (it.data as { requiredApprovals?: unknown } | null)?.requiredApprovals;
    if (typeof required === 'number' && required > 1 && !decider.reviewerRef) return false;
    return decider.holdsRespond;
  }
  if (!decider.reviewerRef) return false;
  const orgId = (run.metadata as Record<string, unknown> | undefined)?.approverOrgId;
  return memoEligible(
    memo,
    decider.reviewerRef,
    gateApproverRefs(it.data),
    { tenantId: run.tenantId, ...(typeof orgId === 'string' ? { orgId } : {}) },
  );
}

/** Approval-source `canDecide`, only where it can be stated honestly: a QUORUM
 *  approval with a declared approver list, which is the only case the approvals
 *  lane decides on eligibility (`approvalDecision.ts` finalizes a single-approver
 *  approval before reading the list, then applies per-kind rules with operator
 *  and personal-owner arms this does not re-derive — grade-code `APCD-7`).
 *  Otherwise absent (see the field's doc). */
async function approvalCanDecide(a: PendingApproval, ctx: ReviewAuthCtx, memo: ReadMemo): Promise<boolean | undefined> {
  const decider = ctx.decider;
  if (!decider) return undefined;
  const required = (a.policy as { requiredApprovals?: unknown } | undefined)?.requiredApprovals;
  if (!(typeof required === 'number' && required > 1)) return undefined;
  const refs: ApproverRefs = policyApproverRefs(a.policy);
  if (!gateAclOf(refs).declared) return undefined;
  const subject = ctx.subjectRef;
  if (!subject) return false;
  return memoEligible(memo, subject, refs, { tenantId: ctx.tenantId, ...(a.orgId ? { orgId: a.orgId } : {}) });
}

/** The runs behind an interrupt page, in ONE read where the store supports it
 *  (ADR 0778 D8), else one `getRun` per distinct id. */
async function loadRuns(storage: Storage, runIds: readonly string[]): Promise<Map<string, RunRecord>> {
  const ids = [...new Set(runIds)];
  const out = new Map<string, RunRecord>();
  if (ids.length === 0) return out;
  if (storage.getRunsByIds) {
    for (const r of await storage.getRunsByIds(ids)) out.set(r.runId, r);
    return out;
  }
  for (const id of ids) {
    const r = await storage.getRun(id);
    if (r) out.set(id, r);
  }
  return out;
}

// ── mappers ──────────────────────────────────────────────────────────────

export interface ReviewAnswerForm {
  /** clarification: the question asked. */
  question?: string;
  /** clarification: `'openwop-connection'` for a connect-to-continue prompt. */
  profile?: string;
  /** clarification connection prompt: which connection is missing. No secrets —
   *  `ConnectionPromptMeta` (host/connectionInterrupt.ts) carries none. */
  connection?: { ref: string; providerId?: string; category?: string; label?: string };
  /** refinement: the draft to refine. */
  current?: unknown;
  /** cancellation: why cancelling was requested. */
  reason?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The answer-form fields for an open interrupt, by kind. Each field is named
 *  explicitly; nothing else in `data` reaches the projection. */
export function interruptAnswerForm(it: InterruptRecord): ReviewAnswerForm | undefined {
  if (it.resolvedAt) return undefined;
  const data = (it.data ?? {}) as Record<string, unknown>;
  if (it.kind === 'clarification') {
    const conn = data.connection && typeof data.connection === 'object' ? data.connection as Record<string, unknown> : undefined;
    const ref = str(conn?.ref);
    return {
      ...(str(data.question) ? { question: str(data.question) } : {}),
      ...(str(data.profile) ? { profile: str(data.profile) } : {}),
      ...(conn && ref ? {
        connection: {
          ref,
          ...(str(conn.providerId) ? { providerId: str(conn.providerId) } : {}),
          ...(str(conn.category) ? { category: str(conn.category) } : {}),
          ...(str(conn.label) ? { label: str(conn.label) } : {}),
        },
      } : {}),
    };
  }
  if (it.kind === 'refinement') return 'current' in data ? { current: data.current } : {};
  if (it.kind === 'cancellation') return str(data.reason) ? { reason: str(data.reason) } : {};
  return undefined;
}

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
function conversationIdOf(run: RunRecord, data: { conversationId?: unknown }): { conversationId?: string } {
  const fromRun = (run.metadata as { chatSessionId?: unknown } | undefined)?.chatSessionId;
  const id = typeof fromRun === 'string' && fromRun ? fromRun
    : typeof data.conversationId === 'string' && data.conversationId ? data.conversationId
      : undefined;
  return id ? { conversationId: id } : {};
}

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
  const answerForm = interruptAnswerForm(it);
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
    // ADR 0776 — the conversation this approval belongs to. It was DECLARED on the
    // interrupt's data type and never mapped, so `?conversationId=` silently
    // dropped every interrupt review (approvals only). The run's own
    // `metadata.chatSessionId` is the stamp every chat-dispatched run carries;
    // `data.conversationId` is the fallback a node may set explicitly.
    ...conversationIdOf(run, data),
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
    ...(answerForm ? { answerForm } : {}),
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

/** Enrich a review's artifact-bound assets so a media asset (a generated
 *  image/video) can render INLINE where the reviewer decides (ADR 0458 §2.4) —
 *  the reviews inbox `ReviewCard` renders `review.assets` directly, with no
 *  per-artifact fetch of its own. For an asset that binds an artifact whose
 *  source is `media`, the artifact's `format` IS the MIME type and the single
 *  revision's `content` IS the serve URL; both are populated. A document /
 *  run-event / inline-content asset is left untouched (its text preview loads on
 *  demand) — a MIME is never guessed, and no `content` is reinterpreted as a URL. */
export async function withMediaAssets(review: ReviewRequest, ctx: ReviewAuthCtx): Promise<ReviewRequest> {
  if (!review.assets || review.assets.length === 0) return review;
  const enriched = await Promise.all(review.assets.map((a) => enrichAssetMedia(a, ctx)));
  return { ...review, assets: enriched };
}

async function enrichAssetMedia(asset: ReviewAsset, ctx: ReviewAuthCtx): Promise<ReviewAsset> {
  // Only an artifact-bound asset can be a media asset; an inline-content option is text.
  // Already-populated `url` (defensive) is left as-is.
  if (!asset.artifactId || asset.url) return asset;
  const artifact = await getArtifact(ctx.tenantId, ctx.subjectRef, asset.artifactId);
  if (!artifact || artifact.source !== 'media') return asset;
  const revisionId = asset.revisionId ?? artifact.latestRevisionId;
  const rev = revisionId
    ? await getArtifactRevision(ctx.tenantId, ctx.subjectRef, asset.artifactId, revisionId)
    : null;
  return {
    ...asset,
    // A media artifact's `format` is its MIME type; the single revision's content is the serve URL.
    ...(artifact.format ? { mimeType: artifact.format } : {}),
    ...(rev?.content ? { url: rev.content } : {}),
  };
}

function approvalStatusToReview(s: ApprovalStatus): ReviewStatus {
  return s; // 'pending' | 'approved' | 'rejected' map 1:1
}

/** ADR 0473 Phase 2 — the LIVE view of a composed-workflow draft for the
 *  review card: the hash the card is displaying (the approve echoes it back),
 *  the edited-since-proposed flag, and the step list with pack-role risk
 *  badges. ASYNC by necessity (review F3): the sync registry read misses
 *  drafts registered on another instance or before a restart — the async read
 *  also re-hydrates the write-through cache, so the preview survives the real
 *  deployment topology. Enriches ONLY pending rows (review F5: reject archives
 *  the draft, which moves the hash by construction — a resolved card must not
 *  warn about approving). Cost: composed rows only, bounded by the tenant
 *  transient cap. */
const COMPOSED_STEPS_CAP = 60;
export async function withComposedLiveView(review: ReviewRequest, a: PendingApproval): Promise<ReviewRequest> {
  if (a.kind !== 'composed-workflow' || a.status !== 'pending' || !review.composedWorkflow) return review;
  const def = await getRegisteredWorkflowAsync(a.workflowId);
  if (!def) return review;
  const liveHash = definitionHashOf(def);
  const roles = nodeRoleMap();
  const draftName = typeof def.metadata?.name === 'string' && def.metadata.name.length > 0 ? def.metadata.name : undefined;
  return {
    ...review,
    // grade-ux U3 — the draft's human name beats the uuid the base mapper
    // falls back to ("from wf-<uuid>" was the flagship card's header).
    ...(draftName ? { workflowName: draftName } : {}),
    composedWorkflow: {
      ...review.composedWorkflow,
      liveDefinitionHash: liveHash,
      ...(liveHash !== review.composedWorkflow.definitionHash ? { editedSinceProposed: true } : {}),
      steps: def.nodes.slice(0, COMPOSED_STEPS_CAP).map((n) => ({
        nodeId: n.nodeId,
        typeId: n.typeId,
        role: roles.get(n.typeId) ?? 'unclassified',
      })),
      // ADR 0476 (review M3) — the cost line must describe what APPROVING
      // executes: recompute the floor from the LIVE definition (the same one
      // approve-what-you-see pins), replacing the propose-time value.
      ...((): Record<string, unknown> => {
        const floor = staticCostFloor(def);
        return floor
          ? { estimatedFloorUsd: floor.floorUsd, estimatedAiNodes: floor.aiNodes }
          : { estimatedFloorUsd: undefined, estimatedAiNodes: undefined };
      })(),
    },
  };
}

/**
 * COS-14 — surface the ADR 0027 safety signals for an `assistant-action` review.
 *
 * `/reviews` had branches for kicktodo-plan-proposal, strategy-checkin,
 * commerce-listing-publish, anon-surface-write and composed-workflow — but NONE
 * for `assistant-action`, so an approval that can send a REAL outbound message
 * projected with no taint banner, no risk chip, no recipient diff, and a `summary`
 * frozen at the 77-char snapshot taken at enqueue (which `editPendingAction` never
 * refreshes — making the docblock promise that "an edited draft always faces the
 * approver again" untrue on this lane). The approvals LIST route already enriches
 * these rows via the feature-registered projector (`getAssistantActionProjector`);
 * `/reviews` simply never called it. This does — the SAME projector, so core stays
 * feature-agnostic (feature → core only).
 *
 * The signals ride EXISTING `ReviewRequest` fields (`risk` + `summary`, the
 * data-driven `ReviewCard` shape the sibling branches use — no new UI): the
 * per-kind `riskLevel` becomes the chip level, and taint / recipient-diff / the
 * agent's reason / the edited flag become the risk REASONS. The `summary` is
 * refreshed from the LIVE draft + recipients so an edited draft is re-described,
 * and the current draft body is surfaced as an inline asset so the reviewer
 * approves what will actually be sent. Enriches only PENDING rows: a resolved
 * assistant-action is an audit row, and its live draft may already be redacted.
 */
export async function withAssistantActionView(review: ReviewRequest, a: PendingApproval, ctx: ReviewAuthCtx): Promise<ReviewRequest> {
  if (a.kind !== 'assistant-action' || a.status !== 'pending') return review;
  // ADR 0862 — no decision without the card the decision must bind to. This
  // also covers old/missing action rows and an unavailable feature projector.
  const unavailable = { ...review, canDecide: false };
  if (!a.actionId) return unavailable;
  const projector = getAssistantActionProjector();
  if (!projector) return unavailable;
  // ADR 0862 — the card (draft, recipients, event body) is withheld from a reader without
  // the action's write authority; the review itself stays visible, un-enriched.
  const action = await projector(a.tenantId, a.actionId, {
    ...(ctx.subjectRef ? { subject: ctx.subjectRef } : {}),
    isOperator: ctx.viewerExits?.isOperator === true,
    isPersonalOwner: ctx.viewerExits?.isPersonalOwner === true,
  });
  if (!action || action.withheld === true) return unavailable;

  const kind = typeof action.kind === 'string' ? action.kind : undefined;
  const draft = typeof action.draft === 'string' ? action.draft : undefined;
  const riskLevel = action.riskLevel === 'low' || action.riskLevel === 'medium' || action.riskLevel === 'high'
    ? action.riskLevel
    : undefined;
  const tainted = action.derivedFromUntrusted === true;
  const reason = typeof action.reason === 'string' && action.reason.length > 0 ? action.reason : undefined;
  const editedAt = typeof action.editedAt === 'string' ? action.editedAt : undefined;
  const rawTo = (action.payload as { to?: unknown } | undefined)?.to;
  const to = Array.isArray(rawTo)
    ? (rawTo as unknown[]).filter((x): x is string => typeof x === 'string').join(', ')
    : typeof rawTo === 'string' ? rawTo : undefined;
  const diff = action.recipientDiff as { before?: unknown; after?: unknown } | undefined;
  const recipientDiff = diff && Array.isArray(diff.before) && Array.isArray(diff.after)
    ? {
        before: (diff.before as unknown[]).filter((x): x is string => typeof x === 'string'),
        after: (diff.after as unknown[]).filter((x): x is string => typeof x === 'string'),
      }
    : undefined;

  // ADR 0027 safety signals → risk reasons (ordered most-important first).
  const reasons: string[] = [];
  if (tainted) reasons.push('Derived from untrusted connected content');
  if (recipientDiff) reasons.push(`Recipients changed: ${recipientDiff.before.join(', ') || '(none)'} → ${recipientDiff.after.join(', ') || '(none)'}`);
  if (editedAt) reasons.push('Draft edited since it was proposed');
  if (reason) reasons.push(reason);
  // A tainted action is elevated even absent an explicit riskLevel (the taint IS
  // the risk); otherwise fall back to `medium` only when there is something to say.
  const level = riskLevel ?? (tainted || recipientDiff ? 'medium' : reasons.length > 0 ? 'low' : undefined);

  // Refresh the summary from the LIVE draft so an edited draft is re-described
  // (the frozen enqueue snapshot is what COS-14 flags as stale).
  const draftHead = draft ? (draft.length > 80 ? `${draft.slice(0, 77)}…` : draft) : undefined;
  const summary = kind && draftHead ? `${kind}: "${draftHead}"${to ? ` → ${to}` : ''}` : review.summary;

  return {
    ...review,
    ...(summary ? { summary } : {}),
    ...(level ? { risk: { level, reasons } } : {}),
    // The concrete thing being approved — an inline preview of the current draft
    // (the frozen 77-char summary was all the reviewer could see before).
    ...(draft ? { assets: [...(review.assets ?? []), { label: 'Draft', content: draft }] } : {}),
    // ADR 0862 — the fields + the hash, from the SAME projector output the inbox renders:
    // without them this lane could only approve blind, and under D1 not at all.
    ...(kind && typeof action.contentHash === 'string' && typeof action.actionId === 'string'
      ? {
          assistantAction: {
            actionId: action.actionId,
            kind,
            contentHash: action.contentHash,
            payload: action.payload && typeof action.payload === 'object' ? (action.payload as Record<string, unknown>) : {},
          },
        }
      : {}),
  };
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
  // ADR 0473 — an EXPIRED composed-workflow proposal is terminal for the UI:
  // approve is a guaranteed 409, so offer no actions and project `expired`
  // (the retention sweep resolves the row; the card just stops inviting).
  const composedExpired = a.kind === 'composed-workflow' && a.status === 'pending'
    && !!a.composedWorkflow?.expiresAt && Date.parse(a.composedWorkflow.expiresAt) < Date.now();
  const actions: ReviewAction[] = a.status === 'pending' && !composedExpired
    ? [{ action: 'approve', label: kind === 'run-proposal' || kind === 'composed-workflow' ? 'Approve & run' : 'Approve' }, { action: 'reject', label: 'Reject' }]
    : [];
  // ADR 0469 Phase C — an anon-surface-write is a bounded write REQUESTED BY AN
  // ANONYMOUS INTERNET VISITOR, held for a human decision. Surface that plainly: an
  // opaque-principal requester (RFC 0048 — never PII) labelled "Anonymous visitor" +
  // a risk chip so an operator triages it as elevated-trust before approving. Data-
  // driven — `ReviewCard` already renders `risk` + `requestedBy.label`, no new UI.
  const anonWrite = a.kind === 'anon-surface-write' ? a.anonSurfaceWrite : undefined;
  // ADR 0473 — a composed-workflow proposal is an AGENT-authored, not-yet-run
  // workflow: attribute it to the composing agent and chip it as elevated
  // review (the definition is not from the catalog; approval executes it).
  const composed = a.kind === 'composed-workflow' ? a.composedWorkflow : undefined;
  const requestedBy: ReviewRequest['requestedBy'] = anonWrite
    ? { kind: 'system', id: anonWrite.principal, label: 'Anonymous visitor' }
    : composed?.agentProfileId
      ? { kind: 'agent', id: composed.agentProfileId }
      : a.rosterId
        ? { kind: 'agent', id: a.rosterId, ...(a.persona ? { label: a.persona } : {}) }
        : { kind: 'system', id: a.approvalId };
  const risk: ReviewRequest['risk'] | undefined = anonWrite
    ? { level: 'medium', reasons: ['Anonymous website visitor', `Held write: ${anonWrite.tool.name}`] }
    : composed
      ? { level: 'medium', reasons: ['Agent-composed workflow (not from the catalog)', 'Approval starts the run'] }
      : undefined;
  // ADR 0470 — when the held write captured a LEAD (email/name/note on the flat
  // `captured*` fields), surface it as the card summary so the operator can decide
  // WITHOUT opening the payload. These are OD4-redactor-covered, so an erased row
  // shows the sentinel here (correct). Falls back to the generic `proposal`.
  const leadSummary = anonWrite?.capturedEmail
    ? `New lead: ${[anonWrite.capturedName, anonWrite.capturedEmail].filter(Boolean).join(' ')}${anonWrite.capturedNote ? ` — ${anonWrite.capturedNote}` : ''}`
    : undefined;
  return {
    reviewId: `approval:${a.approvalId}`,
    source: 'approval',
    kind,
    ...(a.workflowId ? { workflowId: a.workflowId, workflowName: a.workflowId } : {}),
    status: composedExpired ? 'expired' : approvalStatusToReview(a.status),
    tenantId: a.tenantId,
    ...(a.orgId ? { orgId: a.orgId } : {}),
    approvalId: a.approvalId,
    ...(kind === 'email-campaign-send' && a.emailSend ? { emailSend: {
      campaignId: a.emailSend.campaignId, templateId: a.emailSend.templateId, templateVersion: a.emailSend.templateVersion,
      contentHash: a.emailSend.contentHash, reviewHash: a.emailSend.reviewHash, senderAddress: a.emailSend.senderAddress,
      audienceHash: a.emailSend.audienceHash, audienceLabel: a.emailSend.audienceLabel, templateName: a.emailSend.templateName,
      subject: a.emailSend.subject, body: a.emailSend.body, format: a.emailSend.format, estimatedRecipients: a.emailSend.estimatedRecipients,
    } } : {}),
    ...(a.conversationId ? { conversationId: a.conversationId } : {}),
    ...(a.runId ? { runId: a.runId } : {}),
    requestedBy,
    requestedAt: a.createdAt,
    ...(risk ? { risk } : {}),
    ...(leadSummary ? { summary: leadSummary } : a.proposal ? { summary: a.proposal } : {}),
    // ADR 0478 §3 — the agent's stated reasoning (a claim, labeled as such).
    ...(a.reasoning ? { reasoning: a.reasoning } : {}),
    ...(a.status !== 'pending' && a.note ? { decisionNote: a.note } : {}),
    // ADR 0501 step 4 — ids only; see the `planProposal` doc on ReviewRequest for why the
    // note and coachSubject are NOT copied and why the preview is not projected.
    ...(a.planProposal
      ? { planProposal: { enrollmentId: a.planProposal.enrollmentId, proposalId: a.planProposal.proposalId } }
      : {}),
    ...(composed
      ? {
          composedWorkflow: {
            definitionHash: composed.definitionHash,
            ...(composed.agentProfileId ? { agentProfileId: composed.agentProfileId } : {}),
            nodeCount: composed.nodeCount,
            edgeCount: composed.edgeCount,
            ...(composed.expiresAt ? { expiresAt: composed.expiresAt } : {}),
            ...(composedExpired ? { expired: true } : {}),
            ...(composed.runInputs ? { runInputs: composed.runInputs } : {}),
            ...(typeof composed.estimatedFloorUsd === 'number' ? { estimatedFloorUsd: composed.estimatedFloorUsd } : {}),
            ...(typeof composed.estimatedAiNodes === 'number' ? { estimatedAiNodes: composed.estimatedAiNodes } : {}),
          },
        }
      : {}),
    actions,
    provenanceRefs: provenance,
  };
}

// ── visibility ─────────────────────────────────────────────────────────────

/**
 * Is this approval row visible to the caller?
 *
 * CORRECTED (ADR 0672 D1) — this docstring used to say the check "mirrors
 * routes/approvals.ts list gating — the SAME check, reused". **It did not.** That route
 * implemented four of the nine branches below and returned every other kind unfiltered, and
 * this sentence is why nobody looked. The nine branches now live in ONE owner
 * (`host/approvalAudience.ts`) that this function, the approvals list route and the SLA
 * notification lane all consume — so the claim is true by construction rather than by
 * assertion.
 */
async function approvalVisible(a: PendingApproval, ctx: ReviewAuthCtx, memo?: ReadMemo): Promise<boolean> {
  return mayViewApproval(ctx.tenantId, ctx.subjectRef, a, memo?.access);
}

// ── list / get ───────────────────────────────────────────────────────────

export interface ListReviewsOpts {
  /** Filter. Omitted ⇒ the pending inbox (open interrupts + pending approvals). */
  status?: ReviewStatus;
  /** ADR 0311 P2 — only reviews traced to this chat conversation (approvals
   *  carrying `conversationId`). Applied AFTER authorization — a filter, never
   *  an authz bypass. */
  conversationId?: string;
  /** ADR 0311 P3 — only reviews whose provenance names this kanban board (the
   *  board page's "Needs review" lane). Post-authz narrowing, like above. */
  boardId?: string;
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
  const memo = newReadMemo();

  // Interrupts — only meaningful for the pending inbox (the store holds OPEN ones).
  if (wantPending) {
    // Tenant-scoped in ONE query where the store supports it. The global scan
    // read every tenant's open interrupts and one run per interrupt,
    // sequentially, only to discard the other tenants': MEASURED 2026-09-28 in
    // prod at 100-120 s per inbox read, which held the 4-connection pool and
    // timed out every other read on the page.
    const open = storage.listOpenInterruptsForTenant
      ? await storage.listOpenInterruptsForTenant(ctx.tenantId, INTERRUPT_SCAN_LIMIT)
      : await storage.listOpenInterruptsAll(INTERRUPT_SCAN_LIMIT);
    if (open.length === INTERRUPT_SCAN_LIMIT) {
      log.warn('review_interrupt_scan_truncated', { limit: INTERRUPT_SCAN_LIMIT, tenantId: ctx.tenantId });
    }
    // ADR 0778 D8 — the runs of the page in ONE read, not one `getRun` per row.
    const candidates = open.filter((it) => it.kind !== 'conversation'); // a chat gate is not a review request
    const runs = await loadRuns(storage, candidates.map((it) => it.runId));
    for (const it of candidates) {
      const run = runs.get(it.runId);
      // Tenant isolation FIRST (no existence leak). The lazy timeout below
      // WRITES; on the global fallback it used to run before this check and so
      // could time out another tenant's gate from this tenant's inbox read.
      if (!run || run.tenantId !== ctx.tenantId) continue;
      // ADR 0778 D3/C11 — a terminal run's gate is waiting on no one. The SQL
      // already excludes these; this also covers the global-scan fallback.
      if (isTerminalRunStatus(run.status)) continue;
      // RFC 0093 §D lazy enforcement: an overdue approval gate auto-rejects here
      // and drops out of the inbox.
      if (await timeoutApprovalGateIfDue(storage, it)) continue;
      const review = await withMediaAssets(await withQuorumPolicy(interruptToReview(it, run), it), ctx);
      const canDecide = await interruptCanDecide(it, run, ctx, memo);
      out.push(canDecide === undefined ? review : { ...review, canDecide });
    }
  }

  // Approvals — tenant-indexed; map the review status filter to the approval status.
  const approvalStatus: ApprovalStatus | undefined =
    opts.status === 'pending' || opts.status === 'approved' || opts.status === 'rejected' ? opts.status : undefined;
  if (opts.status === undefined || approvalStatus !== undefined) {
    const approvals = await listApprovals(ctx.tenantId, approvalStatus);
    for (const a of approvals) {
      if (await approvalVisible(a, ctx, memo)) {
        // COS-14 — assistant-action rows carry the ADR 0027 safety signals via
        // `withAssistantActionView` (mutually exclusive kind with composed).
        const review = await withAssistantActionView(await withComposedLiveView(await withApprovalQuorumPolicy(approvalToReview(a), a), a), a, ctx);
        const canDecide = a.status === 'pending' ? await approvalCanDecide(a, ctx, memo) : undefined;
        out.push(review.canDecide === false || canDecide === undefined ? review : { ...review, canDecide });
      }
    }
  }

  // ADR 0311 P2/P3 — conversation/board scoping (post-authz narrowing only).
  let narrowed = out;
  if (opts.conversationId) narrowed = narrowed.filter((r) => r.conversationId === opts.conversationId);
  if (opts.boardId) narrowed = narrowed.filter((r) => r.provenanceRefs.some((ref) => ref.kind === 'board' && ref.ref === opts.boardId));
  return narrowed;
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
    // ADR 0778 D3 — an OPEN gate on a terminal run is no longer a review (404).
    // A resolved one still reads (a deep link to a decided gate is not "not
    // found" — grade-code `APCD-10`).
    if (!it.resolvedAt && isTerminalRunStatus(run.status)) return null;
    const review = await withMediaAssets(await withQuorumPolicy(interruptToReview(it, run), it), ctx);
    const canDecide = it.resolvedAt ? undefined : await interruptCanDecide(it, run, ctx, newReadMemo());
    return canDecide === undefined ? review : { ...review, canDecide };
  }
  if (source === 'approval') {
    const a = await getApproval(sourceId);
    if (!a || a.tenantId !== ctx.tenantId) return null;
    const memo = newReadMemo();
    if (!(await approvalVisible(a, ctx, memo))) return null;
    const review = await withAssistantActionView(await withComposedLiveView(await withApprovalQuorumPolicy(approvalToReview(a), a), a), a, ctx);
    const canDecide = a.status === 'pending' ? await approvalCanDecide(a, ctx, memo) : undefined;
    return review.canDecide === false || canDecide === undefined ? review : { ...review, canDecide };
  }
  return null;
}
