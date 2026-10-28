/**
 * ADR 0956 D6 — ROAS reconciliation: what each ad platform CLAIMS beside what
 * the client's own site MEASURED, per campaign and platform, for one client org.
 *
 * - **Reported** is the platform's own figure from the performance store
 *   (ADR 0907): conversions, revenue, ROAS. A platform that cannot report a
 *   value (ADR 0907 D3 `null`) contributes nothing, never a 0.
 * - **Measured** is modelled web credit (ADR 0956 D2) for the touches that came
 *   from that platform: an ad click id, else a recognised `utm_source`. The
 *   model is the org's default unless the caller names one.
 * - The two are never summed. Their ratio is the **inflation ratio**; it is
 *   flagged when it stays above `INFLATION_THRESHOLD` for `SUSTAIN_DAYS`
 *   consecutive daily windows.
 * - **Overlap** is the sum of every platform's claimed conversions against the
 *   measured total for the campaign, which makes double counting visible: three
 *   platforms each claiming the same sale show claims 3, measured 1.
 *
 * No incrementality calibration yet (D3 is P3): `calibration` is always
 * `null` with its reason, never a guessed factor.
 */
import type { AdPlatform } from '../../host/adsAdapter.js';
import { listRecords } from '../campaign-connectors/performanceService.js';
import type { CampaignPerformanceRecord } from '../campaign-connectors/types.js';
import { currencyExponent } from '../../host/currencyUnits.js';
import { CONVERSION_UNITS, type AttributionModel } from './attributionModels.js';
import { creditTouches, loadAttributionContext } from './attribution.js';
import type { Touch } from './touchPaths.js';

export const INFLATION_THRESHOLD = 1.5;
export const SUSTAIN_DAYS = 7;
const DAY_MS = 86_400_000;

const PLATFORMS: readonly AdPlatform[] = ['meta', 'google', 'tiktok', 'linkedin'];
const CLICK_ID_PLATFORM: Record<NonNullable<Touch['clickIdKind']>, AdPlatform> = { fbclid: 'meta', gclid: 'google', ttclid: 'tiktok', li_fat_id: 'linkedin' };
const SOURCE_PLATFORM: Record<string, AdPlatform> = {
  facebook: 'meta', fb: 'meta', instagram: 'meta', ig: 'meta', meta: 'meta',
  google: 'google', adwords: 'google', youtube: 'google',
  tiktok: 'tiktok',
  linkedin: 'linkedin',
};

/** The ad platform a touch came from: its click id, else its utm_source. */
export function platformOfTouch(t: Touch): AdPlatform | null {
  if (t.clickIdKind) return CLICK_ID_PLATFORM[t.clickIdKind];
  return t.source ? SOURCE_PLATFORM[t.source.trim().toLowerCase()] ?? null : null;
}

export interface InflationVerdict {
  /** reported ÷ measured over the whole report; null when there is nothing to compare. */
  ratio: number | null;
  /** The platform claims conversions and the site measured none. */
  measuredZero: boolean;
  /** Above the threshold in every one of the last `SUSTAIN_DAYS` daily windows. */
  flagged: boolean;
  /** How many of those windows were above it (for "6 of 7 days"). */
  daysAbove: number;
}

export interface ReconciliationRow {
  campaignId: string;
  campaignName: string;
  platform: AdPlatform;
  currency: string;
  spend: number;
  reportedConversions: number;
  /** null when the platform cannot report revenue (ADR 0907 D3). */
  reportedRevenue: number | null;
  reportedRoas: number | null;
  measuredConversions: number;
  /** Credited value in the campaign's currency, major units; other currencies are listed in `measuredValueOther`. */
  measuredRevenue: number;
  measuredValueOther: Array<{ currency: string; minor: number }>;
  measuredRoas: number | null;
  inflation: InflationVerdict;
}

