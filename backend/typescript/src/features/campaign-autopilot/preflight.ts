/**
 * ADR 0961 D7 — the autopilot preflight: a typed, read-only checklist of what a
 * campaign still needs before the autopilot can run it. Never a silent skip:
 * every item names its status, and a blocking item stops the launch run at the
 * preflight stage instead of failing late.
 *
 * Each item reads its owner (the brief's validator and setup check, the
 * campaign's goal, the client's ad account). Items for owners that have not shipped yet (spend caps,
 * sending domains, consent topics, product images, eval status) are NOT
 * invented here; they join the closed id set when their owner lands.
 *
 * @see docs/adr/0961-brief-to-launch-autopilot.md
 */
import { getBrief, validateBrief } from '../campaign-brief/briefService.js';
import { setupOf } from '../campaign-orchestration/agentTools.js';
import type { MarketingCampaign } from '../campaign-orchestration/types.js';
import { adAccountsForOrg } from '../../host/adsAdapter.js';

/** The closed set of checklist item ids (P0; `ad-account` P1). */
export const PREFLIGHT_ITEM_IDS = ['brief', 'brief-complete', 'brief-setup', 'ad-account', 'goal'] as const;
export type PreflightItemId = (typeof PREFLIGHT_ITEM_IDS)[number];

export interface PreflightItem {
  id: PreflightItemId;
  status: 'ok' | 'missing' | 'warn';
  /** A blocking item that is not `ok` stops the launch run. */
  blocking: boolean;
  /** Machine codes naming what is missing (brief field names, setup slots). */
  missing?: string[];
}

export interface PreflightResult {
  campaignId: string;
  /** True when no blocking item is outstanding. */
  ready: boolean;
  items: PreflightItem[];
}

/** Run the checklist for one campaign. Pure read. */
export async function runPreflight(tenantId: string, campaign: MarketingCampaign): Promise<PreflightResult> {
  const items: PreflightItem[] = [];
  const brief = campaign.briefId ? await getBrief(tenantId, campaign.briefId) : null;
  // A brief of another client is no brief for this campaign.
  const own = brief && brief.orgId === campaign.orgId ? brief : null;
  items.push(own ? { id: 'brief', status: 'ok', blocking: true } : { id: 'brief', status: 'missing', blocking: true });
  if (own) {
    const v = validateBrief(own);
    items.push(v.valid
      ? { id: 'brief-complete', status: 'ok', blocking: true }
      : { id: 'brief-complete', status: 'missing', blocking: true, missing: v.issues.map((i) => i.field) });
    const setup = setupOf(own);
    items.push(setup.ready
      ? { id: 'brief-setup', status: 'ok', blocking: false }
      : { id: 'brief-setup', status: 'warn', blocking: false, missing: setup.missing.map((m) => m.slot) });
    // P1 — a campaign with paid ads needs the CLIENT's own ad account (ADR 0921
    // D4: never a workspace or personal fallback). Only asked when the brief
    // enables ads; a connection that needs reconsent is named, not counted.
    if (own.channels.some((c) => c.enabled && c.type === 'ad_variants')) {
      const ads = await adAccountsForOrg(tenantId, campaign.orgId);
      items.push(ads.active.length > 0
        ? { id: 'ad-account', status: 'ok', blocking: true }
        : { id: 'ad-account', status: 'missing', blocking: true, ...(ads.inactive.length ? { missing: ads.inactive.map((p) => `reconnect:${p}`) } : {}) });
    }
  }
  items.push(campaign.goal ? { id: 'goal', status: 'ok', blocking: false } : { id: 'goal', status: 'warn', blocking: false });
  return { campaignId: campaign.id, ready: items.every((i) => !i.blocking || i.status === 'ok'), items };
}
