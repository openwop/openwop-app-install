/**
 * ADR 0945 × ADR 0942 — "did a person approve publishing THIS asset at THIS
 * verdict?" The approvals-lane binding the creative publish gate
 * (`host/creativePublishGate.ts`, ADR 0945 D5) asks through
 * `registerCreativeReviewApproval`.
 *
 * - **One approval kind**, `creative-publish-review`, bound to a CONTENT HASH of
 *   `(tenant, org, asset, verdict)`. A verdict id is unique per verdict content,
 *   so a new verdict on the same asset is a new hash: an old approval stops
 *   applying by construction.
 * - **Approvers** are the client's ADR 0942 policy rule for `creative.review` at
 *   stage `compliance` when it says approve; a fidelity `needs_review` always needs
 *   a person, so anything else uses the default approver. The requester is a
 *   submitter and may not decide it (D10.2).
 * - **Disposition** `campaign-spend`: the claim IS the decision; nothing runs on
 *   approve. The publish gate re-checks at its own time.
 * - **The check is a point read.** A small binding row keyed by the hash lists the
 *   approval ids minted for it; the check re-verifies every field on each approval
 *   row (kind, hash, tenant, org, status), so the binding is an index, never an
 *   authority. Approvals are never scanned.
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { getApproval, insertCreativeReviewApproval } from '../../host/approvalService.js';
import { getCampaign } from './campaignService.js';
import { getVerdict } from '../../host/creativeFidelity/index.js';
import { getAssetByIdForTenant } from '../media/mediaService.js';
import { compileApproverSpec, DEFAULT_APPROVER, findRule, resolveEffectivePolicy, type ApproverSpec } from '../../host/autonomyPolicy/index.js';
import { canonicalDecider } from '../../host/delegatedSubject.js';
import { canonicalReviewerUserId } from '../../host/approverResolution.js';

export const CREATIVE_REVIEW_KIND = 'creative-publish-review';

interface ReviewBinding { key: string; tenantId: string; orgId: string; assetId: string; verdictId: string; approvalIds: string[] }
const bindings = new DurableCollection<ReviewBinding>('autonomy:creative-review', (b) => b.key, undefined, (b) => b.tenantId);

export const reviewHashOf = (tenantId: string, orgId: string, assetId: string, verdictId: string): string =>
  createHash('sha256').update([tenantId, orgId, assetId, verdictId].join('\u0000')).digest('hex');

const notFound = (): OpenwopError => new OpenwopError('not_found', 'Review not found.', 404, {});

/** The approvers for a fidelity review on this client: the policy's compliance-stage rule, if it asks; else the default. */
async function approverFor(tenantId: string, orgId: string, campaignId?: string): Promise<ApproverSpec> {
  const effective = await resolveEffectivePolicy(tenantId, orgId, campaignId);
  const rule = effective ? findRule(effective.policy, 'creative.review', 'compliance').rule : null;
  return rule?.default.outcome === 'approve' ? rule.default.approver : { ...DEFAULT_APPROVER };
}

/**
 * Ask for a review of one asset at one verdict. Every refusal a stranger could
 * probe (unknown or foreign asset, unknown verdict, a verdict that is not
 * `needs_review`) is the same not-found. Idempotent: an open request is returned;
 * an approved one answers 409; a rejected or expired one starts a new cycle.
 */
