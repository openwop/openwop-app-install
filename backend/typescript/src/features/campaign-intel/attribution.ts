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
import { listAttributionEvents, type AnalyticsEvent } from '../analytics/analyticsService.js';
import { contactsBySession } from '../analytics/identityLinkService.js';
import { currencyExponent } from '../../host/currencyUnits.js';
import { buildTouchPaths, type PathCoverage, type TouchPath } from './touchPaths.js';
import { getAttributionSettings, type AttributionSettings } from './attributionSettings.js';
import { CONVERSION_UNITS, creditPath, ATTRIBUTION_MODELS, type AttributionModel } from './attributionModels.js';
import { listEngagement } from '../email/engagementService.js';
// Cross-feature READ (the documented precedent).
import { listCampaigns } from '../campaign-orchestration/campaignService.js';
import { campaignJoinKey, listAliases } from './utmGovernance.js';
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
  /** ADR 0956 D1 (A-1) — conversions whose PATH's last touch maps to this
   *  campaign: the session (or linked contact) landed with this campaign's UTMs
   *  and converted later, possibly on a page without them. Shown BESIDE the
   *  converting-hit `webConversions`, which is unchanged, so the difference is
   *  visible rather than a silent change of definition. */
  sessionLastClick: number;
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
    /** ADR 0956 D5 — of `conversionEvents`, those matched through a
     *  human-confirmed utm_campaign alias rather than the join key. */
    aliasedConversions: number;
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
  /** ADR 0956 D5 — unattributed triage: the most frequent unmatched
   *  utm_campaign values (null = the conversion carried none), most first,
   *  at most 20. An operator maps one to a campaign with an alias. */
  unattributedByCampaign: Array<{ utmCampaign: string | null; count: number }>;
  /** utm_campaign keys shared by more than one campaign (INTEL-1): a conversion
   *  on a shared key is attributed to ONE campaign (deterministic first-by-id),
   *  never double-counted; this names the keys so the operator can fix their
   *  UTM hygiene. */
  sharedJoinKeys: string[];
  /** ADR 0956 D1 — how the conversions' touch paths were built: contact paths
   *  (deterministic identity link) vs session-only paths, and conversions with
   *  no touch in the window. */
  pathCoverage: PathCoverage;
  /** The lookback window the paths used (the org's attribution settings). */
  lookbackDays: number;
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

type Campaigns = Awaited<ReturnType<typeof listCampaigns>>;

/** The ONE map from a utm_campaign value to the campaign that owns it: the
 *  first-by-id campaign on that join key (INTEL-1), else a human-confirmed
 *  alias to one of the org's campaigns (ADR 0956 D5), else none. */
function campaignResolver(campaigns: Campaigns, aliasTo: ReadonlyMap<string, string>): { byKey: Map<string, string[]>; resolve: (utmCampaign: string) => string | null } {
  const byKey = new Map<string, string[]>();
  for (const c of campaigns) {
    const k = campaignJoinKey(c);
    const arr = byKey.get(k) ?? [];
    arr.push(c.id);
    byKey.set(k, arr);
  }
  for (const arr of byKey.values()) arr.sort();
  const ids = new Set(campaigns.map((c) => c.id));
  const resolve = (utmCampaign: string): string | null => {
    const owner = byKey.get(utmCampaign)?.[0];
    if (owner) return owner;
    const aliased = aliasTo.get(utmCampaign);
    return aliased && ids.has(aliased) ? aliased : null;
  };
  return { byKey, resolve };
}

function pathsFor(events: readonly AnalyticsEvent[], linked: ReadonlyMap<string, string>, resolve: (utmCampaign: string) => string | null, settings: AttributionSettings): { paths: TouchPath[]; coverage: PathCoverage } {
  return buildTouchPaths({ events, contactBySession: linked, lookbackDays: settings.lookbackDays, resolveCampaign: resolve, currencyExponent });
}

