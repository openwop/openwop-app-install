/**
 * Approval decision core (ADR 0068 §Phase 3) — the single owner of "what a
 * claim/reject DOES".
 *
 * The claim/reject decision (handler dispatch for content-publish + assistant
 * actions, run-start + kanban for run-proposals, CAS finality, audit) used to
 * live inline in `routes/approvals.ts`. ADR 0068 adds a SECOND caller — the
 * unified `/reviews/:reviewId/actions/:action` surface — so the logic is
 * extracted here and BOTH routes call it. There is exactly one decision path;
 * the projection route never re-implements it (single-source-of-truth).
 *
 * Behavior is byte-for-byte the existing route behavior; the approvals route
 * tests are the regression guard.
 *
 * @see routes/approvals.ts — the original inbox routes (now thin callers)
 * @see host/reviewProjection.ts — the unified review surface (the new caller)
 */

import { OpenwopError } from '../types.js';
import type { HostAdapterSuite } from './index.js';
import type { Storage } from '../storage/storage.js';
import { getRosterEntry } from './rosterService.js';
import { getBoard, moveCard, setCardLastRun, notifyBoardChanged } from './kanbanService.js';
import { startWorkflowRun } from './runStarter.js';
import { resolveEffectiveAccess } from './accessControlService.js';
import { isEligibleApprover, consumeVoteIdentity } from './approverResolution.js';
import { appendDecision, tallyDecisions, evaluateQuorumTally, readRejectionPolicy } from './reviewDecisionLedger.js';
import { emitReviewUpdatedSignal } from '../notifications/notify.js';
import {
  getApproval,
  resolveApproval,
  assertApprovalEligibility,
  attachRunId,
  getAssistantActionApprovalHandler,
  getContentApprovalHandler,
  getChallengePublishApprovalHandler,
  getAnonSurfaceWriteApprovalHandler,
  getStrategyActivationApprovalHandler,
  getStrategyCheckInApprovalHandler,
  getScenarioSelectApprovalHandler,
  getContactMergeApprovalHandler,
  getPlanProposalApprovalHandler,
  getEnvironmentPromotionApprovalHandler,
  getDealerRegistrationApprovalHandler,
  getTerritoryTransitionApprovalHandler,
  getCommissionStatementApprovalHandler,
  getCommerceListingApprovalHandler,
  getComposedWorkflowApprovalHandler,
  type PendingApproval, reopenApproval } from './approvalService.js';

export interface ApprovalDecisionDeps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
}

export interface ApprovalDecisionCtx {
  tenantId: string;
  /** The deciding user/principal id (for audit + handler attribution). */
  decidedBy?: string;
  /** Optional reviewer note captured at decision time. */
  note?: string;
  /** ADR 0198 — when the decider votes as a DELEGATE covering several
   *  principals, whose approval this vote consumes. Optional when they cover
   *  exactly one; rejected when they hold no active delegation from it. */
  actedFor?: string;
  /** ADR 0385 (chat-first-port F3) — whether the deciding caller is a host
   *  SUPERADMIN, computed at the HTTP boundary (where the principal/req is known)
   *  and threaded through for host-global kinds whose authority cannot be derived
   *  from `(tenantId, decidedBy)` alone (commerce-listing-publish). Ignored by
   *  every tenant-scoped kind. */
  decidedBySuperadmin?: boolean;
  /** UX_UPGRADE-assistant R2 — the two REQUEST-level facts a kind's eligibility
   *  check cannot derive from `(tenantId, decidedBy)`, threaded from the HTTP
   *  boundary the same way `decidedBySuperadmin` is:
   *
   *  - `decidedByWildcardOperator` — `principal.tenants:['*']`, and ONLY that.
   *    Deliberately NOT `isSuperadmin`, which is strictly wider (it also returns
   *    true for any tenant listed in `OPENWOP_SUPERADMIN_TENANTS`, and for every
   *    authenticated caller under `OPENWOP_FEATURE_TOGGLES_DEV_OPEN`). Using the
   *    wider one would let a `viewer` in a superadmin-listed workspace bypass a
   *    kind's gate — re-opening the hole the gate exists to close.
   *  - `decidedByPersonalOwner` — `isOwnPersonalWorkspace(req)`, i.e. the caller
   *    acting in their OWN personal/anon sandbox. This is a comparison between
   *    the request's tenant and its `personalTenant`; it is NOT `tenantId ===
   *    decidedBy`, which is a comparison across two different id namespaces and
   *    is never true for a real session. */
  decidedByWildcardOperator?: boolean;
  decidedByPersonalOwner?: boolean;
  /** ADR 0473 — the definition hash the reviewer's card DISPLAYED when they
   *  clicked approve (approve-what-you-see). Read from the HTTP body by both
   *  thin decide routes and threaded to the composed-workflow handler, which
   *  refuses (409 `proposal_stale`) when it no longer matches the live
   *  definition. Ignored by every other kind. */
  expectedDefinitionHash?: string;
}

export interface ApprovalDecisionResult {
  approvalId: string;
  /** `pending` (ADR 0070) ⇒ a quorum vote was recorded but the gate is not yet
   *  resolved; `policy` carries the progress. */
  status: 'approved' | 'rejected' | 'pending';
  runId?: string;
  pageId?: string;
  actionId?: string;
  /** ADR 0230 §B3 — set for `strategy-activation` decisions. */
  strategyId?: string;
  /** ADR 0458 §2.2 (correction) — set for `challenge-publish` decisions: the
   *  candidate + the challenge version the act published (or declined). */
  candidateId?: string;
  challengeId?: string;
  challengeVersion?: number;
  approval?: PendingApproval;
  /** Quorum progress, present when the approval carries a multi-approver policy. */
  policy?: { requiredApprovals: number; approvals: number; rejections: number };
}

