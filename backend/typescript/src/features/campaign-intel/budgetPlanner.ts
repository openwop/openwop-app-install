/**
 * ADR 0357 P1/P2/P4 — the goal-based budget engine + anomaly detection +
 * funnel/performer read models. ALL DETERMINISTIC pure functions over the
 * performance store: money math is never LLM-computed (the Analyst agent
 * narrates these results, it does not produce them).
 */

import type { CampaignPerformanceRecord } from '../campaign-connectors/types.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface BudgetGoal {
  totalBudgetMinor: number;
  targetConversions: number;
  horizonDays: number;
  /** Restrict planning to these platforms (default: every platform with history). */
  platforms?: string[];
}

export interface PlatformPlan {
  platform: string;
  historicalCpaMinor: number;
  historicalCvr: number;
  allocationMinor: number;
  expectedConversions: number;
  dataPoints: number;
}

/**
 * Machine-readable note codes (CS-UX-16 / POLISH-1) — the honest enumeration of
 * every prose branch `planBudget` emits today (currently one: the no-history
 * early return). UIs localize from this; `note` stays the English mirror for
 * API back-compat (surface/route callers may still read it).
 */
export type BudgetPlanNoteCode = 'no_history';

export interface BudgetPlan {
  verdict: 'feasible' | 'stretch' | 'infeasible';
  impliedCpaMinor: number;
  blendedHistoricalCpaMinor: number;
  expectedConversions: number;
  confidence: 'high' | 'medium' | 'low';
  platforms: PlatformPlan[];
  /** Even weekly pacing over the horizon (minor units per week) + each week's
   *  share of the expected conversions (largest-remainder; sums exactly). */
  pacing: Array<{ week: number; budgetMinor: number; expectedConversions: number }>;
  /** English prose mirror of `noteCode` — kept for API back-compat only. */
  note?: string;
  /** Structured note for localization; absent when there is nothing to say. */
  noteCode?: BudgetPlanNoteCode;
  /** Numeric interpolation params for `noteCode` — populated only when a code
   *  carries numbers. None of the current codes do (`no_history` fires on an
   *  EMPTY history, so there is no numeric to report); FE interpolation reads
   *  this when a future code supplies one. */
  noteParams?: Record<string, number>;
}

/** Aggregate per-platform history → CPA/CVR + volume. */
function platformStats(records: CampaignPerformanceRecord[]): Map<string, { spend: number; conversions: number; clicks: number; days: Set<string> }> {
  const by = new Map<string, { spend: number; conversions: number; clicks: number; days: Set<string> }>();
  for (const r of records) {
    const p = by.get(r.platform) ?? { spend: 0, conversions: 0, clicks: 0, days: new Set<string>() };
    p.spend += r.spend; p.conversions += r.conversions; p.clicks += r.clicks; p.days.add(r.date);
    by.set(r.platform, p);
  }
  return by;
}

/**
 * "$X for the quarter, I need N conversions" → deterministic feasibility +
 * efficiency-weighted allocation + pacing + a data-volume confidence band.
 * Spend in the store is MAJOR units; goals arrive in minor units (the money
 * discipline) — converted at the edge here.
 */
