/**
 * ADR 0948 P1b — the `funnel-publish` approval: request, decide, and the ONE publish
 * function a node-started publish may reach.
 *
 * No node and no `ctx.funnels` method publishes. `requestFunnelPublish` queues a review
 * pinned to the funnel's content digest and returns; a human's APPROVE publishes, in the
 * email-send order (ADR 0905 D3, `features/email/sendApproval.ts`):
 *
 *   IDOR → authority → subject re-read (`review_closed`) → pin check (`stale_review`)
 *   → separation of duties → CAS resolve → publish (reopened on failure).
 *
 * `publishFunnelAsApproved` is the one publish path for this lane.
 *
 * ADR 0942 (integrated 2026-10-26): a request from a CAMPAIGN-BOUND run asks the
 * autonomy chokepoint (`enforceCampaignAction`, class `content.publish`, ceiling
 * `approve`, so a funnel never publishes without a person). `blocked` refuses the
 * request; `approve` stamps the policy's named approvers and the source run on the
 * row, and the shared eligibility check (`registerAutonomyPolicyRowEligibility`)
 * admits only an eligible non-requester, IN ADDITION to this handler's own
 * `workspace:write` floor; the core quorum counts their votes. An unbound request
 * (no campaign, autonomy off, a human) keeps the writers-only review.
 * Both refuse `step_pages_unpublished`: a funnel publish never publishes its pages; the
 * CMS `content-publish` review owns that (the owning kind wins, ADR 0942 D5).
 *
 * Who may decide: the org's writers (`workspace:write`), the bar the human publish route
 * sets. A requester who is also a writer cannot approve their own request while another
 * writer exists (the shared `selfApprovalBlockedCore`).
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import {
  createFunnelPublishApprovalOnce, getApproval, listApprovals, registerFunnelPublishApprovalHandler, reopenApproval, resolveApproval,
  type PendingApproval,
} from '../../host/approvalService.js';
import { getOrg, hasDistinctScopeHolder, resolveEffectiveAccess } from '../../host/accessControlService.js';
import { selfApprovalBlockedCore } from '../../host/approvalSelfCheck.js';
import { canonicalDecider } from '../../host/delegatedSubject.js';
import { canonicalReviewerUserId } from '../../host/approverResolution.js';
import { createLogger } from '../../observability/logger.js';
import type { Storage } from '../../storage/storage.js';
import { compileApproverSpec, enforceCampaignAction, registerAutonomyPolicyRowEligibility } from '../../host/autonomyPolicy/index.js';
import type { ApprovalPolicy } from '../../host/approvalService.js';
import { assertFunnelPublishable, funnelPublishDigest, getFunnel, publishFunnel, unpublishedStepPages, type Funnel } from './funnelsService.js';

const log = createLogger('funnels.publishApproval');
const DECIDE_SCOPE = 'workspace:write';

/** The row id for one funnel at one content digest, in review `cycle` n. Re-requesting
 *  the same content converges on the open row; once that row is DECIDED (rejected, or
 *  approved and later unpublished), the next request takes the next cycle — so the
 *  same content can be reviewed again, deterministically (a branch fork converges). */
export function funnelPublishApprovalId(tenantId: string, f: Pick<Funnel, 'funnelId' | 'createdAt'>, digest: string, cycle = 0, gate = ''): string {
  // `gate` joins the identity only when set, so every pre-integration id is unchanged.
  const h = createHash('sha256').update(JSON.stringify(gate ? [tenantId, f.funnelId, f.createdAt, digest, cycle, gate] : [tenantId, f.funnelId, f.createdAt, digest, cycle])).digest('hex');
  return `appr:funnel:${h.slice(0, 40)}`;
}
const MAX_CYCLES = 50;

/**
 * The ONE publish function of the funnel-publish lane. Publishes exactly the pinned
 * content (CAS from the checked row) and only when every step page is already
 * published. `expectedDigest` may be omitted by a caller that checked nothing else
 * first (ADR 0942's `auto` outcome); the pages rule still applies.
 */
