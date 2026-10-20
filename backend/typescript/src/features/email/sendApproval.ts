/**
 * ADR 0905 D3 — the `email-campaign-send` approval: submit, withdraw, and decide.
 *
 * Composes the ONE approval queue (`host/approvalService`, ADR 0025 §4) the way CMS
 * does (`features/cms/contentApproval.ts`, the reference consumer): the content is
 * versioned on the subject (the template version, P1), the version is pinned on the
 * row, there is one open row per campaign (a resubmit repins it), the row id is
 * deterministic and created by CAS, and the decide handler runs in CMS order:
 *
 *   IDOR → authority → subject re-read (`review_closed`) → pin check (`stale_review`)
 *   → separation of duties → CAS resolve → campaign transition (compensated).
 *
 * The send itself is gated in `emailService.sendCampaign` (the service every caller
 * goes through), from the campaign's mirrored `review` — this module only moves the
 * campaign between `draft`, `in_review` and `approved`.
 *
 * Who may approve: the org's admins (`host:members:manage`, the CMS bar), or a member
 * of the org's configured approver roles/groups (ADR 0075 refs, stamped on the row).
 * No new scope: a mintable `host:email:approve` would break the protocol-scope-only
 * custom-role invariant (ADR 0905 E1).
 */

import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import {
  createEmailSendApprovalOnce, getApproval, registerEmailSendApprovalHandler, reopenApproval, repinEmailSendApproval,
  resolveApproval, type PendingApproval,
} from '../../host/approvalService.js';
import { getOrg, hasDistinctScopeHolder, resolveEffectiveAccess } from '../../host/accessControlService.js';
import { isEligibleApprover, resolveEligibleApprovers } from '../../host/approverResolution.js';
import { selfApprovalBlockedCore } from '../../host/approvalSelfCheck.js';
import { approvalRecipients } from '../../host/approvalAudience.js';
import { canonicalDecider } from '../../host/delegatedSubject.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { createLogger } from '../../observability/logger.js';
import { listContacts } from '../crm/contactsService.js';
import { getSegment, resolveSegmentMembers } from '../crm/segmentsService.js';
import {
  emailApprovalGateOn, getCampaign, getEmailSettings, getTemplate, getTemplateVersion, liveApprovalPin, returnToDraft,
  samePin, updateCampaignRow, type Campaign, type CampaignApprovalPin,
} from './emailService.js';

const log = createLogger('email.sendApproval');
const ADMIN_SCOPE = 'host:members:manage';

/** The row's id for this campaign's review cycle. JSON, not a `:` join (ids contain
 *  `:`); `createdAt` because a deleted campaign re-created at one id restarts its cycle. */
export function sendReviewApprovalId(tenantId: string, campaign: Pick<Campaign, 'campaignId' | 'createdAt'>, cycle: number): string {
  const h = createHash('sha256').update(JSON.stringify([tenantId, campaign.campaignId, campaign.createdAt, cycle])).digest('hex');
  return `appr:email:${h.slice(0, 40)}`;
}

async function estimateRecipients(tenantId: string, campaign: Campaign): Promise<number | undefined> {
  try {
    if (campaign.audience.segmentId) return (await resolveSegmentMembers(tenantId, campaign.audience.segmentId)).length;
    return (await listContacts(tenantId)).filter((c) => !campaign.audience.stage || c.stage === campaign.audience.stage).length;
  } catch { return undefined; } // an estimate is decoration; never block a submit on it
}

async function audienceLabel(tenantId: string, campaign: Campaign): Promise<string> {
  if (campaign.audience.segmentId) return `segment: ${(await getSegment(tenantId, campaign.audience.segmentId))?.name ?? campaign.audience.segmentId}`;
  return campaign.audience.stage ? `stage: ${campaign.audience.stage}` : 'all contacts';
}

/**
 * Submit a campaign for send review (ADR 0905 D3). Allowed from `draft` (including
 * "changes requested") and from `sent` (a review for a RESEND); a campaign already
 * `in_review` is RE-PINNED to its current content (one open row per campaign).
 */