export function planBudget(records: CampaignPerformanceRecord[], goal: BudgetGoal): BudgetPlan {
  const wanted = goal.platforms?.map((p) => p.toLowerCase());
  const stats = [...platformStats(records).entries()]
    .filter(([p]) => !wanted || wanted.includes(p.toLowerCase()))
    .map(([platform, s]) => ({
      platform,
      cpaMinor: s.conversions > 0 ? Math.round((s.spend / s.conversions) * 100) : Number.POSITIVE_INFINITY,
      cvr: s.clicks > 0 ? s.conversions / s.clicks : 0,
      conversions: s.conversions,
      days: s.days.size,
    }))
    .filter((s) => Number.isFinite(s.cpaMinor) && s.cpaMinor > 0);

  if (stats.length === 0) {
    return {
      verdict: 'infeasible', impliedCpaMinor: 0, blendedHistoricalCpaMinor: 0, expectedConversions: 0,
      confidence: 'low', platforms: [], pacing: [],
      note: 'No conversion history to plan from — import performance data or run a discovery campaign first.',
      noteCode: 'no_history',
    };
  }

  // Efficiency-weighted allocation: platform weight ∝ 1/CPA. Largest-remainder
  // rounding so the allocations sum EXACTLY to totalBudgetMinor (independent
  // Math.round could overshoot — 101 across two equal CPAs → 51 + 51 = 102).
  const invSum = stats.reduce((s, p) => s + 1 / p.cpaMinor, 0);
  const raw = stats.map((p) => goal.totalBudgetMinor * ((1 / p.cpaMinor) / invSum));
  const allocations = raw.map(Math.floor);
  let residual = goal.totalBudgetMinor - allocations.reduce((s, a) => s + a, 0);
  const byRemainder = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of byRemainder) {
    if (residual <= 0) break;
    allocations[i] = allocations[i]! + 1;
    residual -= 1;
  }
  const platforms: PlatformPlan[] = stats.map((p, idx) => {
    const allocationMinor = allocations[idx]!;
    return {
      platform: p.platform,
      historicalCpaMinor: p.cpaMinor,
      historicalCvr: round2(p.cvr),
      allocationMinor,
      expectedConversions: Math.floor(allocationMinor / p.cpaMinor),
      dataPoints: p.days,
    };
  });

  const expected = platforms.reduce((s, p) => s + p.expectedConversions, 0);
  const impliedCpaMinor = goal.targetConversions > 0 ? Math.round(goal.totalBudgetMinor / goal.targetConversions) : 0;
  const blended = Math.round(goal.totalBudgetMinor / Math.max(1, expected));
  const ratio = expected / Math.max(1, goal.targetConversions);
  const verdict: BudgetPlan['verdict'] = ratio >= 1 ? 'feasible' : ratio >= 0.7 ? 'stretch' : 'infeasible';

  const totalDays = platforms.reduce((s, p) => s + p.dataPoints, 0);
  const confidence: BudgetPlan['confidence'] = totalDays >= 60 ? 'high' : totalDays >= 21 ? 'medium' : 'low';

  const weeks = Math.max(1, Math.ceil(goal.horizonDays / 7));
  // Even pacing: floor share per week, BOTH remainders to the EARLIEST weeks
  // (FU-DATA-5 — budget used to lump its remainder on the LAST week while
  // conversions front-loaded theirs, skewing the implied weekly CPA at the
  // ends). Each column still sums EXACTLY to its total.
  const perWeek = Math.floor(goal.totalBudgetMinor / weeks);
  const budgetRemainder = goal.totalBudgetMinor % weeks;
  const convPerWeek = Math.floor(expected / weeks);
  const convRemainder = expected % weeks;
  const pacing = Array.from({ length: weeks }, (_, i) => ({
    week: i + 1,
    budgetMinor: perWeek + (i < budgetRemainder ? 1 : 0),
    expectedConversions: convPerWeek + (i < convRemainder ? 1 : 0),
  }));

  return { verdict, impliedCpaMinor, blendedHistoricalCpaMinor: blended, expectedConversions: expected, confidence, platforms, pacing };
}

/** Scenario modeling: shift a % of one platform's allocation to another and
 *  recompute expected conversions — pure recompute, no new data. */
export function scenarioShift(plan: BudgetPlan, from: string, to: string, pct: number): { expectedConversions: number; delta: number } | null {
  const src = plan.platforms.find((p) => p.platform.toLowerCase() === from.toLowerCase());
  const dst = plan.platforms.find((p) => p.platform.toLowerCase() === to.toLowerCase());
  if (!src || !dst || pct <= 0 || pct > 1) return null;
  const moved = Math.round(src.allocationMinor * pct);
  const expected = plan.platforms.reduce((s, p) => {
    const alloc = p === src ? p.allocationMinor - moved : p === dst ? p.allocationMinor + moved : p.allocationMinor;
    return s + Math.floor(alloc / p.historicalCpaMinor);
  }, 0);
  return { expectedConversions: expected, delta: expected - plan.expectedConversions };
}

// ── ADR 0357 P2 — anomaly detection (rolling stats, min-N guarded) ──────────

export interface Anomaly {
  platform: string;
  campaignName: string;
  metric: 'spend' | 'ctr' | 'cpa';
  date: string;
  value: number;
  mean: number;
  z: number;
  direction: 'spike' | 'drop';
}

const Z_THRESHOLD = 3;
const MIN_POINTS = 7;

/** |z| ≥ 3 spikes/drops per (platform, campaign, metric) over its own daily
 *  series. Deterministic; series shorter than MIN_POINTS are skipped. */