export async function publishFunnelAsApproved(tenantId: string, orgId: string, funnelId: string, expectedDigest?: string): Promise<Funnel | null> {
  return publishFunnel(tenantId, orgId, funnelId, { requirePublishedPages: true, ...(expectedDigest !== undefined ? { expectedDigest } : {}) });
}

export interface RequestFunnelPublishResult {
  status: 'pending_approval';
  approvalId: string;
  /** False when an identical request was already OPEN (that pending row is returned). */
  created: boolean;
}

/** Close this funnel's OTHER open reviews: a new request supersedes them (an older
 *  pinned content can only ever be refused `stale_review`). */
async function supersedeOlderRequests(tenantId: string, funnelId: string, digest: string, gate: string): Promise<void> {
  for (const a of await listApprovals(tenantId, 'pending')) {
    if (a.kind !== 'funnel-publish' || a.funnelPublish?.funnelId !== funnelId) continue;
    // Same content: keep it, unless THIS request carries an autonomy gate the open
    // row lacks (a writers-only review must not stand in for named approvers).
    if (a.funnelPublish.digest === digest && (!gate || (a.funnelPublish.gate ?? '') === gate)) continue;
    await resolveApproval(a.approvalId, { status: 'rejected', note: 'Superseded — the funnel changed and was submitted again.', chainOutcome: 'superseded' });
  }
}

/**
 * Queue a review for publishing a DRAFT funnel. Never changes the funnel. Refuses up
 * front what a decision could not fix: a non-draft funnel, no steps, unpublished step
 * pages. Supersedes this funnel's older open requests. Always returns an OPEN row.
 */
export async function requestFunnelPublish(
  tenantId: string, orgId: string, funnelId: string,
  opts: { requestedBy?: string; causedBy?: string; runId?: string } = {},
): Promise<RequestFunnelPublishResult | null> {
  const f = await getFunnel(tenantId, orgId, funnelId);
  if (!f) return null;
  if (f.status !== 'draft') {
    throw new OpenwopError('conflict', `Only a draft funnel can be submitted for publishing; this one is ${f.status}.`, 409, { reason: 'funnel_not_draft', status: f.status });
  }
  if (f.steps.length === 0) throw new OpenwopError('validation_error', 'A funnel needs at least one step to publish.', 400, { field: 'steps' });
  const missing = await unpublishedStepPages(tenantId, orgId, f);
  if (missing.length > 0) {
    throw new OpenwopError('conflict', 'Publish the funnel\'s step pages first; publishing a funnel never publishes its pages.', 409, { reason: 'step_pages_unpublished', pageIds: missing });
  }
  // A delegated key can be revoked before review. Freeze its human now so
  // the shared separation-of-duties check can still identify the requester.
  const freezeRequester = async (subject: string): Promise<string> => {
    const issuer = await canonicalDecider(tenantId, subject);
    if (!issuer) throw new OpenwopError('forbidden_scope', 'The publish requester could not be resolved.', 403, { reason: 'review_requester_unresolved' });
    return canonicalReviewerUserId(tenantId, issuer);
  };
  const requestedBy = opts.requestedBy ? await freezeRequester(opts.requestedBy) : undefined;
  const causedBy = !requestedBy && opts.causedBy ? await freezeRequester(opts.causedBy) : undefined;
  const digest = funnelPublishDigest(f);
  const autonomy = await autonomyGateFor(tenantId, orgId, digest, opts.runId);
  const gate = autonomy?.gate ?? '';
  if (!gate) {
    // An open gated review of this exact content is STRONGER than the one this
    // request would open: return it rather than adding a writers-only path.
    for (const a of await listApprovals(tenantId, 'pending')) {
      if (a.kind === 'funnel-publish' && a.orgId === orgId && a.funnelPublish?.funnelId === funnelId && a.funnelPublish.digest === digest && a.funnelPublish.gate) {
        return { status: 'pending_approval', approvalId: a.approvalId, created: false };
      }
    }
  }
  await supersedeOlderRequests(tenantId, funnelId, digest, gate);
  for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
    const approvalId = funnelPublishApprovalId(tenantId, f, digest, cycle, gate);
    const existing = await getApproval(approvalId);
    if (existing && (existing.kind !== 'funnel-publish' || existing.tenantId !== tenantId || existing.orgId !== orgId
      || existing.funnelPublish?.funnelId !== funnelId || existing.funnelPublish.digest !== digest || (existing.funnelPublish.gate ?? '') !== gate)) {
      throw new OpenwopError('conflict', 'The publish review could not be confirmed.', 409, { reason: 'review_unconfirmed' });
    }
    if (existing && existing.status !== 'pending') continue; // decided: next cycle
    if (existing) return { status: 'pending_approval', approvalId, created: false };
    const { approval, created } = await createFunnelPublishApprovalOnce({
      tenantId, orgId, approvalId,
      funnelPublish: { funnelId, funnelName: f.name, slug: f.slug, digest, stepCount: f.steps.length, ...(opts.runId ? { runId: opts.runId } : {}), ...(gate ? { gate } : {}) },
      proposal: `Publish the funnel "${f.name}" at /${f.slug} (${f.steps.length} step${f.steps.length === 1 ? '' : 's'}). Publishing makes it public and its offers chargeable.`,
      submitters: requestedBy ? [requestedBy] : [],
      ...(causedBy ? { submitterCauses: [causedBy] } : {}),
      ...(autonomy ? { policy: autonomy.policy, autonomySourceRunId: autonomy.runId } : {}),
    });
    if (approval.status === 'pending') return { status: 'pending_approval', approvalId, created };
    // A racing request created AND someone decided it in between: take the next cycle.
  }
  throw new OpenwopError('conflict', 'This funnel has been reviewed too many times at this content. Change it before requesting again.', 409, { reason: 'review_cycles_exhausted', funnelId });
}