export async function requestCreativeReview(input: {
  tenantId: string; assetId: string; verdictId: string; requestedBy: string; campaignId?: string;
}): Promise<{ approvalId: string; status: 'pending' }> {
  const asset = await getAssetByIdForTenant(input.tenantId, input.assetId).catch(() => null);
  const orgId = asset?.orgId;
  if (!asset || !orgId) throw notFound();
  const verdict = await getVerdict(input.tenantId, orgId, input.verdictId).catch(() => null);
  if (!verdict || verdict.assetId !== input.assetId || verdict.outcome !== 'needs_review'
    || asset.lineage?.grounding?.fidelity?.verdictId !== input.verdictId || !asset.contentHash || verdict.assetSha256 !== asset.contentHash) throw notFound();
  if (input.campaignId) {
    const campaign = await getCampaign(input.tenantId, input.campaignId);
    if (!campaign || campaign.orgId !== orgId) throw notFound();
  }
  // Freeze the human while the delegation is live. Keeping only a revocable
  // key would later make its cause unresolvable, so the shared fail-closed
  // self-approval check would refuse EVERY reviewer after key revocation.
  const issuer = await canonicalDecider(input.tenantId, input.requestedBy);
  if (!issuer) throw new OpenwopError('forbidden_scope', 'The review requester could not be resolved.', 403, { reason: 'review_requester_unresolved' });
  const requester = await canonicalReviewerUserId(input.tenantId, issuer);
  const key = reviewHashOf(input.tenantId, orgId, input.assetId, input.verdictId);

  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await bindings.get(key);
    if (cur && (cur.tenantId !== input.tenantId || cur.orgId !== orgId || cur.assetId !== input.assetId || cur.verdictId !== input.verdictId)) throw notFound();
    const latest = cur?.approvalIds.at(-1);
    if (latest) {
      const row = await getApproval(latest);
      if (!row || row.kind !== CREATIVE_REVIEW_KIND || row.tenantId !== input.tenantId || row.orgId !== orgId
        || row.assetId !== input.assetId || row.verdictId !== input.verdictId || row.reviewHash !== key) {
        throw new OpenwopError('conflict', 'The prior review could not be confirmed. Ask an administrator to check it.', 409, { reason: 'review_unconfirmed' });
      }
      if (row.status === 'pending') return { approvalId: row.approvalId, status: 'pending' };
      if (row.status === 'approved') throw new OpenwopError('conflict', 'This asset is already approved for publishing at this check.', 409, { reason: 'already_approved' });
    }
    const cycle = cur?.approvalIds.length ?? 0;
    const approvalId = `appr:creview:${key.slice(0, 32)}:${cycle}`;
    const spec = await approverFor(input.tenantId, orgId, input.campaignId);
    const { approvalPolicy } = compileApproverSpec(spec, { actionClass: 'creative.review', lane: 'approval' });
    // Confirm the immutable primary first. Racing creators converge here on the
    // first submitter and policy; a lost ack retries this same deterministic id.
    const primary = await insertCreativeReviewApproval({
      approvalId, tenantId: input.tenantId, orgId, assetId: input.assetId, verdictId: input.verdictId, reviewHash: key,
      policy: approvalPolicy, submitters: [requester],
      proposal: `Publish "${asset.name || input.assetId}" although its brand-accuracy check asked for a person to review it.`,
    });
    const next: ReviewBinding = { key, tenantId: input.tenantId, orgId, assetId: input.assetId, verdictId: input.verdictId, approvalIds: [...(cur?.approvalIds ?? []), approvalId] };
    if (!(await bindings.compareAndSwap(cur, next))) continue;
    if (primary.status === 'pending') return { approvalId, status: 'pending' };
    // It may have been decided while the index was being repaired. Re-read it.
  }
  throw new OpenwopError('conflict', 'The review changed while you were requesting it. Try again.', 409, { reason: 'review_changed' });
}

/** The check the publish gate registers: an APPROVED row for exactly this hash. */
export async function isCreativeReviewApproved(input: { tenantId: string; orgId: string; assetId: string; verdictId: string }): Promise<boolean> {
  const key = reviewHashOf(input.tenantId, input.orgId, input.assetId, input.verdictId);
  const binding = await bindings.get(key);
  if (!binding || binding.tenantId !== input.tenantId || binding.orgId !== input.orgId) return false;
  if (binding.assetId !== input.assetId || binding.verdictId !== input.verdictId) return false;
  const latest = binding.approvalIds.at(-1);
  if (!latest) return false;
  const row = await getApproval(latest);
  return !!row && row.kind === CREATIVE_REVIEW_KIND && row.tenantId === input.tenantId && row.orgId === input.orgId
    && row.assetId === input.assetId && row.verdictId === input.verdictId && row.reviewHash === key && row.status === 'approved';
}
