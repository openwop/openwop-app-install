/**
 * ADR 1022 (CP71CD-1) — does a platform campaign belong to this client org?
 *
 * The budget doors take `(platform, adAccountId, campaignId)` from the caller.
 * In an agency set-up one ad-platform token reaches every client's accounts, so
 * an org check on the caller alone let a writer in org A move org B's budget
 * through org A's connection. A campaign is org O's when:
 *
 * - the dispatch ledger holds it for O (`dispatchBelongsToOrg`, the one rule the
 *   sync and the caps use), on that ad account; or
 * - its ad account is one of O's configured account-scope sync accounts (a
 *   campaign this app did not launch, read by an account-scope sync). Those
 *   accounts are exclusive to one org (`saveConnectorSettings`, CP71CD-4).
 */

import { dispatchBelongsToOrg, listTenantDispatchRecords, type AdPlatform } from '../../host/adsAdapter.js';
import { listCampaigns } from '../campaign-orchestration/campaignService.js';
import { getConnectorSettings, isLiveSyncPlatform } from '../campaign-connectors/syncService.js';

const norm = (a: string): string => a.replace(/^act_/, '').replace(/[^0-9]/g, '');

export async function orgOwnsAdCampaign(tenantId: string, orgId: string, t: { platform: AdPlatform; adAccountId: string; campaignId: string }): Promise<boolean> {
  const briefIds = new Set((await listCampaigns(tenantId, orgId)).map((c) => c.briefId));
  const rows = (await listTenantDispatchRecords(tenantId)).filter((r) => r.platform === t.platform && r.platformCampaignId === t.campaignId);
  // A tombstoned row lost its account id: it cannot vouch for the account the
  // caller names (CP71CD-14), so it never matches.
  if (rows.some((r) => r.adAccountId !== undefined && norm(r.adAccountId) === norm(t.adAccountId) && dispatchBelongsToOrg(r, orgId, briefIds))) return true;
  // The ledger knows this campaign as SOMEONE ELSE'S: the settings branch below
  // must never override that (CP71CD-11). A launch is not refused by another
  // org's settings, so an account can end up holding both.
  if (rows.some((r) => r.orgId !== undefined ? r.orgId !== orgId : r.briefId !== undefined && !briefIds.has(r.briefId))) return false;
  if (!isLiveSyncPlatform(t.platform)) return false;
  const settings = await getConnectorSettings(tenantId, orgId, t.platform);
  return settings.syncScope === 'account' && settings.adAccountIds.some((a) => norm(a) === norm(t.adAccountId));
}