let autonomyStorage: Pick<Storage, 'getRun'> | null = null;

/**
 * ADR 0942 — the campaign autonomy decision for a run-originated publish request.
 * `null` = unbound (no run, no campaign stamp, autonomy off): the writers-only
 * review. `blocked` refuses here, before any row exists. `ceiling: 'approve'`
 * means `auto` / `notify-after` can never come back: a funnel always needs a person.
 */
async function autonomyGateFor(
  tenantId: string, orgId: string, digest: string, runId: string | undefined,
): Promise<{ gate: string; policy: ApprovalPolicy; runId: string } | null> {
  if (!runId || !autonomyStorage) return null;
  const v = await enforceCampaignAction({ storage: autonomyStorage, tenantId, runId }, { actionClass: 'content.publish', facts: {}, ceiling: 'approve', contentHash: digest });
  if (v.kind === 'unbound' || v.kind === 'proceed') return null;
  if (v.kind === 'blocked') {
    throw new OpenwopError('forbidden', 'The campaign\'s autonomy policy does not allow publishing this funnel from a workflow.', 403, { reason: 'autonomy_blocked', rule: v.ruleId });
  }
  // The approvers resolve in the run's client org; a request for another org would
  // ask the wrong people (the enforce layer's approver_org_mismatch, here).
  if (v.orgId !== orgId) {
    throw new OpenwopError('forbidden', 'This run cannot request a publish in another organization.', 403, { reason: 'approver_org_mismatch' });
  }
  const { approvalPolicy } = compileApproverSpec(v.approver, { actionClass: 'content.publish', lane: 'approval' });
  return { gate: `${v.policyHash}:${v.ruleId}`, policy: approvalPolicy, runId: v.runId };
}

async function selfApprovalBlocked(tenantId: string, orgId: string, decidedBy: string, approval: PendingApproval): Promise<boolean> {
  return selfApprovalBlockedCore({
    tenantId, approvalId: approval.approvalId, decidedBy, logTag: 'funnel_publish',
    // ADR 0859 D4 — a member who caused an actorless run counts as a submitter here.
    submitters: [...(approval.submitters ?? []), ...(approval.submitterCauses ?? [])],
    otherApproverExists: (decider, exclude) => hasDistinctScopeHolder(tenantId, DECIDE_SCOPE, decider, { orgId, alsoExclude: exclude }),
  });
}