export async function submitForReview(
  tenantId: string, orgId: string, campaignId: string, submittedBy: string | undefined,
): Promise<{ campaign: Campaign; approval: PendingApproval }> {
  const campaign = await getCampaign(tenantId, orgId, campaignId);
  if (!campaign) throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId });
  if (campaign.status === 'approved' || campaign.status === 'sending') {
    throw new OpenwopError('conflict', `This campaign is ${campaign.status}; it cannot be submitted for review now.`, 409, { reason: 'not_submittable', status: campaign.status, campaignId });
  }
  const pin = await liveApprovalPin(tenantId, orgId, campaign);
  if (!pin) throw new OpenwopError('validation_error', 'Campaign template not found.', 400, { templateId: campaign.templateId });
  if (!pin.senderAddress) {
    throw new OpenwopError('validation_error', 'Set the sender address before submitting a campaign for review — the approval covers who it is sent from.', 400, { field: 'senderAddress' });
  }
  const version = await getTemplateVersion(tenantId, orgId, campaign.templateId, pin.templateVersion);
  const tpl = await getTemplate(tenantId, orgId, campaign.templateId);
  if (!version || !tpl) throw new OpenwopError('validation_error', 'Campaign template not found.', 400, { templateId: campaign.templateId });
  const settings = await getEmailSettings(tenantId, orgId);
  const emailSend: NonNullable<PendingApproval['emailSend']> = {
    campaignId, templateId: tpl.templateId, templateVersion: pin.templateVersion, contentHash: pin.contentHash,
    senderAddress: pin.senderAddress, audienceHash: pin.audienceHash, audienceLabel: await audienceLabel(tenantId, campaign),
    templateName: tpl.name, subject: version.subject, body: version.body, ...(version.format ? { format: version.format } : {}),
  };
  const estimated = await estimateRecipients(tenantId, campaign);
  if (estimated !== undefined) emailSend.estimatedRecipients = estimated;
  const proposal = `Send email campaign "${tpl.name}" (${emailSend.audienceLabel}) from ${pin.senderAddress}`;
  const refs = {
    ...(settings?.approverRoleRefs ? { approverRoleRefs: settings.approverRoleRefs } : {}),
    ...(settings?.approverGroupRefs ? { approverGroupRefs: settings.approverGroupRefs } : {}),
  };
  const submitters = submittedBy ? [submittedBy] : [];

  // A resubmit while in review repins the open row and the mirrored pin.
  if (campaign.status === 'in_review' && campaign.review) {
    const repinned = await repinEmailSendApproval(campaign.review.approvalId, { emailSend, proposal, submitters, ...refs });
    if (repinned) {
      const moved = await updateCampaignRow(tenantId, orgId, campaignId, (cur) =>
        cur.status === 'in_review' && cur.review?.approvalId === repinned.approvalId
          ? { ...cur, review: { ...cur.review, pin, submittedAt: new Date().toISOString(), ...(submittedBy ? { submittedBy } : {}) } }
          : null);
      if (moved) return { campaign: moved.after, approval: repinned };
    }
    // The row was decided or vanished under us — fall through to a fresh cycle from draft.
    await returnToDraft(tenantId, orgId, campaignId, campaign.review.approvalId, 'Closed automatically — superseded by a new submission.');
  }

  const base = (await getCampaign(tenantId, orgId, campaignId)) ?? campaign;
  const fromStatus: 'draft' | 'sent' = base.status === 'sent' ? 'sent' : 'draft';
  const cycle = (base.review?.cycle ?? 0) + 1;
  const approvalId = sendReviewApprovalId(tenantId, base, cycle);
  // Row FIRST (CAS on the deterministic id), campaign second: a campaign can then never
  // be `in_review` without its row. If the campaign moved meanwhile, the row is closed.
  let created = await createEmailSendApprovalOnce({ tenantId, orgId, approvalId, emailSend, proposal, submitters, ...refs });
  if (!created.created) {
    const row = created.approval;
    const ours = row.kind === 'email-campaign-send' && row.tenantId === tenantId && row.emailSend?.campaignId === campaignId && row.status === 'pending';
    if (ours) {
      await repinEmailSendApproval(row.approvalId, { emailSend, proposal, submitters, ...refs });
    } else {
      log.warn('email_review_id_taken', { tenantId, campaignId, approvalId, heldBy: row.kind, status: row.status });
      created = await createEmailSendApprovalOnce({ tenantId, orgId, approvalId: `appr:email:${createHash('sha256').update(`${approvalId}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 40)}`, emailSend, proposal, submitters, ...refs });
    }
  }
  const approval = created.approval;
  const moved = await updateCampaignRow(tenantId, orgId, campaignId, (cur) =>
    (cur.status === 'draft' || cur.status === 'sent') && (cur.review?.cycle ?? 0) === cycle - 1
      ? { ...cur, status: 'in_review', review: { cycle, approvalId: approval.approvalId, pin, fromStatus, submittedAt: new Date().toISOString(), ...(submittedBy ? { submittedBy } : {}) } }
      : null);
  if (!moved || moved.after.status !== 'in_review' || moved.after.review?.approvalId !== approval.approvalId) {
    await resolveApproval(approval.approvalId, { status: 'rejected', note: 'Closed automatically — the campaign changed while it was being submitted.', chainOutcome: 'superseded' });
    throw new OpenwopError('conflict', 'The campaign changed while it was being submitted. Reload it and submit again.', 409, { reason: 'concurrent_change', campaignId });
  }
  await notifyReviewRequested(approval, submittedBy);
  return { campaign: moved.after, approval };
}

/** Withdraw an open review: the campaign returns to `draft`, the row is closed. */
export async function withdrawReview(tenantId: string, orgId: string, campaignId: string): Promise<Campaign> {
  const campaign = await getCampaign(tenantId, orgId, campaignId);
  if (!campaign) throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId });
  if ((campaign.status !== 'in_review' && campaign.status !== 'approved') || !campaign.review) {
    throw new OpenwopError('conflict', 'This campaign has no open review to withdraw.', 409, { reason: 'not_in_review', status: campaign.status, campaignId });
  }
  await returnToDraft(tenantId, orgId, campaignId, campaign.review.approvalId, 'Withdrawn by the submitter.');
  return (await getCampaign(tenantId, orgId, campaignId)) ?? campaign;
}

const refsOf = (a: PendingApproval): { approverGroupRefs?: string[]; approverRoleRefs?: string[] } => ({
  ...(a.policy?.approverGroupRefs ? { approverGroupRefs: a.policy.approverGroupRefs } : {}),
  ...(a.policy?.approverRoleRefs ? { approverRoleRefs: a.policy.approverRoleRefs } : {}),
});

/** May `subject` decide this row? An org admin, or a member the row's refs name. */
async function mayDecide(tenantId: string, orgId: string, subject: string, approval: PendingApproval): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  if ((access.scopes as readonly string[]).includes(ADMIN_SCOPE)) return true;
  return (await isEligibleApprover(subject, refsOf(approval), { tenantId, orgId })).eligible;
}

/** ADR 0905 D3 — separation of duties, while the gate is in force (with it OFF the
 *  submitter may simply send, so refusing would only push them to the bypass). */
export async function emailSelfApprovalBlocked(tenantId: string, orgId: string, decidedBy: string, approval: PendingApproval): Promise<boolean> {
  if (approval.kind !== 'email-campaign-send' || approval.status !== 'pending') return false;
  if (!(await emailApprovalGateOn(tenantId))) return false;
  return selfApprovalBlockedCore({
    tenantId, approvalId: approval.approvalId, decidedBy, logTag: 'email_review', submitters: approval.submitters ?? [],
    otherApproverExists: async (decider, exclude) => {
      if (await hasDistinctScopeHolder(tenantId, ADMIN_SCOPE, decider, { orgId, alsoExclude: exclude })) return true;
      const named = await resolveEligibleApprovers(refsOf(approval), { tenantId, orgId }, { includeDelegates: false });
      if (named.openGate) return false;
      const excluded = new Set([decider, ...exclude]);
      for (const s of named.subjects) {
        const canon = await canonicalDecider(tenantId, s);
        if (!excluded.has(s) && (canon === null || !excluded.has(canon))) return true;
      }
      return false;
    },
  });
}

async function decideEmailSend(
  tenantId: string, approvalId: string, outcome: 'approved' | 'rejected', opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'email-campaign-send' || !approval.emailSend) return null;
  const orgId = approval.orgId ?? '';
  const campaignId = approval.emailSend.campaignId;
  const decidedBy = opts.decidedByUserId;
  if (!decidedBy) throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide an approval.', 403, {});

  // IDOR first: a cross-org/tenant row is a uniform not-found, never "exists but no".
  const org = await getOrg(orgId);
  if (!org || org.tenantId !== tenantId) return null;
  if (!(await mayDecide(tenantId, orgId, decidedBy, approval))) {
    throw new OpenwopError('forbidden_scope', 'Only an organization admin or a configured email approver can decide a campaign send.', 403, { requiredScope: ADMIN_SCOPE });
  }
  if (approval.status !== 'pending') return { approval, changed: false };

  // Subject re-read — the terminal backstop (CMS ADR 0593 D2): a review whose campaign
  // is gone, or no longer under THIS review, is closed with one chain entry and said so.
  const campaign = await getCampaign(tenantId, orgId, campaignId);
  if (!campaign || campaign.status !== 'in_review' || campaign.review?.approvalId !== approvalId) {
    const why = !campaign ? 'the campaign was deleted' : `the campaign is \`${campaign.status}\` and is no longer under this review`;
    await resolveApproval(approvalId, { status: 'rejected', note: `Closed automatically — ${why}.`, chainOutcome: 'superseded' });
    throw new OpenwopError('conflict', `This review was closed automatically: ${why}.`, 409, { reason: 'review_closed', campaignId });
  }

  if (outcome === 'approved') {
    // Approve what you see: the template version, sender and audience definition on the
    // row must still be what the campaign would send. Checked BEFORE the CAS, so a stale
    // review consumes nothing; the submitter resubmits. A REJECT is never blocked.
    const live = await liveApprovalPin(tenantId, orgId, campaign);
    const rowPin: CampaignApprovalPin = {
      templateId: approval.emailSend.templateId, templateVersion: approval.emailSend.templateVersion, contentHash: approval.emailSend.contentHash,
      senderAddress: approval.emailSend.senderAddress, audienceHash: approval.emailSend.audienceHash,
    };
    if (!samePin(live, rowPin) || !samePin(campaign.review.pin, rowPin)) {
      throw new OpenwopError('conflict', 'This campaign changed after it was submitted for review. Ask the submitter to submit it again.', 409, {
        reason: 'stale_review', approvedVersion: rowPin.templateVersion, currentVersion: live?.templateVersion,
      });
    }
    if (await emailSelfApprovalBlocked(tenantId, orgId, decidedBy, approval)) {
      log.info('email_review_self_approval_refused', { tenantId, approvalId });
      throw new OpenwopError('forbidden', 'You submitted this campaign for review, so someone else has to approve it.', 403, { reason: 'separation-of-duties' });
    }
  }

  const lock = await resolveApproval(approvalId, { status: outcome, decidedBy, ...(opts.note !== undefined ? { note: opts.note } : {}) });
  if (!lock) return null;
  if (!lock.changed) return { approval: lock.approval, changed: false };

  const now = new Date().toISOString();
  const moved = await updateCampaignRow(tenantId, orgId, campaignId, (cur) =>
    cur.status === 'in_review' && cur.review?.approvalId === approvalId
      ? {
          ...cur,
          status: outcome === 'approved' ? 'approved' : 'draft',
          review: { ...cur.review, outcome: outcome === 'approved' ? 'approved' : 'changes_requested', decidedBy, decidedAt: now, ...(opts.note ? { note: opts.note } : {}) },
        }
      : null).catch((e: unknown) => { void reopenApproval(approvalId); throw e; });
  if (!moved || moved.after.review?.approvalId !== approvalId || moved.after.status === 'in_review') {
    // The campaign left this review between the re-read and the write: undo the resolve
    // so the row never claims a decision the campaign did not take.
    await reopenApproval(approvalId);
    throw new OpenwopError('conflict', 'The campaign changed while this decision was being recorded. Reload and decide again.', 409, { reason: 'review_closed', campaignId });
  }
  return { approval: lock.approval, changed: true };
}

