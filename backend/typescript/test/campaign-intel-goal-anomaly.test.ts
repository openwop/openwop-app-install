/**
 * ADR 0357 — goal budgeting, anomalies, presets, breaker. Pins:
 *  - planBudget: no-history infeasible; efficiency-weighted allocation favors
 *    the cheaper-CPA platform; verdict banding; pacing sums to the budget;
 *    scenarioShift recomputes deterministically;
 *  - detectAnomalies: |z|≥3 spike detection; zero-conversion days are
 *    excluded from the CPA series. HONEST CEILING (INTEL-ANOM-MINN): the
 *    MIN_POINTS=7 guard is unobservable — under population σ the largest
 *    |z| in n points is √(n−1) (Samuelson), so n ≤ 9 can never reach 3;
 *    no test can witness it, so none claims to;
 *  - funnel + top/bottom (min-spend guard);
 *  - CSV preset pins exact platform headers over autodetect;
 *  - the circuit breaker opens after 5 failures, half-opens after cooldown,
 *    success closes it, a FAILED probe re-opens it (fresh cooldown), and
 *    half-open admits exactly one probe at a time.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { planBudget, scenarioShift, detectAnomalies, funnelByPlatform, topBottomPerformers } from '../src/features/campaign-intel/budgetPlanner.js';
import { mappingWithPreset, parseCsv } from '../src/features/campaign-connectors/csvImport.js';
import { reportConnectionFailure, reportConnectionSuccess, circuitStatus, __resetCircuitBreakers } from '../src/features/connections/connectionsService.js';
import type { AdPlatform, CampaignPerformanceRecord } from '../src/features/campaign-connectors/types.js';

afterEach(() => { __resetCircuitBreakers(); vi.useRealTimers(); });

function rec(platform: AdPlatform, date: string, over: Partial<CampaignPerformanceRecord> = {}): CampaignPerformanceRecord {
  return {
    id: `${platform}:${date}`, tenantId: 't', orgId: 'o', platform,
    campaignName: 'Camp', adSet: 'A', date, spend: 100, impressions: 10_000, clicks: 200, conversions: 10, revenue: 500,
    ctr: 0.02, cpc: 0.5, cvr: 0.05, cpa: 10, roas: 5, source: 'csv',
    ...over,
  } as CampaignPerformanceRecord;
}

describe('planBudget (P1)', () => {
  it('no history → infeasible with a note (structured noteCode + English mirror)', () => {
    const p = planBudget([], { totalBudgetMinor: 50_000_00, targetConversions: 500, horizonDays: 90 });
    expect(p.verdict).toBe('infeasible');
    // CS-UX-16/POLISH-1: the note is machine-readable so UIs localize it…
    expect(p.noteCode).toBe('no_history');
    // …while the English prose stays for API back-compat.
    expect(p.note).toContain('No conversion history');
  });

  it('allocates by inverse CPA, bands the verdict, paces to the total', () => {
    const records = [
      // google: $100 → 10 conv (CPA $10); meta: $100 → 2 conv (CPA $50)
      ...Array.from({ length: 10 }, (_, i) => rec('google', `2026-06-${String(i + 1).padStart(2, '0')}`, { spend: 10, conversions: 1 })),
      ...Array.from({ length: 10 }, (_, i) => rec('meta', `2026-06-${String(i + 1).padStart(2, '0')}`, { spend: 10, conversions: 0.2 })),
    ];
    const p = planBudget(records, { totalBudgetMinor: 100_000, targetConversions: 50, horizonDays: 28 });
    const google = p.platforms.find((x) => x.platform === 'google')!;
    const meta = p.platforms.find((x) => x.platform === 'meta')!;
    // CPA google 1000 minor, meta 5000 → weights 5:1 → 83333.3 / 16666.7,
    // largest remainder gives meta the residual unit.
    expect(google.allocationMinor).toBe(83_333); // cheaper CPA gets more
    expect(meta.allocationMinor).toBe(16_667);
    expect(p.expectedConversions).toBe(86); // floor(83333/1000) + floor(16667/5000)
    expect(p.pacing.reduce((s, w) => s + w.budgetMinor, 0)).toBe(100_000); // pacing sums exactly
    expect(p.pacing.reduce((s, w) => s + w.expectedConversions, 0)).toBe(p.expectedConversions); // weekly conv. shares sum exactly
    expect(p.noteCode).toBeUndefined(); // a plannable goal carries no note
    // Verdict bands on expected/target: 86/50 ≥ 1 feasible; 86/100 = .86 stretch; 86/200 = .43 infeasible.
    expect(p.verdict).toBe('feasible');
    expect(planBudget(records, { totalBudgetMinor: 100_000, targetConversions: 100, horizonDays: 28 }).verdict).toBe('stretch');
    expect(planBudget(records, { totalBudgetMinor: 100_000, targetConversions: 200, horizonDays: 28 }).verdict).toBe('infeasible');

    // Move 50% of meta (8334) to google: floor(91667/1000) + floor(8333/5000) = 92.
    const sc = scenarioShift(p, 'meta', 'google', 0.5);
    expect(sc).toEqual({ expectedConversions: 92, delta: 6 });
  });

  it('allocations sum EXACTLY to the budget — incl. 101 across two equal CPAs (largest remainder)', () => {
    // Two platforms with IDENTICAL CPA: 101 minor units → 50.5 each; naive
    // per-platform rounding produced 51 + 51 = 102 (over-allocation).
    const equal = [
      ...Array.from({ length: 8 }, (_, i) => rec('google', `2026-06-0${i + 1}`, { spend: 10, conversions: 1 })),
      ...Array.from({ length: 8 }, (_, i) => rec('meta', `2026-06-0${i + 1}`, { spend: 10, conversions: 1 })),
    ];
    const p = planBudget(equal, { totalBudgetMinor: 101, targetConversions: 1, horizonDays: 7 });
    expect(p.platforms.reduce((s, x) => s + x.allocationMinor, 0)).toBe(101);

    // Uneven three-way split still sums exactly.
    const uneven = [
      ...Array.from({ length: 8 }, (_, i) => rec('google', `2026-06-0${i + 1}`, { spend: 10, conversions: 1 })),
      ...Array.from({ length: 8 }, (_, i) => rec('meta', `2026-06-0${i + 1}`, { spend: 30, conversions: 1 })),
      ...Array.from({ length: 8 }, (_, i) => rec('tiktok', `2026-06-0${i + 1}`, { spend: 70, conversions: 1 })),
    ];
    const q = planBudget(uneven, { totalBudgetMinor: 99_999, targetConversions: 100, horizonDays: 30 });
    expect(q.platforms.reduce((s, x) => s + x.allocationMinor, 0)).toBe(99_999);
  });
});

describe('detectAnomalies (P2)', () => {
  it('flags a 10x spend spike (min-N itself is unobservable — see header)', () => {
    const rows = Array.from({ length: 13 }, (_, i) => rec('google', `2026-06-${String(i + 1).padStart(2, '0')}`));
    rows.push(rec('google', '2026-06-14', { spend: 5000 })); // the spike
    const found = detectAnomalies(rows);
    expect(found.some((a) => a.metric === 'spend' && a.direction === 'spike' && a.date === '2026-06-14')).toBe(true);
  });

  it('zero-conversion days do not poison the CPA baseline', () => {
    // 20 steady converting days (CPA 10) + ONE zero-conversion day. Folded in
    // as CPA 0, that day scores z ≈ −4.47 against the steady 10s and reads as
    // a "drop"; built from converting days only, the series is flat → nothing.
    const steady: CampaignPerformanceRecord[] = [
      ...Array.from({ length: 20 }, (_, i) => rec('google', `2026-06-${String(i + 1).padStart(2, '0')}`, { spend: 100, conversions: 10 })),
      rec('google', '2026-06-21', { spend: 100, conversions: 0 }),
    ];
    expect(detectAnomalies(steady).filter((a) => a.metric === 'cpa')).toEqual([]);

    // A real CPA spike is still flagged beside zero-conversion days, and no
    // cpa anomaly is ever dated on a zero-conversion day.
    const rows: CampaignPerformanceRecord[] = [];
    for (let i = 1; i <= 13; i++) {
      rows.push(rec('google', `2026-06-${String(i * 2 - 1).padStart(2, '0')}`, { spend: 100, conversions: 10 })); // CPA 10
      rows.push(rec('google', `2026-06-${String(i * 2).padStart(2, '0')}`, { spend: 100, conversions: 0 }));
    }
    rows.push(rec('google', '2026-06-27', { spend: 1000, conversions: 1 })); // CPA 1000 — the real spike
    const found = detectAnomalies(rows).filter((a) => a.metric === 'cpa');
    expect(found.some((a) => a.direction === 'spike' && a.date === '2026-06-27')).toBe(true);
    const zeroDays = new Set(rows.filter((r) => r.conversions === 0).map((r) => r.date));
    expect(found.some((a) => zeroDays.has(a.date))).toBe(false);
  });

  it('zero-conversion days are excluded BEFORE the CPA statistics (16 raw → 6 usable)', () => {
    // 6 converting days + 10 zero-conversion days. Unfiltered, the mostly-0
    // series flags the 1000-CPA day as a spike (z ≈ 3.87). Filtered, 6 points
    // can never reach |z| ≥ 3 (√5 ≈ 2.24) — so this witnesses the FILTER; the
    // post-filter MIN_POINTS recheck itself is unobservable (INTEL-ANOM-MINN).
    const rows: CampaignPerformanceRecord[] = [
      ...Array.from({ length: 10 }, (_, i) => rec('google', `2026-06-${String(i + 1).padStart(2, '0')}`, { spend: 100, conversions: 0 })),
      ...Array.from({ length: 5 }, (_, i) => rec('google', `2026-06-${String(i + 11).padStart(2, '0')}`, { spend: 100, conversions: 10 })),
      rec('google', '2026-06-16', { spend: 1000, conversions: 1 }),
    ];
    expect(detectAnomalies(rows).filter((a) => a.metric === 'cpa')).toEqual([]);
  });
});

describe('funnel + performers (P4)', () => {
  it('aggregates the funnel; min-spend guards the rankings', () => {
    const records = [
      rec('google', '2026-06-01', { campaignName: 'Big', spend: 1000, revenue: 8000 }),
      rec('google', '2026-06-02', { campaignName: 'Tiny', spend: 1, revenue: 100 }), // below min-spend
    ];
    // Funnel: per-platform SUMS, ordered by impressions.
    const funnel = funnelByPlatform([
      ...records,
      rec('meta', '2026-06-01', { impressions: 5_000, clicks: 50, conversions: 3 }),
    ]);
    expect(funnel).toEqual([
      { platform: 'google', impressions: 20_000, clicks: 400, conversions: 20 },
      { platform: 'meta', impressions: 5_000, clicks: 50, conversions: 3 },
    ]);
    const perf = topBottomPerformers(records, { minSpend: 100 });
    expect(perf.top.map((p) => p.campaignName)).toEqual(['Big']); // Tiny filtered
  });

  it('top/bottom slices are DISJOINT when rows < 2×limit', () => {
    const records = [
      rec('google', '2026-06-01', { campaignName: 'A', spend: 1000, revenue: 9000 }), // roas 9
      rec('google', '2026-06-02', { campaignName: 'B', spend: 1000, revenue: 5000 }), // roas 5
      rec('google', '2026-06-03', { campaignName: 'C', spend: 1000, revenue: 1000 }), // roas 1
    ];
    // limit 2 over 3 rows: top takes A+B; bottom may only take what's left (C).
    const perf = topBottomPerformers(records, { minSpend: 100, limit: 2 });
    expect(perf.top.map((p) => p.campaignName)).toEqual(['A', 'B']);
    expect(perf.bottom.map((p) => p.campaignName)).toEqual(['C']);
    // Default limit 5 over 3 rows: everything is top; bottom is honestly empty.
    const all = topBottomPerformers(records, { minSpend: 100 });
    expect(all.top.map((p) => p.campaignName)).toEqual(['A', 'B', 'C']);
    expect(all.bottom).toEqual([]);
  });
});

describe('CSV presets (P5)', () => {
  it('a preset pins the platform headers; unknown preset falls back to autodetect', () => {
    // Both 'Spend' and 'Cost' are spend aliases; autodetect takes the FIRST
    // alias ('spend'), so only the google preset can choose 'Cost'.
    const { headers } = parseCsv('Campaign,Ad group,Day,Spend,Cost,Impr.,Clicks,Conversions,Total conv. value\nA,B,2026-06-01,10,10,100,5,1,50');
    expect(mappingWithPreset(headers).spend).toBe('Spend'); // autodetect alone
    const google = mappingWithPreset(headers, 'google');
    expect(google.spend).toBe('Cost'); // pinned by the preset, over autodetect
    expect(google.impressions).toBe('Impr.');
    const unknown = mappingWithPreset(headers, 'no-such-platform');
    expect(unknown.spend).toBe('Spend'); // unknown preset = plain autodetect
    expect(unknown.campaignName).toBe('Campaign');
  });
});

describe('circuit breaker (P6)', () => {
  it('opens after 5 consecutive failures, half-opens after cooldown, closes on success', () => {
    vi.useFakeTimers();
    const T = 'tb'; const K = 'ads:meta';
    for (let i = 0; i < 4; i++) expect(reportConnectionFailure(T, K)).toBe(false);
    expect(circuitStatus(T, K)).toBe('closed');
    expect(reportConnectionFailure(T, K)).toBe(true); // the 5th opens
    expect(circuitStatus(T, K)).toBe('open');

    vi.advanceTimersByTime(121_000);
    expect(circuitStatus(T, K)).toBe('half-open'); // one probe allowed

    reportConnectionSuccess(T, K);
    expect(circuitStatus(T, K)).toBe('closed');
  });

  it('a failed half-open probe RE-OPENS the circuit with a fresh cooldown', () => {
    vi.useFakeTimers();
    const T = 'tb2'; const K = 'ads:google';
    for (let i = 0; i < 5; i++) reportConnectionFailure(T, K);
    expect(circuitStatus(T, K)).toBe('open');

    vi.advanceTimersByTime(121_000);
    expect(circuitStatus(T, K)).toBe('half-open'); // the probe is admitted
    expect(reportConnectionFailure(T, K)).toBe(true); // the probe FAILS → re-opened

    // Without the openedAtMs refresh this stayed 'half-open' forever.
    expect(circuitStatus(T, K)).toBe('open');
    vi.advanceTimersByTime(60_000);
    expect(circuitStatus(T, K)).toBe('open'); // fresh cooldown still running
    vi.advanceTimersByTime(61_000);
    expect(circuitStatus(T, K)).toBe('half-open'); // next probe after the FULL new cooldown
  });

  it('half-open admits exactly ONE probe; concurrent readers stay refused', () => {
    vi.useFakeTimers();
    const T = 'tb3'; const K = 'ads:meta';
    for (let i = 0; i < 5; i++) reportConnectionFailure(T, K);
    vi.advanceTimersByTime(121_000);

    expect(circuitStatus(T, K)).toBe('half-open'); // first reader claims the probe slot
    expect(circuitStatus(T, K)).toBe('open'); // a concurrent reader is refused
    expect(circuitStatus(T, K)).toBe('open');

    // A probe that never reports back must not wedge the breaker: the slot
    // expires after the probe window and the next reader may try again.
    vi.advanceTimersByTime(31_000);
    expect(circuitStatus(T, K)).toBe('half-open');

    reportConnectionSuccess(T, K); // this probe succeeds
    expect(circuitStatus(T, K)).toBe('closed');
  });
});