/**
 * Multi-approver gate (ADR 0070) — for an approval whose `policy.requiredApprovals
 * > 1`, each claim/reject is an eligibility-checked VOTE recorded in the durable
 * `review:decision` ledger (keyed by approvalId). Returns `finalize` only when
 * THIS outcome's threshold is met — so the caller's existing single-decision
 * finalize (run start / reject) runs exactly once, gated by the same CAS. Absent
 * policy ⇒ `finalize` immediately (the legacy path is byte-unchanged).
 */
async function evaluateQuorum(
  ctx: ApprovalDecisionCtx,
  approval: PendingApproval,
  outcome: 'approved' | 'rejected',
): Promise<{ decision: 'finalize' } | { decision: 'pending'; progress: { requiredApprovals: number; approvals: number; rejections: number } }> {
  const required = approval.policy && approval.policy.requiredApprovals > 1 ? approval.policy.requiredApprovals : 0;
  if (required === 0) return { decision: 'finalize' }; // not a quorum approval — unchanged

  // Identity is the authenticated caller — never anonymous for a quorum vote.
  const reviewerRef = ctx.decidedBy;
  if (!reviewerRef) throw new OpenwopError('forbidden', 'A quorum approval requires an authenticated approver.', 403, { approvalId: approval.approvalId });

  // Eligibility: an explicit approver list, else the approvals:respond scope.
  // INTENTIONAL DIVERGENCE from the runtime-interrupt path
  // (`routes/interrupts.ts` `assertEligibleApprover`): there an EMPTY approver
  // list is an OPEN gate (the `openwop-interrupt-quorum` conformance contract
  // requires it). HERE, an empty list still requires the `approvals:respond`
  // scope — pre-execution approvals start runs / publish pages (higher stakes),
  // are NOT on the RFC 0093 token wire, and have no conformance obligation, so
  // they stay default-secure. Do NOT "unify" these two without re-checking the
  // quorum conformance scenario.
  // ADR 0075 §D1/§D2 — resolve the gate's approver refs (explicit subjects ∪
  // group members ∪ role holders) through the single resolver, live + org-scoped.
  // A non-open gate admits ONLY the resolved subjects; an open gate (no refs of
  // any kind) keeps this surface's default-secure `approvals:respond` requirement
  // (the INTENTIONAL divergence from the interrupt path documented above).
  const gateRefs = {
    ...(approval.policy?.approverRefs ? { approverRefs: approval.policy.approverRefs } : {}),
    ...(approval.policy?.approverGroupRefs ? { approverGroupRefs: approval.policy.approverGroupRefs } : {}),
    ...(approval.policy?.approverRoleRefs ? { approverRoleRefs: approval.policy.approverRoleRefs } : {}),
  };
  const gateCtx = { tenantId: ctx.tenantId, ...(approval.orgId ? { orgId: approval.orgId } : {}) };
  const { eligible, openGate } = await isEligibleApprover(reviewerRef, gateRefs, gateCtx);
  if (!openGate) {
    if (!eligible) throw new OpenwopError('forbidden', 'You are not an eligible approver for this gate.', 403, { approvalId: approval.approvalId });
  } else {
    const access = await resolveEffectiveAccess(ctx.tenantId, { subject: reviewerRef, ...(approval.orgId ? { orgId: approval.orgId } : {}) });
    if (!(access.scopes as readonly string[]).includes('approvals:respond')) {
      throw new OpenwopError('forbidden', 'Approving this gate requires the approvals:respond scope.', 403, { approvalId: approval.approvalId });
    }
  }

  // ADR 0198 §identity — the vote consumes exactly ONE identity: the reviewer
  // themselves when directly eligible (or on an open gate), else the single
  // principal their active delegation covers (explicit `actedFor` when they
  // cover several). The ledger dedups on the CONSUMED identity, so a
  // principal + delegate pair can never count twice.
  const identity = openGate
    ? { countAs: reviewerRef }
    : await consumeVoteIdentity(reviewerRef, gateRefs, gateCtx, ctx.actedFor);

  // Record (dedup per consumed identity) + tally the durable ledger.
  await appendDecision({
    gateId: approval.approvalId,
    reviewerRef: identity.countAs,
    ...('actedBy' in identity && identity.actedBy ? { actedBy: identity.actedBy } : {}),
    tenantId: approval.tenantId, // ADR 0464 — tenant-scope the row for subject erasure.
    outcome,
    ...(ctx.note ? { reason: ctx.note } : {}),
    decidedAt: new Date().toISOString(),
  });
  const tally = await tallyDecisions(approval.approvalId);
  const progress = { requiredApprovals: required, approvals: tally.accepts.length, rejections: tally.rejects.length };

  // Single source of truth for the threshold + rejection math (ADR 0070), shared
  // with the runtime-interrupt path. Finalize only when THIS vote's outcome is the
  // one the tally now resolves to (a claim never starts the run on a reject-won
  // gate, and vice-versa).
  const verdict = evaluateQuorumTally(tally, {
    requiredApprovals: required,
    // ADR 0600 §6 — the shared READER (coerce, never refuse; see its docblock).
    rejectionPolicy: readRejectionPolicy(approval.policy?.rejectionPolicy),
  });
  if ((outcome === 'approved' && verdict === 'accept') || (outcome === 'rejected' && verdict === 'reject')) {
    return { decision: 'finalize' };
  }
  return { decision: 'pending', progress };
}