export function detectAnomalies(records: CampaignPerformanceRecord[]): Anomaly[] {
  const series = new Map<string, CampaignPerformanceRecord[]>();
  for (const r of records) {
    const key = `${r.platform}::${r.campaignName}`;
    const arr = series.get(key) ?? [];
    arr.push(r);
    series.set(key, arr);
  }
  const out: Anomaly[] = [];
  for (const [key, rows] of series) {
    // R2 CI-SP-6 — a record is one day of ONE AD-SET: the raw list made each
    // ad-set row a "daily" series point, so the z-score baseline mixed
    // per-ad-set values with per-day semantics (a big ad-set beside a small
    // one inflates σ, and 3 days of 3 ad-sets satisfied MIN_POINTS=7).
    // Aggregate per DATE before anything statistical.
    const byDate = new Map<string, CampaignPerformanceRecord>();
    for (const r of rows) {
      const d = byDate.get(r.date);
      if (!d) byDate.set(r.date, { ...r });
      else { d.spend += r.spend; d.conversions += r.conversions; d.clicks += r.clicks; d.impressions += r.impressions; }
    }
    const daily = [...byDate.values()];
    if (daily.length < MIN_POINTS) continue;
    const sorted = daily.sort((a, b) => a.date.localeCompare(b.date));
    const metrics: Array<{ name: Anomaly['metric']; of: (r: CampaignPerformanceRecord) => number }> = [
      { name: 'spend', of: (r) => r.spend },
      { name: 'ctr', of: (r) => (r.impressions > 0 ? r.clicks / r.impressions : 0) },
      { name: 'cpa', of: (r) => (r.conversions > 0 ? r.spend / r.conversions : 0) },
    ];
    const [platform, campaignName] = key.split('::') as [string, string];
    for (const m of metrics) {
      // CPA is UNDEFINED on a zero-conversion day — folding those days in as 0
      // poisons the baseline (a mostly-0 series makes every real CPA day read
      // as a spike). Build the cpa series from converting days only, and
      // re-apply the min-N guard to the filtered series.
      const days = m.name === 'cpa' ? sorted.filter((r) => r.conversions > 0) : sorted;
      if (days.length < MIN_POINTS) continue;
      const values = days.map(m.of);
      const mean = values.reduce((s, v) => s + v, 0) / values.length;
      const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
      const std = Math.sqrt(variance);
      if (std === 0) continue;
      values.forEach((v, i) => {
        const z = (v - mean) / std;
        if (Math.abs(z) >= Z_THRESHOLD) {
          out.push({ platform, campaignName, metric: m.name, date: days[i]!.date, value: round2(v), mean: round2(mean), z: round2(z), direction: z > 0 ? 'spike' : 'drop' });
        }
      });
    }
  }
  return out.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}

// ── ADR 0357 P4 — funnel + top/bottom performers (read models) ──────────────

export function funnelByPlatform(records: CampaignPerformanceRecord[]): Array<{ platform: string; impressions: number; clicks: number; conversions: number }> {
  const by = new Map<string, { impressions: number; clicks: number; conversions: number }>();
  for (const r of records) {
    const p = by.get(r.platform) ?? { impressions: 0, clicks: 0, conversions: 0 };
    p.impressions += r.impressions; p.clicks += r.clicks; p.conversions += r.conversions;
    by.set(r.platform, p);
  }
  return [...by.entries()].map(([platform, v]) => ({ platform, ...v })).sort((a, b) => b.impressions - a.impressions);
}

/** Top/bottom campaigns by ROAS (min-spend guarded so tiny spends don't rank). */
export function topBottomPerformers(records: CampaignPerformanceRecord[], opts: { minSpend?: number; limit?: number } = {}): { top: Array<{ campaignName: string; platform: string; spend: number; roas: number }>; bottom: Array<{ campaignName: string; platform: string; spend: number; roas: number }> } {
  const minSpend = opts.minSpend ?? 100;
  const limit = opts.limit ?? 5;
  const by = new Map<string, { platform: string; spend: number; revenue: number }>();
  for (const r of records) {
    const key = `${r.platform}::${r.campaignName}`;
    const p = by.get(key) ?? { platform: r.platform, spend: 0, revenue: 0 };
    p.spend += r.spend; p.revenue += r.revenue;
    by.set(key, p);
  }
  const rows = [...by.entries()]
    .filter(([, v]) => v.spend >= minSpend)
    .map(([key, v]) => ({ campaignName: key.split('::')[1]!, platform: v.platform, spend: round2(v.spend), roas: v.spend > 0 ? round2(v.revenue / v.spend) : 0 }))
    .sort((a, b) => b.roas - a.roas);
  // Disjoint slices: with fewer than 2×limit rows, bottom takes only what top
  // didn't (a campaign must never appear as both a top AND bottom performer).
  return { top: rows.slice(0, limit), bottom: rows.slice(Math.max(limit, rows.length - limit)).reverse() };
}
