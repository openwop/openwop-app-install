/**
 * Campaign intelligence engine (ADR 0160 Phase 1) — PURE budget optimizer +
 * forecaster over campaign performance records (ADR 0159). Deterministic,
 * unit-testable, replay-trivial; the LLM-scenario layer is the node's optional
 * enrichment (the ADR 0155 heuristic-in-service / AI-in-node seam).
 *
 * @see docs/adr/0160-campaign-studio-intelligence.md
 */

import type { CampaignPerformanceRecord } from '../campaign-connectors/types.js';

export interface BudgetReallocation {
  platform: string;
  currentSpend: number;
  suggestedSpend: number;
  changeAmount: number;
  changePercent: number;
  roas: number;
  reason: string;
}

export interface BudgetRecommendation {
  totalSpend: number;
  reallocations: BudgetReallocation[];
  projectedRoasGain: number;
  /** R2 CI-SP-3 — structured note the FE localizes+formats; `note` is the
   *  English prose mirror for older frontends. */
  noteCode?: 'concentrated' | 'shift' | 'not_enough_platforms';
  noteParams?: { shift: number; from: string; to: string };
  note: string;
}

const round2 = (n: number): number => Number(n.toFixed(2));

/**
 * Heuristic budget reallocation: rank platforms by ROAS, shift up to `maxShiftPct`
 * of total spend from below-median toward above-median ROAS, respecting a
 * `minSpendFloor` per platform. Advisory — uses ROAS as the marginal proxy with a
 * diminishing-returns dampener (the shift is capped, not all-in).
 */
export function optimizeBudget(
  records: CampaignPerformanceRecord[],
  opts: { maxShiftPct?: number; minSpendFloor?: number } = {},
): BudgetRecommendation {
  const maxShiftPct = opts.maxShiftPct ?? 0.2;
  const minSpendFloor = opts.minSpendFloor ?? 0;

  // Aggregate spend + revenue per platform.
  const byPlatform = new Map<string, { spend: number; revenue: number }>();
  for (const r of records) {
    // A platform that cannot report revenue (ADR 0907 D3 `null`) is left out
    // of the ROAS comparison rather than read as ROAS 0 and drained of budget.
    if (r.revenue === null) continue;
    const p = byPlatform.get(r.platform) ?? { spend: 0, revenue: 0 };
    p.spend += r.spend; p.revenue += r.revenue;
    byPlatform.set(r.platform, p);
  }
  const platforms = [...byPlatform.entries()].map(([platform, v]) => ({
    platform, spend: v.spend, revenue: v.revenue, roas: v.spend > 0 ? v.revenue / v.spend : 0,
  }));
  const totalSpend = platforms.reduce((s, p) => s + p.spend, 0);
  if (platforms.length < 2 || totalSpend <= 0) {
    return { totalSpend: round2(totalSpend), reallocations: [], projectedRoasGain: 0, noteCode: 'not_enough_platforms', note: 'Not enough platforms to reallocate.' };
  }

  const sorted = [...platforms].sort((a, b) => b.roas - a.roas);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  // Shift budget = min(maxShiftPct of total, worst's spend above the floor).
  const shift = Math.min(totalSpend * maxShiftPct, Math.max(0, worst.spend - minSpendFloor));

  const reallocations: BudgetReallocation[] = [];
  if (shift > 0 && best.roas > worst.roas) {
    reallocations.push({
      platform: worst.platform, currentSpend: round2(worst.spend), suggestedSpend: round2(worst.spend - shift),
      changeAmount: round2(-shift), changePercent: round2((-shift / worst.spend) * 100), roas: round2(worst.roas),
      reason: `Lowest ROAS (${round2(worst.roas)}×) — trim and reinvest.`,
    });
    reallocations.push({
      platform: best.platform, currentSpend: round2(best.spend), suggestedSpend: round2(best.spend + shift),
      changeAmount: round2(shift), changePercent: round2((shift / best.spend) * 100), roas: round2(best.roas),
      reason: `Highest ROAS (${round2(best.roas)}×) — scale into headroom.`,
    });
  }
  // Projected gain: the shifted spend earns at best ROAS instead of worst (capped).
  const projectedRoasGain = shift > 0 ? round2(shift * (best.roas - worst.roas)) : 0;
  return {
    totalSpend: round2(totalSpend),
    reallocations,
    projectedRoasGain,
    // R2 CI-SP-3 — the structured code+params are the real content; the FE
    // localizes and formats them under the mixed-currency rule. The prose
    // mirror stays for older frontends but no longer mints a `$` the org's own
    // figures were carefully un-labelled from (the round-1 fix's surviving
    // sibling: a EUR+GBP org read "Shift ~$1,234" one line above its unlabelled
    // table).
    noteCode: reallocations.length === 0 ? 'concentrated' as const : 'shift' as const,
    ...(reallocations.length > 0 ? { noteParams: { shift: round2(shift), from: worst.platform, to: best.platform } } : {}),
    note: reallocations.length === 0 ? 'Spend is already concentrated in the best-performing platform.' : `Shift ~${round2(shift)} from ${worst.platform} to ${best.platform}.`,
  };
}