/** Fetch + tenant-guard a pending approval, or throw the canonical error. Shared
 *  by both decision verbs so the not-found / already-resolved mapping is uniform. */
async function loadPending(tenantId: string, approvalId: string): Promise<PendingApproval> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId) {
    throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId });
  }
  if (approval.status !== 'pending') {
    throw new OpenwopError('conflict', `Approval already ${approval.status}.`, 409, { status: approval.status });
  }
  return approval;
}

function auditDecision(deps: ApprovalDecisionDeps, ctx: ApprovalDecisionCtx, action: string, resource: string, payload: Record<string, unknown>): void {
  void deps.storage
    .appendAudit({
      timestamp: new Date().toISOString(),
      principalId: ctx.decidedBy ?? 'unknown',
      action,
      resource,
      outcome: 'success',
      payload,
    })
    .catch(() => {});
}

/** ADR 0074 — broadcast a `review.updated` cache hint after an approval decision
 *  (or quorum vote) so every live review surface (chat card, Reviews tab, inbox)
 *  reconciles regardless of which surface/client decided it. The reviewId mirrors
 *  the ADR 0068 projection (`approval:${approvalId}`). Best-effort + non-persisted. */
function announceReview(tenantId: string, result: ApprovalDecisionResult): ApprovalDecisionResult {
  emitReviewUpdatedSignal({
    tenantId,
    reviewId: `approval:${result.approvalId}`,
    status: result.status,
    approvalId: result.approvalId,
    ...(result.runId ? { runId: result.runId } : {}),
    ...(result.policy ? { policy: result.policy } : {}),
  });
  return result;
}

// ── kind → decision dispatch (APPR-1 / APPR-2) ───────────────────────────────
// The claim/reject verbs used to inline the same fetch-handler → run → map-errors
// → audit → announce sequence per feature kind (24 branches, no exhaustiveness
// guard). That shape is now ONE table keyed by `PendingApproval['kind']`: each
// feature kind names its handler-getter, its "not composed" label, and functions
// yielding its audit (action + resource + payload) and result echo. The
// `satisfies Record<DecidableKind, …>` below makes a NEW approval kind that lacks
// an entry a COMPILE error — the guard the if-chain never had.

/** The common shape every feature-registered decision handler satisfies: apply
 *  the governed effect (enforcing its own scope + IDOR) and report whether THIS
 *  call performed the pending→resolved transition. The superset `opts` carries
 *  `isSuperadmin` for the one host-global kind (commerce-listing-publish);
 *  tenant-scoped handlers ignore it (they are assignable to this wider type). */
type FeatureApprovalHandler = (
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string; isSuperadmin?: boolean; expectedDefinitionHash?: string },
) => Promise<{ approval: PendingApproval; changed: boolean } | null>;

/** One feature kind's decision recipe — everything the shared dispatcher needs to
 *  run the claim OR reject of that kind identically. */
interface FeatureKindDispatch {
  /** The core hook the owning feature registered its handler on. */
  getHandler: () => FeatureApprovalHandler | null;
  /** Label for the "…​ feature is not composed on this host." 409. */
  notComposedLabel: string;
  /** Audit action + resource + payload for this (kind, outcome). */
  audit: (a: PendingApproval, outcome: 'approved' | 'rejected') => { action: string; resource: string; payload: Record<string, unknown> };
  /** Extra handler opts derived from the decision context —
   *  commerce-listing-publish threads `isSuperadmin`; composed-workflow
   *  threads `expectedDefinitionHash` (ADR 0473). */
  handlerOpts?: (ctx: ApprovalDecisionCtx) => { isSuperadmin?: boolean; expectedDefinitionHash?: string };
  /** Extra result fields echoed to the caller (pageId / strategyId / the
   *  composed-workflow runId). Receives the DECIDED row (post-handler), so
   *  fields the handler attaches (`runId`) are visible. */
  result?: (a: PendingApproval) => Partial<ApprovalDecisionResult>;
}

/** Every decidable approval kind (the `kind` union; absent ⇒ `run-proposal`). */
type DecidableKind = NonNullable<PendingApproval['kind']>;
/** A kind either dispatches through a feature recipe, or keeps one of the three
 *  bespoke finalizers (run-proposal / campaign-spend / assistant-action). */
type KindDisposition =
  | FeatureKindDispatch
  | 'run-proposal'
  | 'campaign-spend'
  | 'assistant-action'
  | 'compensation-action';

/** The shared `{ approvalId, tenantId }` head every audit payload carries. */
const baseAuditPayload = (a: PendingApproval): Record<string, unknown> => ({ approvalId: a.approvalId, tenantId: a.tenantId });

