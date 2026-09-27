/**
 * Budget pacing (ADR 0220 / campaign gap plan §5C C7 — ADR 0160's deferred
 * alert scope). Compares each campaign's ACTUAL spend (performance store —
 * fresh via the C2 daily sync and/or CSV imports) against its PLAN
 * (`campaign.budget.totalMinor`, the C8 field) and raises band-escalation
 * alerts through the ONE notification seam.
 *
 * Alert discipline: a durable per-campaign band memo (`campaign-intel:pacing`)
 * means a campaign alerts once per band ESCALATION (none → 80% → 100%), never
 * on every scheduled run — recurrence is the chain's schedule, dedup is here.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { onCampaignDeleted } from '../../host/campaignLifecycle.js';
import { createLogger } from '../../observability/logger.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { listRecords } from '../campaign-connectors/performanceService.js';
// Cross-feature READ (the documented precedent).
import { listCampaigns } from '../campaign-orchestration/campaignService.js';
import { minorToMajor } from '../../host/currencyUnits.js';

const log = createLogger('campaign-intel.pacing');

export type PacingBand = 'ok' | 'warning' | 'over';

export interface PacingRow {
  campaignId: string;
  name: string;
  /** Plan, major units (totalMinor scaled by the currency's own ISO exponent — R2 CI-SP-5). */
  budget: number;
  currency: string;
  /** Actual, major units (the performance store's normalization). */
  spend: number;
  spentPct: number;
  band: PacingBand;
  /** Simple linear projection: average daily spend × 30 (null under 2 spend days). */
  projectedMonthlySpend: number | null;
}

export interface PacingReport {
  rows: PacingRow[];
  /** Campaigns with no budget plan — surfaced so "no alerts" is legible. */
  unplanned: number;
  computedAt: string;
}

interface PacingMemo {
  key: string;
  tenantId: string;
  campaignId: string;
  band: PacingBand;
  at: string;
}
const memos = new DurableCollection<PacingMemo>('campaign-intel:pacing', (m) => m.key);
const memoKey = (tenantId: string, campaignId: string): string => `${tenantId}::${campaignId}`;

// Content-scout residue — the per-campaign anti-double-alert memo was left behind on
// campaign delete. Prune it via the campaign delete seam (this feature cleans its own).
onCampaignDeleted('pacing-memo-by-campaign', async ({ tenantId, campaignId }) => {
  await memos.delete(memoKey(tenantId, campaignId));
});

const BANDS: Record<PacingBand, number> = { ok: 0, warning: 1, over: 2 };
const bandOf = (pct: number): PacingBand => (pct >= 100 ? 'over' : pct >= 80 ? 'warning' : 'ok');

/** Compute the pacing report (pure read — no alerts). */
export async function buildPacing(tenantId: string, orgId: string): Promise<PacingReport> {
  const [campaigns, records] = await Promise.all([listCampaigns(tenantId, orgId), listRecords(tenantId, orgId)]);
  const rows: PacingRow[] = [];
  let unplanned = 0;
  for (const campaign of campaigns) {
    if (campaign.status === 'archived') continue;
    const totalMinor = campaign.budget?.totalMinor;
    if (totalMinor === undefined || totalMinor <= 0) { unplanned += 1; continue; }
    const perf = records.filter((r) => (r.campaignId ? r.campaignId === campaign.id : r.campaignName === campaign.name));
    const spend = perf.reduce((s, r) => s + r.spend, 0);
    // R2 CI-SP-5 — totalMinor is ISO minor units per the budget's own currency
    // (the brief writes exponent-aware since #3094): a blind /100 read a JPY
    // ¥500,000 plan as ¥5,000 and banded the campaign "over" instantly.
    const budget = minorToMajor(totalMinor, campaign.budget?.currency);
    const spentPct = Number(((spend / budget) * 100).toFixed(1));
    const days = new Set(perf.map((r) => r.date)).size;
    rows.push({
      campaignId: campaign.id,
      name: campaign.name,
      budget: Number(budget.toFixed(2)),
      currency: campaign.budget?.currency ?? 'USD',
      spend: Number(spend.toFixed(2)),
      spentPct,
      band: bandOf(spentPct),
      projectedMonthlySpend: days >= 2 ? Number(((spend / days) * 30).toFixed(2)) : null,
    });
  }
  return { rows: rows.sort((a, b) => b.spentPct - a.spentPct), unplanned, computedAt: new Date().toISOString() };
}