export interface CampaignForecast {
  campaignName: string;
  platform: string;
  creativeFatigue: { detected: boolean; firstHalfCtr: number; secondHalfCtr: number; dropPercent: number };
  projection: { days: number; projectedSpend: number; projectedConversions: number };
}

/**
 * Per-campaign forecast: creative-fatigue (second-half CTR mean vs first-half,
 * flagged when it drops >`fatigueThreshold`) + a linear outcome projection of the
 * daily spend/conversions run-rate over `horizonDays`.
 */
export function forecastCampaigns(
  records: CampaignPerformanceRecord[],
  opts: { fatigueThreshold?: number; horizonDays?: number } = {},
): CampaignForecast[] {
  const fatigueThreshold = opts.fatigueThreshold ?? 0.15;
  const horizonDays = opts.horizonDays ?? 30;

  const groups = new Map<string, CampaignPerformanceRecord[]>();
  for (const r of records) {
    const key = `${r.platform}\u0000${r.campaignName}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }

  const out: CampaignForecast[] = [];
  for (const [key, recs] of groups) {
    const [platform, campaignName] = key.split('\u0000');
    // R2 CI-SP-6 — a record is one day of ONE AD-SET, and the group key drops
    // the ad-set: dividing by record count tripled `days` for a 3-ad-set
    // campaign and projected ⅓ of truth (pacing.ts counts distinct dates — the
    // two modules disagreed on what a "day" is). Aggregate per DATE first; CTR
    // is impression-weighted, not an unweighted mean of per-row ratios.
    const byDate = new Map<string, { date: string; spend: number; conversions: number; clicks: number; impressions: number }>();
    for (const r of recs) {
      const d = byDate.get(r.date) ?? { date: r.date, spend: 0, conversions: 0, clicks: 0, impressions: 0 };
      d.spend += r.spend; d.conversions += r.conversions ?? 0; d.clicks += r.clicks; d.impressions += r.impressions;
      byDate.set(r.date, d);
    }
    const sorted = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    const mid = Math.floor(sorted.length / 2);
    const meanCtr = (arr: Array<{ clicks: number; impressions: number }>): number => {
      const impressions = arr.reduce((s, r) => s + r.impressions, 0);
      if (impressions === 0) return 0;
      return arr.reduce((s, r) => s + r.clicks, 0) / impressions;
    };
    const firstHalfCtr = meanCtr(sorted.slice(0, mid || 1));
    const secondHalfCtr = meanCtr(sorted.slice(mid));
    const dropPercent = firstHalfCtr > 0 ? (firstHalfCtr - secondHalfCtr) / firstHalfCtr : 0;

    const days = sorted.length || 1;
    const dailySpend = sorted.reduce((s, r) => s + r.spend, 0) / days;
    const dailyConv = sorted.reduce((s, r) => s + r.conversions, 0) / days;
    out.push({
      campaignName, platform,
      creativeFatigue: { detected: sorted.length >= 4 && dropPercent > fatigueThreshold, firstHalfCtr: round2(firstHalfCtr), secondHalfCtr: round2(secondHalfCtr), dropPercent: round2(dropPercent * 100) },
      projection: { days: horizonDays, projectedSpend: round2(dailySpend * horizonDays), projectedConversions: round2(dailyConv * horizonDays) },
    });
  }
  return out;
}