const KIND_DISPATCH = {
  // ADR 0066 — content-publish: the CMS handler publishes/rejects the page.
  'content-publish': {
    getHandler: getContentApprovalHandler,
    notComposedLabel: 'CMS',
    audit: (a, o) => ({ action: o === 'approved' ? 'cms.page.published' : 'cms.page.rejected', resource: `cms-page:${a.pageId}`, payload: { ...baseAuditPayload(a), orgId: a.orgId } }),
    result: (a) => ({ pageId: a.pageId }),
  },
  // ADR 0264 / CDP-B — contact-merge: the CRM handler merges (approve) / declines.
  'contact-merge': {
    getHandler: getContactMergeApprovalHandler,
    notComposedLabel: 'CRM',
    audit: (a, o) => o === 'approved'
      ? { action: 'crm.contact.merged', resource: `crm-contact:${a.survivorContactId}`, payload: { ...baseAuditPayload(a), sourceContactId: a.sourceContactId } }
      : { action: 'crm.contact.merge_rejected', resource: `crm-contact:${a.survivorContactId}`, payload: baseAuditPayload(a) },
  },
  // ADR 0459 P2 — kicktodo-plan-proposal: the participant's accept/decline.
  'kicktodo-plan-proposal': {
    getHandler: getPlanProposalApprovalHandler,
    notComposedLabel: 'KickTodo accountability',
    audit: (a, o) => ({ action: o === 'approved' ? 'kicktodo.plan-proposal.approved' : 'kicktodo.plan-proposal.rejected', resource: `kicktodo-enrollment:${a.planProposal?.enrollmentId ?? a.approvalId}`, payload: baseAuditPayload(a) }),
  },
  // ADR 0387 / H2 — environment-promotion: the pointer move (approve) / rejected row.
  'environment-promotion': {
    getHandler: getEnvironmentPromotionApprovalHandler,
    notComposedLabel: 'Environments',
    audit: (a, o) => ({ action: o === 'approved' ? 'environments.promotion.approved' : 'environments.promotion.rejected', resource: `env:${a.envPromotion?.toEnv ?? a.approvalId}`, payload: baseAuditPayload(a) }),
  },
  // ADR 0385 (chat-first-port F3) — commerce-listing-publish: operator (SUPERADMIN)
  // flips the listing; `isSuperadmin` is threaded from the HTTP boundary.
  'commerce-listing-publish': {
    getHandler: getCommerceListingApprovalHandler,
    notComposedLabel: 'Commerce Connect',
    audit: (a, o) => ({ action: o === 'approved' ? 'commerce-connect.listing.approved' : 'commerce-connect.listing.rejected', resource: `commerce-listing:${a.commerceListing?.packName ?? a.approvalId}`, payload: baseAuditPayload(a) }),
    handlerOpts: (ctx) => (ctx.decidedBySuperadmin ? { isSuperadmin: true } : {}),
  },
  // CFP-1 (D9) — the field-sales trio (formerly via dispatchFieldSalesDecision).
  'dealer-registration': {
    getHandler: getDealerRegistrationApprovalHandler,
    notComposedLabel: 'Dealers',
    audit: (a, o) => ({ action: o === 'approved' ? 'dealers.registration.approved' : 'dealers.registration.rejected', resource: `dealer-registration:${a.dealerRegistration?.regId ?? a.approvalId}`, payload: { ...baseAuditPayload(a), orgId: a.orgId } }),
  },
  'territory-model-transition': {
    getHandler: getTerritoryTransitionApprovalHandler,
    notComposedLabel: 'Territories',
    audit: (a, o) => ({ action: `territories.model.${a.territoryTransition?.transition ?? 'transition'}-${o === 'approved' ? 'approved' : 'rejected'}`, resource: `territory-model:${a.territoryTransition?.modelId ?? a.approvalId}`, payload: { ...baseAuditPayload(a), orgId: a.orgId } }),
  },
  'commission-statement': {
    getHandler: getCommissionStatementApprovalHandler,
    notComposedLabel: 'Sales Commissions',
    audit: (a, o) => ({ action: o === 'approved' ? 'commissions.statement.approved' : 'commissions.statement.rejected', resource: `commission-statement:${a.commissionStatement?.statementId ?? a.approvalId}`, payload: { ...baseAuditPayload(a), orgId: a.orgId } }),
  },
  // ADR 0230 §B3 — strategy-activation: the strategy transition; echoes strategyId.
  'strategy-activation': {
    getHandler: getStrategyActivationApprovalHandler,
    notComposedLabel: 'Strategy',
    audit: (a, o) => ({ action: o === 'approved' ? 'strategy.strategy.activation-approved' : 'strategy.strategy.activation-rejected', resource: `strategy:${a.strategyId}`, payload: { ...baseAuditPayload(a), orgId: a.orgId } }),
    result: (a) => ({ strategyId: a.strategyId }),
  },
  // CHAT-FIRST-PORT-AUDIT D3 — strategy-checkin: confirm (approve) / dismiss (reject).
  'strategy-checkin': {
    getHandler: getStrategyCheckInApprovalHandler,
    notComposedLabel: 'Strategy',
    audit: (a, o) => ({ action: o === 'approved' ? 'strategy.checkin.confirmed' : 'strategy.checkin.dismissed', resource: `strategy:${a.strategyId}`, payload: { ...baseAuditPayload(a), orgId: a.orgId, checkInId: a.strategyCheckIn?.checkInId } }),
    result: (a) => ({ strategyId: a.strategyId }),
  },
  // CHAT-FIRST-PORT-AUDIT D3 — pm-scenario-select: select as plan of record / decline.
  'pm-scenario-select': {
    getHandler: getScenarioSelectApprovalHandler,
    notComposedLabel: 'Priority Matrix',
    audit: (a, o) => ({ action: o === 'approved' ? 'priority-matrix.scenario.selected' : 'priority-matrix.scenario.select-rejected', resource: `pm-scenario:${a.scenarioSelect?.scenarioId ?? a.approvalId}`, payload: { ...baseAuditPayload(a), orgId: a.orgId } }),
  },
  // ADR 0469 — anon-surface-write: the anonymousActor handler EXECUTES the held
  // tool + egress on approve (deferred execution), records nothing on reject. A
  // REGISTERED handler (not the run-proposal fallthrough — its `workflowId` is
  // empty, which the run-proposal finalizer would 422 on).
  'anon-surface-write': {
    getHandler: getAnonSurfaceWriteApprovalHandler,
    notComposedLabel: 'Anonymous surface',
    audit: (a, o) => ({ action: o === 'approved' ? 'anon.surface.write.approved' : 'anon.surface.write.rejected', resource: `widget:${a.anonSurfaceWrite?.widgetId ?? a.approvalId}`, payload: { ...baseAuditPayload(a), tool: a.anonSurfaceWrite?.tool.name } }),
  },
  // ADR 0473 — composed-workflow: the propose→review→approve-to-run gate. The
  // registered handler (host/workflowComposeTool.ts) EXECUTES on approve — CAS
  // first, then the post-CAS definition-hash re-verify (approve-what-you-see),
  // then the ONE startWorkflowRun recipe; reject archives the transient draft.
  // `result` reads the DECIDED row so the approve response carries the runId.
  'composed-workflow': {
    getHandler: getComposedWorkflowApprovalHandler,
    notComposedLabel: 'Workflow proposals',
    audit: (a, o) => ({ action: o === 'approved' ? 'workflows.proposal.approved' : 'workflows.proposal.rejected', resource: `workflow:${a.workflowId}`, payload: { ...baseAuditPayload(a), definitionHash: a.composedWorkflow?.definitionHash, ...(a.composedWorkflow?.approvedDefinitionHash ? { approvedDefinitionHash: a.composedWorkflow.approvedDefinitionHash } : {}), agentProfileId: a.composedWorkflow?.agentProfileId } }),
    handlerOpts: (ctx) => (ctx.expectedDefinitionHash !== undefined ? { expectedDefinitionHash: ctx.expectedDefinitionHash } : {}),
    result: (a) => ({ ...(a.runId ? { runId: a.runId } : {}) }),
  },
  // Bespoke finalizers, kept inline in claim/reject below.
  'run-proposal': 'run-proposal',
  'campaign-spend': 'campaign-spend',
  'assistant-action': 'assistant-action',
  // R2 UCP-P2-B1 (review B-1) — commerce-spend is a SPEND SIGN-OFF, not a run: the
  // claim IS the approve. It used to fall through to the run-proposal finalizer, which
  // requires a roster entry and a resolvable `workflowId` — and
  // `createCommerceSpendApproval` writes both EMPTY, so every Approve threw
  // "Proposing agent no longer exists" and left the row pending. The comment here
  // claimed these were "decided on their own feature routes"; no such route exists,
  // and every test in the repo approved by calling `resolveApproval` directly, which
  // is exactly why the gap was invisible. (The same trap is documented 20 lines above
  // for `anon-surface-write`.) `campaign-spend` is the correct disposition: resolve +
  // audit, no dispatch — the feature re-checks the approval on its next attempt.
  'commerce-spend': 'campaign-spend',
  // Decided on their own feature routes; if one ever reaches the core it falls
  // through the run-proposal path exactly as the pre-refactor if-chain did.
  'warehouse-load': 'run-proposal',
  // ADR 0458 §2.2 (correction, 2026-09-15) — challenge-publish is a PUBLICATION
  // SIGN-OFF, not a run: the kicktodo-creator handler completes the publication on
  // approve (SoD + gates re-run inside `completePublication`) and resolves on
  // reject. It used to fall through to the run-proposal finalizer, whose roster
  // lookup 404'd on the factory's persona id (`host:kicktodo-factory` is not a
  // roster row), so the inbox could reject but never approve — and the creator's
  // own complete route had no client after ADR 0458 P4. Same trap as
  // commerce-spend above; same cure: a registered handler.
  'challenge-publish': {
    getHandler: getChallengePublishApprovalHandler,
    notComposedLabel: 'KickTodo Creator',
    audit: (a, o) => ({ action: o === 'approved' ? 'kicktodo.challenge.published' : 'kicktodo.challenge.publish-rejected', resource: `kicktodo-candidate:${a.challengePublish?.candidateId ?? a.approvalId}`, payload: { ...baseAuditPayload(a), challengeId: a.challengePublish?.challengeId, challengeVersion: a.challengePublish?.challengeVersion } }),
    result: (a) => ({ ...(a.challengePublish ? { candidateId: a.challengePublish.candidateId, challengeId: a.challengePublish.challengeId, challengeVersion: a.challengePublish.challengeVersion } : {}) }),
  },
  'community-profile': 'run-proposal',
  'community-review': 'run-proposal',
  'metrics-verifier-sample': 'run-proposal',
  'connect-seller': 'run-proposal',
  // ADR 0554 P2 / RFC 0151 §E — compensation-action: the decision IS the whole
  // act here. There is no handler to dispatch, because the unwind that raised
  // this card has already stopped at the paused obligation; resuming it is P3
  // (Operations recovery), and the ledger row is what the resume reads.
  //
  // Its OWN disposition rather than reusing `campaign-spend`: that finalizer
  // audits as `campaign.ads.spend-approved`, and §E requires every override to
  // be audited — an audit line naming an ad budget for an authorization to
  // reverse a payment is worse than no line, because it is greppable and wrong.
  'compensation-action': 'compensation-action',
} satisfies Record<DecidableKind, KindDisposition>;

