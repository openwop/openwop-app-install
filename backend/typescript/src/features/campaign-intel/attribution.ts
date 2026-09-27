/**
 * Attribution floor (ADR 0219 / campaign gap plan §5C C5) — the last-click join
 * between the two stores that already exist, computed at READ time (a pure
 * projection — no new pipeline, no copied rows):
 *
 *   - **Paid side:** the performance store (spend/revenue per campaign — CSV
 *     imports + the C2 daily sync), grouped by linked `campaignId` when the
 *     row carries one, else by `campaignName`.
 *   - **Web side:** analytics `conversion` events, attributed **last-click**
 *     by `utm.campaign` — the deterministic key C8 stamps onto outbound ad
 *     URLs (`brief.utm.campaign`, falling back to the briefId).
 *   - **Owned side:** email engagement (ADR 0218) reported per EMAIL campaign
 *     beside the paid rows AND, since ADR 0245 stamped `sourceBriefId` on the
 *     channel-published email campaign, rolled up per MarketingCampaign via that
 *     provenance (ADR 0246). The per-email `email[]` column stays — the rollup is
 *     ADDITIVE and appears only for campaigns whose brief actually owns a
 *     published email campaign, so it is a real provenance join, never a
 *     synthesised unified row.
 *
 * Every number carries LINEAGE (which rows, which key, how fresh) — the
 * research doc's "trace a KPI back to its sources" criterion. Native platform
 * conversions and attributed web conversions are reported SIDE BY SIDE, never
 * summed (they overlap; summing would double-count).
 */

import { listRecords } from '../campaign-connectors/performanceService.js';
import { listConversions } from '../analytics/analyticsService.js';
import { contactForSession } from '../analytics/identityLinkService.js';
import { listEngagement } from '../email/engagementService.js';
// Cross-feature READ (the documented precedent).
import { listCampaigns } from '../campaign-orchestration/campaignService.js';
import { listCampaigns as listEmailCampaigns } from '../email/emailService.js';

const div = (a: number, b: number): number => (b > 0 ? Number((a / b).toFixed(4)) : 0);

export interface AttributionRow {
  campaignId: string;
  name: string;
  /** The utm_campaign value conversions were matched on. */
  joinKey: string;
  /** CMPUX-15: this campaign's budget currency (display label, no FX). */
  currency: string;
  spend: number;
  revenue: number;
  /** Platform-reported conversions (from the performance store). */
  platformConversions: number;
  /** Analytics conversions last-click-attributed via utm_campaign. */
  webConversions: number;
  /** ADR 0226 (D4): the subset of `webConversions` whose sessionKey resolves to
   *  a CRM contact through the deterministic identity-link table (form-submit /
   *  email-click writers). ADDITIVE beside `webConversions` — never a
   *  replacement. Lineage: same conversion events as `webConversions`, filtered
   *  by `analytics:identity-link` resolution at read time (a pure projection —
   *  no probabilistic matching, no merge; full CDP is a recorded non-goal). */
  knownContactConversions: number;
  /** spend / webConversions — the attributed acquisition cost. */
  attributedCpa: number;
  /** revenue / spend — platform-reported (revenue is store-side). */
  reportedRoas: number;
  lineage: {
    spendRows: number;
    latestSpendDate: string | null;
    conversionEvents: number;
    latestConversionAt: string | null;
  };
  /** ADR 0246: owned-channel (email) engagement rolled up to THIS marketing
   *  campaign through the `sourceBriefId` provenance ADR 0245 stamps on
   *  channel-published email campaigns. Present ONLY when this campaign's brief
   *  owns ≥1 such email campaign — a real provenance join, additive beside the
   *  honest per-email `email[]` column, never a synthesised row. */
  emailEngagement?: EmailRollup;
}

export interface EmailEngagementRow {
  emailCampaignId: string;
  /** ADR 0248: pixel opens (ADR 0242) — APPROXIMATE (images-off undercounts,
   *  proxy prefetch over-counts). Reported beside the reliable click signal. */
  opens: number;
  uniqueOpens: number;
  clicks: number;
  uniqueClicks: number;
  unsubscribes: number;
}