async function decideFunnelPublish(
  tenantId: string, approvalId: string, outcome: 'approved' | 'rejected', opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'funnel-publish' || !approval.funnelPublish) return null;
  const orgId = approval.orgId ?? '';
  const { funnelId, digest } = approval.funnelPublish;
  const decidedBy = opts.decidedByUserId;
  if (!decidedBy) throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide an approval.', 403, {});

  // IDOR first: a cross-org/tenant row is a uniform not-found.
  const org = await getOrg(orgId);
  if (!org || org.tenantId !== tenantId) return null;
  const access = await resolveEffectiveAccess(tenantId, { subject: decidedBy, orgId });
  if (!(access.scopes as readonly string[]).includes(DECIDE_SCOPE)) {
    throw new OpenwopError('forbidden_scope', 'Only a member who can edit this organization can decide a funnel publish.', 403, { requiredScope: DECIDE_SCOPE });
  }
  if (approval.status !== 'pending') return { approval, changed: false };

  // Subject re-read: a funnel that is gone or no longer a draft closes the review.
  const f = await getFunnel(tenantId, orgId, funnelId);
  if (!f || f.status !== 'draft') {
    const why = !f ? 'the funnel was deleted' : `the funnel is \`${f.status}\``;
    await resolveApproval(approvalId, { status: 'rejected', note: `Closed automatically — ${why}.`, chainOutcome: 'superseded' });
    throw new OpenwopError('conflict', `This review was closed automatically: ${why}.`, 409, { reason: 'review_closed', funnelId });
  }

  if (outcome === 'approved') {
    // Approve what you see, checked BEFORE the CAS so a stale review consumes nothing.
    if (funnelPublishDigest(f) !== digest) {
      throw new OpenwopError('conflict', 'This funnel changed after it was submitted for publishing. Request publishing again.', 409, { reason: 'stale_review', funnelId });
    }
    if (await selfApprovalBlocked(tenantId, orgId, decidedBy, approval)) {
      log.info('funnel_publish_self_approval_refused', { tenantId, approvalId });
      throw new OpenwopError('forbidden', 'You requested this publish, so someone else has to approve it.', 403, { reason: 'separation-of-duties' });
    }
    // Every refusal the publish can meet runs BEFORE the resolve, so it consumes
    // nothing; the publish below re-runs them under its CAS, and the reopen only
    // covers a real race between the two.
    await assertFunnelPublishable(tenantId, orgId, f, { requirePublishedPages: true });
  }

  const lock = await resolveApproval(approvalId, { status: outcome, decidedBy, ...(opts.note !== undefined ? { note: opts.note } : {}) });
  if (!lock) return null;
  if (!lock.changed || outcome === 'rejected') return { approval: lock.approval, changed: lock.changed };

  // The publish re-runs every check under a CAS; on ANY refusal the decision is undone,
  // so the row never claims a publish that did not happen.
  try {
    const published = await publishFunnelAsApproved(tenantId, orgId, funnelId, digest);
    if (!published) throw new OpenwopError('conflict', 'The funnel was deleted while this decision was being recorded.', 409, { reason: 'review_closed', funnelId });
  } catch (err) {
    await reopenApproval(approvalId);
    throw err;
  }
  return { approval: lock.approval, changed: true };
}

/** Register the decide handler on the core approvals hook (funnels feature boot). */
export function registerFunnelPublishApprovalGate(storage?: Pick<Storage, 'getRun'>): void {
  registerFunnelPublishApprovalHandler(decideFunnelPublish);
  if (storage) {
    autonomyStorage = storage;
    // Named approvers on a gated row are enforced by the ONE shared ADR 0942 check.
    registerAutonomyPolicyRowEligibility('funnel-publish', storage);
  }
}