/**
 * Run one feature kind's claim OR reject: fetch its handler, dispatch (with any
 * extra opts), map the not-composed / vanished / already-resolved cases to the
 * canonical errors, audit, announce. The ONE shape all feature kinds share
 * (APPR-1/APPR-2) — including the former field-sales trio.
 */
/** ADR 0478 (review HIGH-3) — kinds whose REJECT runs feature side effects
 *  through the dispatch table (page transitions, merges, draft archival…).
 *  A system actor (the SLA expire rung) must never raw-reject these — the
 *  approval row would flip while the feature state stays wedged. */
export function kindHasRejectSideEffects(kind: string | undefined): boolean {
  const disposition = KIND_DISPATCH[(kind ?? 'run-proposal') as keyof typeof KIND_DISPATCH];
  if (typeof disposition === 'object') return true;
  return disposition === 'campaign-spend' || disposition === 'assistant-action' || kind === 'composed-workflow';
}

async function dispatchFeatureDecision(
  deps: ApprovalDecisionDeps,
  ctx: ApprovalDecisionCtx,
  approval: PendingApproval,
  outcome: 'approved' | 'rejected',
  dispatch: FeatureKindDispatch,
): Promise<ApprovalDecisionResult> {
  const handler = dispatch.getHandler();
  if (!handler) throw new OpenwopError('conflict', `${dispatch.notComposedLabel} feature is not composed on this host.`, 409, {});
  const decided = await handler(approval.tenantId, approval.approvalId, outcome, {
    ...(ctx.decidedBy ? { decidedByUserId: ctx.decidedBy } : {}),
    ...(ctx.note !== undefined ? { note: ctx.note } : {}),
    ...(dispatch.handlerOpts ? dispatch.handlerOpts(ctx) : {}),
  });
  if (!decided) throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId: approval.approvalId });
  if (!decided.changed) throw new OpenwopError('conflict', `Approval already ${decided.approval.status}.`, 409, { status: decided.approval.status });
  // Grade-code C2 — audit the DECIDED row: composed-workflow's handler attaches
  // the verified live hash + runId there; the pre-decision row would record
  // only the propose-time pin (forensically wrong for an edited-approve).
  const { action, resource, payload } = dispatch.audit(decided.approval, outcome);
  auditDecision(deps, ctx, action, resource, payload);
  return announceReview(approval.tenantId, {
    approvalId: approval.approvalId,
    status: outcome,
    // The DECIDED row (post-handler) — composed-workflow's handler attaches the
    // started runId there (ADR 0473); the pre-decision fields all kinds echo
    // (pageId / strategyId) are identical on both rows.
    ...(dispatch.result ? dispatch.result(decided.approval) : {}),
  });
}