export interface CampaignOverlap {
  campaignId: string;
  campaignName: string;
  /** Sum of every platform's claimed conversions. */
  platformClaims: number;
  /** Modelled web conversions for the campaign, from any channel. */
  measured: number;
  /** claims − measured, when positive: conversions claimed more than once or not seen on the site. */
  overlap: number;
}

export interface ReconciliationReport {
  model: AttributionModel;
  settingsVersion: number;
  rows: ReconciliationRow[];
  overlap: CampaignOverlap[];
  threshold: number;
  sustainDays: number;
  /** D3 calibration is P3: never a guessed factor. */
  calibration: null;
  calibrationReason: 'no_valid_lift_test';
  lineage: { spendRows: number; latestSpendDate: string | null; creditedPaths: number; asOf: string };
  computedAt: string;
}

const round = (n: number, dp = 4): number => Number(n.toFixed(dp));
const day = (iso: string): string => iso.slice(0, 10);

/** Days `asOf-n+1 … asOf` as YYYY-MM-DD, oldest first. */
function lastDays(asOf: string, n: number): string[] {
  const end = Date.parse(`${asOf}T00:00:00.000Z`);
  return Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

/**
 * The sustained-inflation rule: for each of the last `SUSTAIN_DAYS` days, the
 * ratio over the 7-day window ending that day. Flagged only when every window
 * has a claim and is above the threshold (a window with claims and no measured
 * conversions counts as above). PURE.
 */
export function sustainedInflation(reportedByDay: ReadonlyMap<string, number>, measuredByDay: ReadonlyMap<string, number>, asOf: string): { flagged: boolean; daysAbove: number } {
  let daysAbove = 0;
  for (const end of lastDays(asOf, SUSTAIN_DAYS)) {
    const window = lastDays(end, SUSTAIN_DAYS);
    const rep = window.reduce((s, d) => s + (reportedByDay.get(d) ?? 0), 0);
    const meas = window.reduce((s, d) => s + (measuredByDay.get(d) ?? 0), 0);
    if (rep > 0 && (meas === 0 || rep / meas > INFLATION_THRESHOLD)) daysAbove += 1;
  }
  return { flagged: daysAbove === SUSTAIN_DAYS, daysAbove };
}

export async function buildReconciliation(tenantId: string, orgId: string, requested?: AttributionModel, now: Date = new Date()): Promise<ReconciliationReport> {
  const [ctx, records] = await Promise.all([loadAttributionContext(tenantId, orgId), listRecords(tenantId, orgId)]);
  const model = requested ?? ctx.settings.defaultModel;
  const asOf = now.toISOString().slice(0, 10);

  // Measured credit per (campaign, platform), per day, in units and in value.
  type Slot = { units: number; byDay: Map<string, number>; value: Map<string, number> };
  const measured = new Map<string, Slot>(); // `${campaignId}|${platform}` or `${campaignId}|*` for the campaign total
  const slot = (k: string): Slot => {
    let s = measured.get(k);
    if (!s) { s = { units: 0, byDay: new Map(), value: new Map() }; measured.set(k, s); }
    return s;
  };
  let creditedPaths = 0;
  for (const p of ctx.paths) {
    if (p.touches.length === 0) continue;
    creditedPaths += 1;
    const { units, value } = creditTouches(model, p, ctx.settings);
    const d = day(p.conversionAt);
    p.touches.forEach((t, i) => {
      if (!t.campaignId) return;
      const keys = [`${t.campaignId}|*`];
      const platform = platformOfTouch(t);
      if (platform) keys.push(`${t.campaignId}|${platform}`);
      for (const k of keys) {
        const s = slot(k);
        s.units += units[i]!;
        s.byDay.set(d, (s.byDay.get(d) ?? 0) + units[i]!);
        if (p.value && value) s.value.set(p.value.currency, (s.value.get(p.value.currency) ?? 0) + value[i]!);
      }
    });
  }

  const byCampaign = new Map(ctx.campaigns.map((c) => [c.id, c] as const));
  const recordsFor = (campaignId: string, name: string): CampaignPerformanceRecord[] =>
    records.filter((r) => (r.campaignId ? r.campaignId === campaignId : r.campaignName === name));

  const rows: ReconciliationRow[] = [];
  const overlap: CampaignOverlap[] = [];
  for (const c of byCampaign.values()) {
    const perf = recordsFor(c.id, c.name);
    const currency = c.budget?.currency ?? 'USD';
    let claims = 0;
    for (const platform of PLATFORMS) {
      const mine = perf.filter((r) => r.platform === platform);
      const m = measured.get(`${c.id}|${platform}`);
      if (mine.length === 0 && !m) continue;
      const spend = mine.reduce((s, r) => s + r.spend, 0);
      const reportedConversions = mine.reduce((s, r) => s + (r.conversions ?? 0), 0);
      const revenueRows = mine.filter((r) => r.revenue !== null);
      const reportedRevenue = revenueRows.length > 0 ? revenueRows.reduce((s, r) => s + (r.revenue ?? 0), 0) : null;
      claims += reportedConversions;
      const measuredUnits = m?.units ?? 0;
      const measuredConversions = round(measuredUnits / CONVERSION_UNITS);
      const sameCurrencyMinor = m?.value.get(currency) ?? 0;
      const measuredRevenue = round(sameCurrencyMinor / 10 ** currencyExponent(currency), 2);
      const reportedByDay = new Map<string, number>();
      for (const r of mine) reportedByDay.set(r.date, (reportedByDay.get(r.date) ?? 0) + (r.conversions ?? 0) * CONVERSION_UNITS);
      const sustained = sustainedInflation(reportedByDay, m?.byDay ?? new Map(), asOf);
      rows.push({
        campaignId: c.id,
        campaignName: c.name,
        platform,
        currency,
        spend: round(spend, 2),
        reportedConversions,
        reportedRevenue: reportedRevenue === null ? null : round(reportedRevenue, 2),
        reportedRoas: reportedRevenue !== null && spend > 0 ? round(reportedRevenue / spend) : null,
        measuredConversions,
        measuredRevenue,
        measuredValueOther: [...(m?.value.entries() ?? [])].filter(([cur]) => cur !== currency).map(([cur, minor]) => ({ currency: cur, minor })),
        // No credited value in the campaign's currency ⇒ no measured ROAS (null, not 0×):
        // conversions without a value say nothing about return.
        measuredRoas: spend > 0 && m?.value.has(currency) ? round(measuredRevenue / spend) : null,
        inflation: {
          ratio: measuredUnits > 0 ? round((reportedConversions * CONVERSION_UNITS) / measuredUnits) : null,
          measuredZero: reportedConversions > 0 && measuredUnits === 0,
          ...sustained,
        },
      });
    }
    const total = measured.get(`${c.id}|*`)?.units ?? 0;
    if (claims > 0 || total > 0) {
      const meas = round(total / CONVERSION_UNITS);
      overlap.push({ campaignId: c.id, campaignName: c.name, platformClaims: claims, measured: meas, overlap: round(Math.max(0, claims - meas)) });
    }
  }
  return {
    model,
    settingsVersion: ctx.settingsVersion,
    rows: rows.sort((a, b) => b.spend - a.spend || a.campaignId.localeCompare(b.campaignId) || a.platform.localeCompare(b.platform)),
    overlap: overlap.sort((a, b) => b.overlap - a.overlap || a.campaignId.localeCompare(b.campaignId)),
    threshold: INFLATION_THRESHOLD,
    sustainDays: SUSTAIN_DAYS,
    calibration: null,
    calibrationReason: 'no_valid_lift_test',
    lineage: {
      spendRows: records.length,
      latestSpendDate: records.reduce<string | null>((mx, r) => (mx === null || r.date > mx ? r.date : mx), null),
      creditedPaths,
      asOf,
    },
    computedAt: now.toISOString(),
  };
}
