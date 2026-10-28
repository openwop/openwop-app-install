/**
 * ADR 0942 P6 — the ONE access predicate for reading a campaign's review policy.
 * `GET …/campaigns/:id/autonomy` and the Strategist's `get-autonomy` tool both
 * call it, so the two can never disagree about who may read a policy (the
 * CLAUDE.md lane-1 rule: a feature agent tool shares its route's predicate).
 *
 * The caller is a discriminated union, not an optional subject.
 * `resolveEffectiveAccess` answers OWNER when no subject is given (the tenant's
 * own principal), so an optional `subject` would turn a tool call with no acting
 * user into full access (the KEY-19 shape, ADR 0797). A tool can only build
 * `{ subject }`; the route maps a request without a user to `{ tenantPrincipal }`
 * explicitly, which keeps its existing behaviour visible.
 *
 * Toggles stay with each caller: the route needs `requireFeatureEnabled` (the
 * SPA's 404 signal and the paywall), the tool needs a fail-empty boolean.
 */
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { describePolicy, type PolicyReadModel } from '../../host/autonomyPolicy/index.js';
import { getCampaign } from './campaignService.js';
import type { MarketingCampaign } from './types.js';

export type AutonomyReader = { subject: string } | { tenantPrincipal: true };

/** The campaign, if the reader may read it (`workspace:read` on its client org). Else null. */
export async function readableCampaign(tenantId: string, reader: AutonomyReader, campaignId: string): Promise<MarketingCampaign | null> {
  const campaign = campaignId ? await getCampaign(tenantId, campaignId) : null;
  if (!campaign) return null;
  const access = await resolveEffectiveAccess(tenantId, { ...('subject' in reader ? { subject: reader.subject } : {}), orgId: campaign.orgId });
  return access.scopes.includes('workspace:read') ? campaign : null;
}

/** The campaign's review-policy read model, or null when it is missing or not readable. */
export async function readableCampaignAutonomy(
  tenantId: string, reader: AutonomyReader, campaignId: string,
): Promise<{ campaign: MarketingCampaign; view: PolicyReadModel } | null> {
  const campaign = await readableCampaign(tenantId, reader, campaignId);
  if (!campaign) return null;
  return { campaign, view: await describePolicy(tenantId, campaign.orgId, campaign.id) };
}