/**
 * Claim (affirmatively decide) a pending approval. Branches by kind exactly as
 * the original route did:
 *  - content-publish → CMS handler (publishes the page, enforces org RBAC + IDOR);
 *  - assistant-action → assistant handler (marks the typed PendingAction);
 *  - run-proposal     → resolve-before-dispatch CAS, then start the run + kanban.
 * Throws OpenwopError (404/409/422) on the same conditions as before.
 */
export async function claimApproval(
  deps: ApprovalDecisionDeps,
  ctx: ApprovalDecisionCtx,
  approvalId: string,
): Promise<ApprovalDecisionResult> {
  const { tenantId, decidedBy, note } = ctx;
  const approval = await loadPending(tenantId, approvalId);
  // KTFULL-B2 — the kind's OWNER states who may decide; enforced BEFORE any
  // vote records or handler dispatches (403, never a silent resolve).
  await assertApprovalEligibility(tenantId, decidedBy, approval, {
    isOperator: ctx.decidedByWildcardOperator === true,
    isPersonalOwner: ctx.decidedByPersonalOwner === true,
  });

  // ADR 0070 — multi-approver gate: a claim is a VOTE. Until quorum is met the
  // approval stays pending (no handler dispatch / run start); only the vote that
  // meets quorum falls through to the single-decision finalize below.
  const quorum = await evaluateQuorum(ctx, approval, 'approved');
  if (quorum.decision === 'pending') {
    return announceReview(tenantId, { approvalId: approval.approvalId, status: 'pending', policy: quorum.progress });
  }

  // APPR-1 — every feature kind (content-publish, contact-merge, the strategy /
  // PM / environments / commerce-listing / field-sales gates) resolves through
  // the ONE dispatch table: the claim IS that kind's approve.
  const disposition = KIND_DISPATCH[approval.kind ?? 'run-proposal'];
  if (typeof disposition === 'object') {
    return dispatchFeatureDecision(deps, ctx, approval, 'approved', disposition);
  }

  // Campaign gap plan §5B B3 — campaign-spend: the claim IS the approve; no
  // handler, no run. The ads adapter re-checks the record (by spendIdemKey) on
  // the next dispatch/budget attempt, so approve-then-rerun proceeds.
  if (disposition === 'campaign-spend') {
    const lock = await resolveApproval(approval.approvalId, { status: 'approved', ...(decidedBy ? { decidedBy } : {}), ...(note !== undefined ? { note } : {}) });
    if (!lock) throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId: approval.approvalId });
    if (!lock.changed) throw new OpenwopError('conflict', `Approval already ${lock.approval.status}.`, 409, { status: lock.approval.status });
    // A commerce purchase and an ad budget share this finalizer but not their audit
    // trail: a money event must be greppable by the lane that produced it.
    const isCommerce = approval.kind === 'commerce-spend';
    auditDecision(deps, ctx, isCommerce ? 'commerce.spend-approved' : 'campaign.ads.spend-approved', `${isCommerce ? 'commerce-spend' : 'campaign-spend'}:${approval.spendIdemKey ?? approval.approvalId}`, {
      approvalId: approval.approvalId, tenantId, platform: approval.platform, spendKind: approval.spendKind, dailyBudgetMinor: approval.dailyBudgetMinor,
      ...(isCommerce ? { amountMinor: approval.amountMinor, amountCurrency: approval.amountCurrency } : {}),
    });
    return announceReview(tenantId, { approvalId: approval.approvalId, status: 'approved' });
  }

  // ADR 0554 P2 / RFC 0151 §E — compensation-action: authorize ONE inverse
  // effect. Resolve + audit, no dispatch. The eligibility check registered by
  // `compensationRuntime` has already run at the shared choke above, so the
  // separation-of-duties rule holds on every decide path, not just this one.
  if (disposition === 'compensation-action') {
    const lock = await resolveApproval(approval.approvalId, { status: 'approved', ...(decidedBy ? { decidedBy } : {}), ...(note !== undefined ? { note } : {}) });
    if (!lock) throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId: approval.approvalId });
    if (!lock.changed) throw new OpenwopError('conflict', `Approval already ${lock.approval.status}.`, 409, { status: lock.approval.status });
    auditDecision(deps, ctx, 'compensation.inverse-approved', `compensation:${approval.compensationAction?.compensationId ?? approval.approvalId}`, {
      approvalId: approval.approvalId, tenantId,
      runId: approval.compensationAction?.runId,
      nodeId: approval.compensationAction?.nodeId,
      compensationNodeTypeId: approval.compensationAction?.compensationNodeTypeId,
    });
    return announceReview(tenantId, { approvalId: approval.approvalId, status: 'approved' });
  }

  // ADR 0023 §12 T4 — assistant-action: the claim marks the typed PendingAction.
  if (disposition === 'assistant-action') {
    const handler = getAssistantActionApprovalHandler();
    if (!handler) throw new OpenwopError('conflict', 'Assistant feature is not composed on this host.', 409, {});
    const decided = await handler(tenantId, approval.approvalId, 'approved', {
      ...(decidedBy ? { decidedByUserId: decidedBy } : {}),
      ...(note !== undefined ? { note } : {}),
    });
    if (!decided) throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId: approval.approvalId });
    if (!decided.changed) throw new OpenwopError('conflict', `Approval already ${decided.approval.status}.`, 409, { status: decided.approval.status });
    auditDecision(deps, ctx, 'assistant.action.approved', `assistant-action:${approval.actionId}`, { approvalId: approval.approvalId, tenantId });
    return announceReview(tenantId, { approvalId: approval.approvalId, status: 'approved', actionId: approval.actionId });
  }

  // run-proposal: confirm the proposing member still exists before acting.
  const entry = await getRosterEntry(tenantId, approval.rosterId);
  if (!entry) {
    throw new OpenwopError('not_found', 'Proposing agent no longer exists.', 404, { rosterId: approval.rosterId });
  }
  // Pre-resolve the proposed workflow BEFORE locking, so a vanished workflow
  // fails cleanly (422) instead of leaving an approved-but-unrun approval.
  const wf = await deps.hostSuite.workflowCatalog.getWorkflow(approval.workflowId);
  if (!wf) {
    throw new OpenwopError('workflow_not_found', 'Proposed workflow no longer resolves.', 422, { workflowId: approval.workflowId });
  }
  // Resolve-before-dispatch: flip pending→approved FIRST; `changed` is the lock.
  // Only the winning claim dispatches — a concurrent claim sees changed:false.
  const lock = await resolveApproval(approval.approvalId, { status: 'approved', ...(decidedBy ? { decidedBy } : {}), ...(note !== undefined ? { note } : {}) });
  if (!lock) throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId: approval.approvalId });
  if (!lock.changed) throw new OpenwopError('conflict', `Approval already ${lock.approval.status}.`, 409, { status: lock.approval.status });

  let runId: string | null;
  try {
    runId = await startWorkflowRun(deps, {
    tenantId,
    workflowId: approval.workflowId,
    // ADR 0313 P2 — the proposal's frozen run inputs (the bare-card fallback's
    // agent-turn task). Absent ⇒ exactly the prior dispatch.
    ...(approval.configurable ? { configurable: approval.configurable } : {}),
    metadata: {
      approval: {
        rosterId: entry.rosterId,
        persona: entry.persona,
        agentId: entry.agentRef.agentId,
        boardId: approval.boardId,
        cardId: approval.cardId,
        approvalId: approval.approvalId,
        source: 'approval',
      },
    },
    });
  } catch (err) {
    // ADR 0482 review H1 — a budget refusal must not strand the approval in
    // `approved` with no run (re-decide would 409 forever). Compensate: put
    // the row back to pending so the decider can retry tomorrow, and rethrow
    // the HONEST typed error (never "workflow no longer resolves").
    if (err instanceof OpenwopError && (err.details as { reason?: string } | undefined)?.reason === 'workflow_budget_exhausted') {
      await reopenApproval(approval.approvalId).catch(() => null);
    }
    throw err;
  }
  if (!runId) {
    throw new OpenwopError('workflow_not_found', 'Proposed workflow no longer resolves.', 422, { workflowId: approval.workflowId });
  }
  await attachRunId(approval.approvalId, runId);

  // Best-effort: move the picked card to Working (the run has started).
  if (approval.boardId && approval.cardId) {
    await setCardLastRun(approval.cardId, runId);
    const board = await getBoard(approval.boardId);
    const working = board?.columns.find((c) => c.id === 'working' || c.name.toLowerCase() === 'working');
    if (working) await moveCard(approval.cardId, working.id);
    notifyBoardChanged(approval.boardId);
  }

  return announceReview(tenantId, { approvalId: approval.approvalId, status: 'approved', runId });
}