export interface EmailRollup {
  /** The brief this rollup joined on (the provenance key). */
  briefId: string;
  /** How many `sourceBriefId`-linked email campaigns fed this rollup. */
  emailCampaigns: number;
  /** ADR 0248: pixel opens (ADR 0242) — APPROXIMATE, see EmailEngagementRow. */
  opens: number;
  /** Distinct opening contacts across ALL linked email campaigns (deduped). */
  uniqueOpens: number;
  clicks: number;
  /** Distinct clicking contacts across ALL linked email campaigns (deduped —
   *  a contact who clicks two of the brief's campaigns counts once). */
  uniqueClicks: number;
  unsubscribes: number;
}

export interface AttributionReport {
  rows: AttributionRow[];
  /** Owned-channel engagement per EMAIL campaign (not joined to marketing
   *  campaigns — see the module header). */
  email: EmailEngagementRow[];
  /** Conversions whose utm_campaign matched no campaign — surfaced, not dropped. */
  unattributedConversions: number;
  /** utm_campaign keys shared by more than one campaign (INTEL-1): a conversion
   *  on a shared key is attributed to ONE campaign (deterministic first-by-id),
   *  never double-counted; this names the keys so the operator can fix their
   *  UTM hygiene. */
  sharedJoinKeys: string[];
  /** CMPUX-15: the report-level display currency — the campaigns' UNANIMOUS
   *  budget currency, else 'USD' (per-row `currency` is authoritative for each
   *  campaign; this is for header/summary chrome). No FX. */
  currency: string;
  /** CI-G1 — TRUE when the org's campaigns span more than one budget currency,
   *  so `currency` above is the neutral 'USD' DEFAULT rather than a fact about
   *  this org. Without this flag a mixed EUR/GBP org was indistinguishable from
   *  a genuinely-USD one, and the console labelled its org-wide figures `$` — a
   *  currency none of its campaigns use. Since there is no FX, those org-wide
   *  sums are not in any single currency, and the honest presentation is an
   *  unlabelled number plus a note. */
  currencyMixed: boolean;
  computedAt: string;
}