export async function buildAttribution(tenantId: string, orgId: string): Promise<AttributionReport> {
  const [campaigns, records, attributionEvents, engagement, emailCampaigns, settingsRow, aliases] = await Promise.all([
    listCampaigns(tenantId, orgId),
    listRecords(tenantId, orgId),
    // UNCAPPED read (grade-code AUDIT-1): a recency-capped `listEvents` window
    // is consumed by high-volume pageviews, silently dropping older
    // conversions → attribution undercount at scale. ADR 0956 D1: the same
    // single scan also returns the touch events the paths are built from.
    listAttributionEvents(tenantId, orgId),
    listEngagement(tenantId),
    listEmailCampaigns(tenantId, orgId),
    getAttributionSettings(tenantId, orgId),
    listAliases(tenantId, orgId),
  ]);
  const conversions = attributionEvents.filter((e) => e.type === 'conversion');
  const aliasTo = new Map(aliases.map((a) => [a.utmCampaign, a.campaignId] as const));
  const { byKey, resolve } = campaignResolver(campaigns, aliasTo);
  // ADR 0226: a conversion's session resolves to a CRM contact through the
  // identity-link table — read ONCE per report (ADR 0956 D1), not per session.
  const linked = await contactsBySession(tenantId);
  const resolveSession = (sessionKey: string): string | null => linked.get(sessionKey) ?? null;
  const { paths, coverage } = pathsFor(attributionEvents, linked, resolve, settingsRow.settings);
  const sessionLastClickBy = new Map<string, number>();
  for (const p of paths) {
    const last = p.touches[p.touches.length - 1]?.campaignId;
    if (last) sessionLastClickBy.set(last, (sessionLastClickBy.get(last) ?? 0) + 1);
  }
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

  // INTEL-1: campaigns grouped by join key, each list ordered by id — the FIRST
  // is the sole owner of that key's web conversions, so a shared key never
  // double-counts. Shared keys are surfaced in the report.
  const keyOf = (c: (typeof campaigns)[number]): string => campaignJoinKey(c);
  const sharedJoinKeys = [...byKey.entries()].filter(([, ids]) => ids.length > 1).map(([k]) => k);

  for (const campaign of campaigns) {
    const joinKey = keyOf(campaign);
    const perf = records.filter((r) => (r.campaignId ? r.campaignId === campaign.id : r.campaignName === campaign.name));
    const spend = perf.reduce((s, r) => s + r.spend, 0);
    // Platform-REPORTED totals: a row whose platform cannot report the value
    // (ADR 0907 D3 `null`) contributes nothing rather than a fake 0.
    const revenue = perf.reduce((s, r) => s + (r.revenue ?? 0), 0);
    const platformConversions = perf.reduce((s, r) => s + (r.conversions ?? 0), 0);
    // Only the primary (first-by-id) campaign for this join key owns its web
    // conversions — a shared key attributes once, never per-campaign.
    const isPrimaryForKey = byKey.get(joinKey)?.[0] === campaign.id;
    const direct = isPrimaryForKey ? conversions.filter((e) => e.utm?.campaign === joinKey) : [];
    // ADR 0956 D5 — conversions whose utm_campaign a person aliased to THIS
    // campaign (an alias can never name a value that is already a join key).
    const aliased = conversions.filter((e) => e.utm?.campaign !== undefined && !byKey.has(e.utm.campaign) && aliasTo.get(e.utm.campaign) === campaign.id);
    const mine = [...direct, ...aliased];
    attributed += mine.length;
    let knownContactConversions = 0;
    for (const e of mine) {
      if (e.sessionKey && resolveSession(e.sessionKey) !== null) knownContactConversions += 1;
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
      sessionLastClick: sessionLastClickBy.get(campaign.id) ?? 0,
      knownContactConversions,
      attributedCpa: div(spend, mine.length),
      reportedRoas: div(revenue, spend),
      lineage: {
        spendRows: perf.length,
        latestSpendDate: perf.reduce<string | null>((m, r) => (m === null || r.date > m ? r.date : m), null),
        conversionEvents: mine.length,
        aliasedConversions: aliased.length,
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
  // ADR 0956 D5 — what did NOT match, grouped by its utm_campaign value.
  const campaignIds = new Set(campaigns.map((c) => c.id));
  const unmatched = new Map<string | null, number>();
  for (const e of conversions) {
    const key = e.utm?.campaign ?? null;
    if (key !== null && (byKey.has(key) || campaignIds.has(aliasTo.get(key) ?? ''))) continue;
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
  }
  const unattributedByCampaign = [...unmatched.entries()]
    .map(([utmCampaign, count]) => ({ utmCampaign, count }))
    .sort((a, b) => b.count - a.count || String(a.utmCampaign).localeCompare(String(b.utmCampaign)))
    .slice(0, 20);
  return {
    rows: rows.sort((a, b) => b.spend - a.spend),
    email: [...byEmailCampaign.values()],
    unattributedConversions: conversions.length - attributed,
    unattributedByCampaign,
    sharedJoinKeys,
    pathCoverage: coverage,
    lookbackDays: settingsRow.settings.lookbackDays,
    currency: currencies.size === 1 ? [...currencies][0] : 'USD',
    currencyMixed: currencies.size > 1,
    computedAt: new Date().toISOString(),
  };
}

/** ADR 0956 D2 — one campaign's credit under one model. `units` is exact
 *  (CONVERSION_UNITS per conversion); `conversions` is it divided for display. */
export interface ModelCreditRow {
  campaignId: string | null;
  name: string | null;
  units: number;
  conversions: number;
  /** Credited conversion value, per currency, in ISO minor units (no FX). */
  value: Array<{ currency: string; minor: number }>;
}

export interface AttributionModelReport {
  model: AttributionModel;
  /** The org's settings the paths and decay used, shown on every report. */
  settings: AttributionSettings;
  settingsVersion: number;
  /** Per campaign, most credit first. Touches whose utm_campaign maps to no
   *  campaign are credited to `unmapped`, never dropped, so the credits of
   *  every path still add up. */
  rows: ModelCreditRow[];
  unmapped: ModelCreditRow;
  /** Every model side by side, per campaign (conversions, display units). */
  comparison: Array<{ campaignId: string | null; name: string | null; byModel: Record<AttributionModel, number> }>;
  /** Conversions with at least one touch: their credit sums to exactly
   *  `creditedPaths × CONVERSION_UNITS` under every model. */
  creditedPaths: number;
  coverage: PathCoverage;
  /** Modelled web credit. Never add platform-reported conversions to it. */
  basis: 'modelled_web_conversions';
  computedAt: string;
}

const toConversions = (units: number): number => Number((units / CONVERSION_UNITS).toFixed(4));

function creditByCampaign(model: AttributionModel, paths: readonly TouchPath[], settings: AttributionSettings): Map<string | null, { units: number; value: Map<string, number> }> {
  const out = new Map<string | null, { units: number; value: Map<string, number> }>();
  const slot = (id: string | null): { units: number; value: Map<string, number> } => {
    let s = out.get(id);
    if (!s) { s = { units: 0, value: new Map() }; out.set(id, s); }
    return s;
  };
  for (const p of paths) {
    if (p.touches.length === 0) continue;
    const { units, value } = creditTouches(model, p, settings);
    p.touches.forEach((t, i) => {
      const s = slot(t.campaignId);
      s.units += units[i]!;
      if (p.value && value) s.value.set(p.value.currency, (s.value.get(p.value.currency) ?? 0) + value[i]!);
    });
  }
  return out;
}

/** ADR 0956 D2 — the org's conversions credited under `model` (default: the
 *  org's `defaultModel`), with every model's per-campaign figure beside it. */
/** ADR 0956 — everything a model-based read needs, loaded once: the org's
 *  campaigns, its settings, and the touch paths (read-time, D1). Shared by the
 *  model report, the reconciliation report and the AdMap so they cannot
 *  disagree on what a path is. */
export interface AttributionContext {
  campaigns: Campaigns;
  /** Org-scoped source events, including visits that never converted. */
  events: AnalyticsEvent[];
  settings: AttributionSettings;
  settingsVersion: number;
  paths: TouchPath[];
  coverage: PathCoverage;
}

export async function loadAttributionContext(tenantId: string, orgId: string): Promise<AttributionContext> {
  const [campaigns, events, settingsRow, aliases, linked] = await Promise.all([
    listCampaigns(tenantId, orgId),
    listAttributionEvents(tenantId, orgId),
    getAttributionSettings(tenantId, orgId),
    listAliases(tenantId, orgId),
    contactsBySession(tenantId),
  ]);
  const { resolve } = campaignResolver(campaigns, new Map(aliases.map((a) => [a.utmCampaign, a.campaignId] as const)));
  const { paths, coverage } = pathsFor(events, linked, resolve, settingsRow.settings);
  return { campaigns, events, settings: settingsRow.settings, settingsVersion: settingsRow.version, paths, coverage };
}

/** Per-touch credits of one path under `model` (units and, when the
 *  conversion carries a value, minor units). Exact per path (D2). */
export function creditTouches(model: AttributionModel, p: TouchPath, settings: AttributionSettings): { units: number[]; value: number[] | null } {
  const times = p.touches.map((t) => Date.parse(t.at));
  const at = Date.parse(p.conversionAt);
  return {
    units: creditPath(model, times, at, CONVERSION_UNITS, { halfLifeDays: settings.halfLifeDays }),
    value: p.value ? creditPath(model, times, at, p.value.minor, { halfLifeDays: settings.halfLifeDays }) : null,
  };
}

export async function buildModelReport(tenantId: string, orgId: string, requested?: AttributionModel): Promise<AttributionModelReport> {
  const { campaigns, settings, settingsVersion, paths, coverage } = await loadAttributionContext(tenantId, orgId);
  const model = requested ?? settings.defaultModel;
  const names = new Map(campaigns.map((c) => [c.id, c.name] as const));
  const row = (id: string | null, credit: { units: number; value: Map<string, number> } | undefined): ModelCreditRow => ({
    campaignId: id,
    name: id === null ? null : names.get(id) ?? null,
    units: credit?.units ?? 0,
    conversions: toConversions(credit?.units ?? 0),
    value: [...(credit?.value ?? new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, minor]) => ({ currency, minor })),
  });
  const all = new Map(ATTRIBUTION_MODELS.map((m) => [m, creditByCampaign(m, paths, settings)] as const));
  const selected = all.get(model)!;
  const ids = [...new Set([...campaigns.map((c) => c.id), ...[...all.values()].flatMap((m) => [...m.keys()])])].filter((id): id is string => id !== null);
  const rows = ids.map((id) => row(id, selected.get(id))).sort((a, b) => b.units - a.units || String(a.campaignId).localeCompare(String(b.campaignId)));
  const comparisonIds: Array<string | null> = [...rows.map((r) => r.campaignId), null];
  const comparison = comparisonIds.map((id) => ({
    campaignId: id,
    name: id === null ? null : names.get(id) ?? null,
    byModel: Object.fromEntries(ATTRIBUTION_MODELS.map((m) => [m, toConversions(all.get(m)!.get(id)?.units ?? 0)])) as Record<AttributionModel, number>,
  }));
  return {
    model,
    settings,
    settingsVersion,
    rows,
    unmapped: row(null, selected.get(null)),
    comparison,
    creditedPaths: paths.filter((p) => p.touches.length > 0).length,
    coverage,
    basis: 'modelled_web_conversions',
    computedAt: new Date().toISOString(),
  };
}