/**
 * Reject (dismiss) a pending approval. Mirrors `claimApproval`'s branching:
 * handler dispatch for content-publish / assistant-action; for a run-proposal,
 * park the board card terminally then CAS-resolve to rejected.
 */
export async function rejectApproval(
  deps: ApprovalDecisionDeps,
  ctx: ApprovalDecisionCtx,
  approvalId: string,
): Promise<ApprovalDecisionResult> {
  const { tenantId, decidedBy, note } = ctx;
  const approval = await loadPending(tenantId, approvalId);
  // KTFULL-B2 — same owner-stated eligibility on the reject lane (an ineligible
  // second identity must not be able to BLOCK a publication either).
  await assertApprovalEligibility(tenantId, ctx.decidedBy, approval, {
    isOperator: ctx.decidedByWildcardOperator === true,
    isPersonalOwner: ctx.decidedByPersonalOwner === true,
  });

  // ADR 0070 — multi-approver gate: a reject is a VOTE; the gate only fails once
  // the rejection policy is met.
  const quorum = await evaluateQuorum(ctx, approval, 'rejected');
  if (quorum.decision === 'pending') {
    return announceReview(tenantId, { approvalId: approval.approvalId, status: 'pending', policy: quorum.progress });
  }

  // APPR-1 — every feature kind resolves through the ONE dispatch table: the
  // reject IS that kind's decline (page unpublish, merge decline, strategy /
  // check-in / scenario / promotion / listing / field-sales decline).
  const disposition = KIND_DISPATCH[approval.kind ?? 'run-proposal'];
  if (typeof disposition === 'object') {
    return dispatchFeatureDecision(deps, ctx, approval, 'rejected', disposition);
  }

  if (disposition === 'campaign-spend') {
    const lock = await resolveApproval(approval.approvalId, { status: 'rejected', ...(decidedBy ? { decidedBy } : {}), ...(note !== undefined ? { note } : {}) });
    if (!lock) throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId: approval.approvalId });
    if (!lock.changed) throw new OpenwopError('conflict', `Approval already ${lock.approval.status}.`, 409, { status: lock.approval.status });
    auditDecision(deps, ctx, approval.kind === 'commerce-spend' ? 'commerce.spend-rejected' : 'campaign.ads.spend-rejected', `${approval.kind === 'commerce-spend' ? 'commerce-spend' : 'campaign-spend'}:${approval.spendIdemKey ?? approval.approvalId}`, {
      approvalId: approval.approvalId, tenantId, platform: approval.platform, spendKind: approval.spendKind, dailyBudgetMinor: approval.dailyBudgetMinor,
    });
    return announceReview(tenantId, { approvalId: approval.approvalId, status: 'rejected' });
  }

  if (disposition === 'compensation-action') {
    const lock = await resolveApproval(approval.approvalId, { status: 'rejected', ...(decidedBy ? { decidedBy } : {}), ...(note !== undefined ? { note } : {}) });
    if (!lock) throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId: approval.approvalId });
    if (!lock.changed) throw new OpenwopError('conflict', `Approval already ${lock.approval.status}.`, 409, { status: lock.approval.status });
    auditDecision(deps, ctx, 'compensation.inverse-rejected', `compensation:${approval.compensationAction?.compensationId ?? approval.approvalId}`, {
      approvalId: approval.approvalId, tenantId,
      runId: approval.compensationAction?.runId,
      nodeId: approval.compensationAction?.nodeId,
      compensationNodeTypeId: approval.compensationAction?.compensationNodeTypeId,
    });
    return announceReview(tenantId, { approvalId: approval.approvalId, status: 'rejected' });
  }

  if (disposition === 'assistant-action') {
    const handler = getAssistantActionApprovalHandler();
    if (!handler) throw new OpenwopError('conflict', 'Assistant feature is not composed on this host.', 409, {});
    const decided = await handler(tenantId, approval.approvalId, 'rejected', {
      ...(decidedBy ? { decidedByUserId: decidedBy } : {}),
      ...(note !== undefined ? { note } : {}),
    });
    if (!decided) throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId: approval.approvalId });
    if (!decided.changed) throw new OpenwopError('conflict', `Approval already ${decided.approval.status}.`, 409, { status: decided.approval.status });
    auditDecision(deps, ctx, 'assistant.action.rejected', `assistant-action:${approval.actionId}`, { approvalId: approval.approvalId, tenantId });
    return announceReview(tenantId, { approvalId: approval.approvalId, status: 'rejected', actionId: approval.actionId });
  }

  // Park the card terminally (best-effort) so it leaves the To Do pick path.
  if (approval.boardId && approval.cardId) {
    const board = await getBoard(approval.boardId);
    const terminal = board?.columns[board.columns.length - 1];
    if (terminal) await moveCard(approval.cardId, terminal.id);
    notifyBoardChanged(approval.boardId);
  }

  const resolved = await resolveApproval(approval.approvalId, { status: 'rejected', ...(decidedBy ? { decidedBy } : {}), ...(note !== undefined ? { note } : {}) });
  if (!resolved?.changed) {
    throw new OpenwopError('conflict', 'Approval already resolved.', 409, { approvalId: approval.approvalId });
  }
  return announceReview(tenantId, { approvalId: approval.approvalId, status: 'rejected', approval: resolved.approval });
}