export async function buildAttribution(tenantId: string, orgId: string): Promise<AttributionReport> {
  const [campaigns, records, conversions, engagement, emailCampaigns] = await Promise.all([
    listCampaigns(tenantId, orgId),
    listRecords(tenantId, orgId),
    // UNCAPPED conversion read (grade-code AUDIT-1): a recency-capped
    // `listEvents` window is consumed by high-volume pageviews, silently
    // dropping older conversions → attribution undercount at scale.
    listConversions(tenantId, orgId),
    listEngagement(tenantId),
    listEmailCampaigns(tenantId, orgId),
  ]);
  const rows: AttributionRow[] = [];
  let attributed = 0;

  // ADR 0246: provenance join — email engagement rolled up to the brief that
  // owns each channel-published email campaign (`sourceBriefId`, ADR 0245).
  // Keyed by briefId; each marketing campaign reads its own brief's rollup.
  const emailToBrief = new Map<string, string>();
  for (const c of emailCampaigns) if (c.sourceBriefId) emailToBrief.set(c.campaignId, c.sourceBriefId);
  const emailByBrief = new Map<string, { campaignIds: Set<string>; opens: number; clicks: number; unsubscribes: number; openers: Set<string>; clickers: Set<string> }>();
  for (const e of engagement) {
    const brief = emailToBrief.get(e.campaignId);
    if (!brief) continue;
    const agg = emailByBrief.get(brief) ?? { campaignIds: new Set<string>(), opens: 0, clicks: 0, unsubscribes: 0, openers: new Set<string>(), clickers: new Set<string>() };
    agg.campaignIds.add(e.campaignId);
    if (e.kind === 'opened') {
      agg.opens += 1;
      if (e.contactId) agg.openers.add(e.contactId);
    }
    if (e.kind === 'clicked') {
      agg.clicks += 1;
      if (e.contactId) agg.clickers.add(e.contactId);
    }
    if (e.kind === 'unsubscribed') agg.unsubscribes += 1;
    emailByBrief.set(brief, agg);
  }

  // ADR 0226: resolve each conversion sessionKey through the identity-link
  // table at most once per report (memoized across campaign rows).
  const sessionContact = new Map<string, string | null>();
  const resolveSession = async (sessionKey: string): Promise<string | null> => {
    if (!sessionContact.has(sessionKey)) sessionContact.set(sessionKey, await contactForSession(tenantId, sessionKey));
    return sessionContact.get(sessionKey) ?? null;
  };

  // INTEL-1: campaigns grouped by join key, each list ordered by id — the FIRST
  // is the sole owner of that key's web conversions, so a shared key never
  // double-counts. Shared keys are surfaced in the report.
  const keyOf = (c: (typeof campaigns)[number]): string => c.utm?.campaign ?? c.briefId;
  const byKey = new Map<string, string[]>();
  for (const c of campaigns) {
    const arr = byKey.get(keyOf(c)) ?? [];
    arr.push(c.id);
    byKey.set(keyOf(c), arr);
  }
  for (const arr of byKey.values()) arr.sort();
  const sharedJoinKeys = [...byKey.entries()].filter(([, ids]) => ids.length > 1).map(([k]) => k);

  for (const campaign of campaigns) {
    const joinKey = keyOf(campaign);
    const perf = records.filter((r) => (r.campaignId ? r.campaignId === campaign.id : r.campaignName === campaign.name));
    const spend = perf.reduce((s, r) => s + r.spend, 0);
    const revenue = perf.reduce((s, r) => s + r.revenue, 0);
    const platformConversions = perf.reduce((s, r) => s + r.conversions, 0);
    // Only the primary (first-by-id) campaign for this join key owns its web
    // conversions — a shared key attributes once, never per-campaign.
    const isPrimaryForKey = byKey.get(joinKey)?.[0] === campaign.id;
    const mine = isPrimaryForKey ? conversions.filter((e) => e.utm?.campaign === joinKey) : [];
    attributed += mine.length;
    let knownContactConversions = 0;
    for (const e of mine) {
      if (e.sessionKey && (await resolveSession(e.sessionKey)) !== null) knownContactConversions += 1;
    }
    const emailAgg = emailByBrief.get(campaign.briefId);
    rows.push({
      campaignId: campaign.id,
      name: campaign.name,
      joinKey,
      // CMPUX-15: each row shows its own campaign's budget currency (no FX).
      currency: campaign.budget?.currency ?? 'USD',
      spend: Number(spend.toFixed(2)),
      revenue: Number(revenue.toFixed(2)),
      platformConversions,
      webConversions: mine.length,
      knownContactConversions,
      attributedCpa: div(spend, mine.length),
      reportedRoas: div(revenue, spend),
      lineage: {
        spendRows: perf.length,
        latestSpendDate: perf.reduce<string | null>((m, r) => (m === null || r.date > m ? r.date : m), null),
        conversionEvents: mine.length,
        latestConversionAt: mine.reduce<string | null>((m, e) => (m === null || e.ts > m ? e.ts : m), null),
      },
      ...(emailAgg
        ? {
            emailEngagement: {
              briefId: campaign.briefId,
              emailCampaigns: emailAgg.campaignIds.size,
              opens: emailAgg.opens,
              uniqueOpens: emailAgg.openers.size,
              clicks: emailAgg.clicks,
              uniqueClicks: emailAgg.clickers.size,
              unsubscribes: emailAgg.unsubscribes,
            },
          }
        : {}),
    });
  }

  // Owned-channel engagement grouped per email campaign.
  const byEmailCampaign = new Map<string, EmailEngagementRow>();
  for (const e of engagement) {
    const row = byEmailCampaign.get(e.campaignId) ?? { emailCampaignId: e.campaignId, opens: 0, uniqueOpens: 0, clicks: 0, uniqueClicks: 0, unsubscribes: 0 };
    if (e.kind === 'opened') row.opens += 1;
    if (e.kind === 'clicked') row.clicks += 1;
    if (e.kind === 'unsubscribed') row.unsubscribes += 1;
    byEmailCampaign.set(e.campaignId, row);
  }
  for (const row of byEmailCampaign.values()) {
    const openers = new Set(engagement.filter((e) => e.campaignId === row.emailCampaignId && e.kind === 'opened').map((e) => e.contactId));
    row.uniqueOpens = openers.size;
    const clickers = new Set(engagement.filter((e) => e.campaignId === row.emailCampaignId && e.kind === 'clicked').map((e) => e.contactId));
    row.uniqueClicks = clickers.size;
  }

  const currencies = new Set(campaigns.map((c) => c.budget?.currency).filter((v): v is string => !!v));
  return {
    rows: rows.sort((a, b) => b.spend - a.spend),
    email: [...byEmailCampaign.values()],
    unattributedConversions: conversions.length - attributed,
    sharedJoinKeys,
    currency: currencies.size === 1 ? [...currencies][0] : 'USD',
    currencyMixed: currencies.size > 1,
    computedAt: new Date().toISOString(),
  };
}