/** Tell the row's audience a review is waiting (addressed only — ADR 0672 D1). */
async function notifyReviewRequested(approval: PendingApproval, submittedBy: string | undefined): Promise<void> {
  try {
    const { addressed, refs } = await approvalRecipients(approval.tenantId, approval);
    if (!addressed) return;
    const submitter = submittedBy ? await canonicalDecider(approval.tenantId, submittedBy) : null;
    for (const ref of refs) {
      if (submitter !== null && ref === submitter) continue;
      await getNotificationEmitter().emit({
        tenantId: approval.tenantId,
        recipientUserId: ref,
        type: 'approval.email-send-review-requested',
        priority: 'normal',
        title: `Review requested: ${approval.emailSend?.templateName ?? 'an email campaign'}`,
        message: 'An email campaign was submitted for review and is waiting for an approver.',
        actionUrl: '/approvals',
        metadata: { approvalId: approval.approvalId, kind: 'email-campaign-send', campaignId: approval.emailSend?.campaignId ?? '' },
      });
    }
  } catch (err) {
    log.warn('email_review_requested_notify_failed', { tenantId: approval.tenantId, approvalId: approval.approvalId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Register the decide handler on the core approvals hook (email feature boot). */
export function registerEmailSendApprovalGate(): void {
  registerEmailSendApprovalHandler(decideEmailSend);
}