export interface PacingAlertOutcome {
  report: PacingReport;
  alerted: Array<{ campaignId: string; band: PacingBand }>;
}

/** Compute + alert on band ESCALATIONS (the chain's node calls this). The
 *  notification goes to the tenant inbox (no recipient pin — the commerce
 *  precedent); prefs/mutes apply downstream. */
export async function runPacingCheck(tenantId: string, orgId: string): Promise<PacingAlertOutcome> {
  const report = await buildPacing(tenantId, orgId);
  const alerted: PacingAlertOutcome['alerted'] = [];
  for (const row of report.rows) {
    const key = memoKey(tenantId, row.campaignId);
    const memo = await memos.get(key).catch(() => undefined);
    const prior: PacingMemo | null = memo && memo.tenantId === tenantId ? memo : null;
    const priorBand: PacingBand = prior ? prior.band : 'ok';
    // R2 CI-SP-7 — the memo must also be written DOWN. It was only ever written
    // up, so recover→re-overspend was silent forever: one overspend alert per
    // campaign per LIFETIME, not per escalation episode (breaking this
    // function's own "alerts once per band ESCALATION" contract). Same CAS
    // discipline; a lost race just means another run already moved it.
    if (prior && BANDS[row.band] < BANDS[priorBand]) {
      await memos.compareAndSwap(prior, { ...prior, band: row.band, at: new Date().toISOString() }).catch(() => undefined);
      continue;
    }
    if (row.band === 'ok') continue;
    if (BANDS[row.band] <= BANDS[priorBand]) continue; // no escalation — no re-alert
    // CLAIM the escalation atomically BEFORE emitting (grade-code AUDIT-8): a
    // check-then-emit-then-write race let two concurrent runs (manual + the
    // scheduled chain) both read `prior` and both alert. CAS the memo to the new
    // band up front; only the winner emits. Roll the memo back if the emit fails
    // so a retry can still alert.
    const claim: PacingMemo = { key, tenantId, campaignId: row.campaignId, band: row.band, at: new Date().toISOString() };
    if (!(await memos.compareAndSwap(prior, claim))) continue; // another run claimed this escalation
    try {
      await getNotificationEmitter().emit({
        tenantId,
        type: 'campaign.pacing',
        priority: row.band === 'over' ? 'high' : 'normal',
        title: row.band === 'over' ? 'Campaign budget exceeded' : 'Campaign nearing its budget',
        message: `"${row.name}" has spent ${row.spend} of its ${row.budget} ${row.currency} plan (${row.spentPct}%).`,
        // Deep-link spine (Phase 3): land on the offending campaign, not the whole tab.
        // The hub tab id is the route path's last segment (tabIdOf) — the
        // campaign-intel route is /campaign-intelligence, so tab=campaign-intelligence
        // (NOT campaign-intel, which useUrlTab silently falls back on). A FE test
        // (campaign-intel routes) pins this id so a route rename can't re-break it.
        actionUrl: `/campaigns?tab=campaign-intelligence&org=${encodeURIComponent(orgId)}&campaign=${encodeURIComponent(row.campaignId)}`,
        metadata: { campaignId: row.campaignId, band: row.band, spentPct: row.spentPct },
      });
      alerted.push({ campaignId: row.campaignId, band: row.band });
    } catch (e) {
      log.warn('pacing alert emit failed', { campaignId: row.campaignId, error: e instanceof Error ? e.message : String(e) });
      // Roll back the claim so the next run re-alerts this escalation.
      await memos.compareAndSwap(claim, prior ?? { ...claim, band: 'ok' }).catch(() => undefined);
    }
  }
  return { report, alerted };
}

/** Test-only. */
export async function __clearPacingMemos(): Promise<void> {
  await memos.__clear();
}
