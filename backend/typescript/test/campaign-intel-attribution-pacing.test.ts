/**
 * Attribution floor + budget pacing (ADR 0219/0220 / campaign gap plan C5+C7):
 *   - buildAttribution joins performance spend to analytics conversions on the
 *     C8 utm_campaign key (side-by-side, never summed), surfaces unattributed
 *     conversions, and carries lineage;
 *   - buildPacing bands spend vs the budget plan; runPacingCheck alerts once
 *     per band ESCALATION through the notification emitter (memo dedup).
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildAttribution } from '../src/features/campaign-intel/attribution.js';
import { buildPacing, runPacingCheck, __clearPacingMemos } from '../src/features/campaign-intel/pacing.js';
import { persistRecords, kpiSummary } from '../src/features/campaign-connectors/performanceService.js';
import { computeDerived } from '../src/features/campaign-connectors/csvImport.js';
import { recordEvent } from '../src/features/analytics/analyticsService.js';
import { createBrief, setKernel, updateBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import { createCampaign as createEmailCampaign } from '../src/features/email/emailService.js';
import { mintToken, recordClick, recordOpen } from '../src/features/email/engagementService.js';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const T = 'user:intel-test';
const ORG = 'org-intel';

const KERNEL = {
  headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see',
  tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z',
};

async function makeCampaign(name: string, utmCampaign: string, budgetMinor?: number, currency = 'USD'): Promise<string> {
  return makeCampaignIn(ORG, name, utmCampaign, budgetMinor, currency);
}

async function makeCampaignIn(orgId: string, name: string, utmCampaign: string, budgetMinor?: number, currency = 'USD'): Promise<string> {
  const brief = await createBrief(T, orgId, 'test', {
    name, objective: 'o', productName: 'p', personaIds: ['x'],
    messaging: { primaryValueProp: 'v' },
    channels: [{ type: 'ad_variants', enabled: true, config: {} }],
    utm: { campaign: utmCampaign },
    ...(budgetMinor !== undefined ? { budget: { totalMinor: budgetMinor, currency } } : {}),
  });
  await setKernel(T, brief.id, KERNEL);
  await updateBrief(T, brief.id, { status: 'confirmed' }, 'test');
  const confirmed = { ...brief, kernel: KERNEL, status: 'confirmed' as const, utm: { campaign: utmCampaign }, ...(budgetMinor !== undefined ? { budget: { totalMinor: budgetMinor, currency } } : {}) };
  const campaign = await finalizeFromBrief(T, confirmed, 'test');
  return campaign.id;
}

function row(campaignName: string, date: string, spend: number, conversions: number, revenue: number) {
  const base = { spend, impressions: 1000, clicks: 100, conversions, revenue };
  return { platform: 'meta' as const, campaignName, adSet: 'a', date, ...base, ...computeDerived(base) };
}

describe('ADR 0219 — attribution join', () => {
  it('joins spend to web conversions on the utm key, keeps platform vs web separate, surfaces unattributed', async () => {
    const campaignId = await makeCampaign('Summer', 'summer-launch');
    await persistRecords(T, ORG, [row('Summer', '2026-07-01', 100, 5, 400), row('Summer', '2026-07-02', 50, 2, 100)], 'csv', campaignId);
    // 3 conversions for our key, 1 foreign.
    for (let i = 0; i < 3; i++) {
      await recordEvent({ tenantId: T, orgId: ORG, raw: { type: 'conversion', path: '/thanks', sessionKey: `s${i}`, utm: { campaign: 'summer-launch' } } });
    }
    await recordEvent({ tenantId: T, orgId: ORG, raw: { type: 'conversion', path: '/thanks', sessionKey: 's9', utm: { campaign: 'someone-elses' } } });

    const report = await buildAttribution(T, ORG);
    const mine = report.rows.find((r) => r.campaignId === campaignId);
    expect(mine).toBeTruthy();
    expect(mine!.joinKey).toBe('summer-launch');
    expect(mine!.spend).toBe(150);
    expect(mine!.revenue).toBe(500);
    expect(mine!.platformConversions).toBe(7);
    expect(mine!.webConversions).toBe(3); // never summed with platform's 7
    expect(mine!.attributedCpa).toBe(50);
    expect(mine!.lineage.spendRows).toBe(2);
    expect(mine!.lineage.latestSpendDate).toBe('2026-07-02');
    expect(report.unattributedConversions).toBeGreaterThanOrEqual(1);
  });

  it('does NOT drop conversions behind a recency cap of high-volume pageviews (grade-code AUDIT-1)', async () => {
    const campaignId = await makeCampaign('Capped', 'capped-key');
    await persistRecords(T, ORG, [row('Capped', '2026-07-01', 200, 0, 0)], 'csv', campaignId);
    // The OLD conversion (recorded first) must survive even when thousands of
    // newer pageviews would push it past a 5000-recency window.
    await recordEvent({ tenantId: T, orgId: ORG, raw: { type: 'conversion', path: '/thanks', sessionKey: 'buyer', utm: { campaign: 'capped-key' } } });
    for (let i = 0; i < 5200; i++) {
      await recordEvent({ tenantId: T, orgId: ORG, raw: { type: 'pageview', path: '/p', sessionKey: `pv${i}` } });
    }
    const report = await buildAttribution(T, ORG);
    const mine = report.rows.find((r) => r.campaignId === campaignId)!;
    expect(mine.webConversions).toBe(1); // the old conversion is still attributed
  }, 30_000);

  it('attributes a shared utm key to ONE campaign, never double-counts, and surfaces the shared key (INTEL-1)', async () => {
    // Two campaigns deliberately share the same utm.campaign — the classic
    // UTM-hygiene mistake that used to count each conversion on BOTH rows.
    const a = await makeCampaign('SharedA', 'shared-key');
    const b = await makeCampaign('SharedB', 'shared-key');
    await recordEvent({ tenantId: T, orgId: ORG, raw: { type: 'conversion', path: '/thanks', sessionKey: 'sk1', utm: { campaign: 'shared-key' } } });
    await recordEvent({ tenantId: T, orgId: ORG, raw: { type: 'conversion', path: '/thanks', sessionKey: 'sk2', utm: { campaign: 'shared-key' } } });

    const report = await buildAttribution(T, ORG);
    const rowA = report.rows.find((r) => r.campaignId === a)!;
    const rowB = report.rows.find((r) => r.campaignId === b)!;
    // Exactly one campaign owns the 2 web conversions; the sum is 2, never 4.
    expect(rowA.webConversions + rowB.webConversions).toBe(2);
    // Deterministic: the first-by-id campaign is the sole owner.
    const primary = a < b ? rowA : rowB;
    const other = a < b ? rowB : rowA;
    expect(primary.webConversions).toBe(2);
    expect(other.webConversions).toBe(0);
    // The shared key is surfaced so the operator can fix their UTM hygiene.
    expect(report.sharedJoinKeys).toContain('shared-key');
  });

  it('threads the campaign budget currency onto attribution + pacing + a campaign-filtered KPI (CMPUX-15, no FX)', async () => {
    const id = await makeCampaign('EuroCamp', 'euro-key', 20000, 'EUR');
    await persistRecords(T, ORG, [row('EuroCamp', '2026-07-01', 120, 3, 400)], 'csv', id);

    // Attribution row carries its own campaign's currency.
    const report = await buildAttribution(T, ORG);
    const mine = report.rows.find((r) => r.campaignId === id)!;
    expect(mine.currency).toBe('EUR');

    // Pacing row carries the campaign budget currency.
    const pacing = await buildPacing(T, ORG);
    const paced = pacing.rows.find((r) => r.campaignId === id)!;
    expect(paced.currency).toBe('EUR');

    // A campaign-FILTERED KPI resolves that specific campaign's currency.
    const kpi = await kpiSummary(T, ORG, id);
    expect(kpi.currency).toBe('EUR');
  });

  it('org-wide KPI currency: unanimous → that currency; mixed → USD fallback (CMPUX-15)', async () => {
    // A FRESH org so the unanimity check is deterministic (not polluted by other tests).
    const O = 'org-cur-unanimous';
    await makeCampaignIn(O, 'UnaA', 'una-a', 5000, 'GBP');
    await makeCampaignIn(O, 'UnaB', 'una-b', 7000, 'GBP');
    expect((await kpiSummary(T, O)).currency).toBe('GBP'); // all GBP → GBP

    const M = 'org-cur-mixed';
    await makeCampaignIn(M, 'MixA', 'mix-a', 5000, 'GBP');
    await makeCampaignIn(M, 'MixB', 'mix-b', 7000, 'JPY');
    expect((await kpiSummary(T, M)).currency).toBe('USD'); // mixed → neutral default
  });

  /**
   * CC-G2 (docs/steward/UX_UPGRADE-campaign-connectors.md) — the KPI summary carries the same
   * ambiguity as the attribution report: "unanimously USD" and "mixed, here is a
   * default" both return `'USD'`. The performance console used that value to
   * label its KPI band and per-platform table, so a EUR+GBP workspace read its
   * spend and revenue in `$`.
   */
  it('CC-G2: the KPI summary says WHETHER its currency is a fact', async () => {
    const U = 'org-kpi-flag-unanimous';
    await makeCampaignIn(U, 'KUa', 'kpi-u-a', 5000, 'GBP');
    await makeCampaignIn(U, 'KUb', 'kpi-u-b', 7000, 'GBP');
    const unanimous = await kpiSummary(T, U);
    expect(unanimous.currency).toBe('GBP');
    expect(unanimous.currencyMixed).toBe(false);

    const M2 = 'org-kpi-flag-mixed';
    await makeCampaignIn(M2, 'KMa', 'kpi-m-a', 5000, 'EUR');
    await makeCampaignIn(M2, 'KMb', 'kpi-m-b', 7000, 'JPY');
    const mixed = await kpiSummary(T, M2);
    expect(mixed.currency).toBe('USD');
    expect(mixed.currencyMixed).toBe(true);

    const D = 'org-kpi-flag-usd';
    await makeCampaignIn(D, 'KDa', 'kpi-d-a', 5000, 'USD');
    const usd = await kpiSummary(T, D);
    // Same `currency` string as the mixed org above — only the flag separates
    // them, which is exactly why asserting on `currency` alone missed this.
    expect(usd.currency).toBe('USD');
    expect(usd.currencyMixed).toBe(false);
  });

  it('CC-G2: a CAMPAIGN-filtered summary is never ambiguous', async () => {
    const C = 'org-kpi-flag-campaign';
    const id = await makeCampaignIn(C, 'KCa', 'kpi-c-a', 5000, 'EUR');
    await makeCampaignIn(C, 'KCb', 'kpi-c-b', 7000, 'JPY');
    // The org is mixed, but ONE campaign has exactly one budget currency.
    const scoped = await kpiSummary(T, C, id);
    expect(scoped.currency).toBe('EUR');
    expect(scoped.currencyMixed).toBe(false);
  });
});

describe('ADR 0220 — pacing bands + escalation-only alerts', () => {
  it('bands spend vs plan and alerts once per escalation', async () => {
    await __clearPacingMemos();
    const campaignId = await makeCampaign('Paced', 'paced-key', 20000); // plan: 200.00
    await persistRecords(T, ORG, [row('Paced', '2026-07-01', 170, 0, 0)], 'csv', campaignId);

    const report1 = await buildPacing(T, ORG);
    const paced1 = report1.rows.find((r) => r.campaignId === campaignId)!;
    expect(paced1.band).toBe('warning'); // 85%
    expect(paced1.projectedMonthlySpend).toBeNull(); // <2 spend days — no fake projection

    const run1 = await runPacingCheck(T, ORG);
    expect(run1.alerted.some((a) => a.campaignId === campaignId && a.band === 'warning')).toBe(true);
    // Same band again → no re-alert.
    const run2 = await runPacingCheck(T, ORG);
    expect(run2.alerted.some((a) => a.campaignId === campaignId)).toBe(false);

    // Escalate to over (add spend past the plan) → exactly one new alert.
    await persistRecords(T, ORG, [row('Paced', '2026-07-02', 60, 0, 0)], 'csv', campaignId);
    const run3 = await runPacingCheck(T, ORG);
    expect(run3.alerted.some((a) => a.campaignId === campaignId && a.band === 'over')).toBe(true);
    const paced3 = run3.report.rows.find((r) => r.campaignId === campaignId)!;
    expect(paced3.band).toBe('over');
    expect(paced3.projectedMonthlySpend).not.toBeNull(); // 2 spend days now
    const run4 = await runPacingCheck(T, ORG);
    expect(run4.alerted.some((a) => a.campaignId === campaignId)).toBe(false);
  });

  it('campaigns without a plan are counted, not banded', async () => {
    await makeCampaign('Unplanned', 'unplanned-key');
    const report = await buildPacing(T, ORG);
    expect(report.unplanned).toBeGreaterThanOrEqual(1);
    expect(report.rows.some((r) => r.name === 'Unplanned')).toBe(false);
  });
});

describe('ADR 0246 — email→marketing-campaign provenance rollup', () => {
  const RORG = 'org-rollup';

  async function seedClick(campaignId: string, contactId: string): Promise<void> {
    const token = await mintToken({ tenantId: T, campaignId, contactId, kind: 'click', url: 'https://beans.example/shop' });
    await recordClick(token);
  }

  async function seedOpen(campaignId: string, contactId: string): Promise<void> {
    const token = await mintToken({ tenantId: T, campaignId, contactId, kind: 'open' });
    await recordOpen(token);
  }

  it('rolls owned-channel engagement up to the marketing campaign via sourceBriefId, dedupes unique clickers across its email campaigns, keeps the honest per-email column, and omits the rollup when the brief owns no email campaign', async () => {
    // A marketing campaign whose brief owns TWO channel-published email campaigns.
    const brief = await createBrief(T, RORG, 'test', {
      name: 'ProvRoll', objective: 'o', productName: 'p', personaIds: ['x'],
      messaging: { primaryValueProp: 'v' },
      channels: [{ type: 'ad_variants', enabled: true, config: {} }],
      utm: { campaign: 'prov-roll' },
    });
    await setKernel(T, brief.id, KERNEL);
    await updateBrief(T, brief.id, { status: 'confirmed' }, 'test');
    const mc = await finalizeFromBrief(T, { ...brief, kernel: KERNEL, status: 'confirmed' as const, utm: { campaign: 'prov-roll' } }, 'test');

    await createEmailCampaign({ tenantId: T, orgId: RORG, templateId: 'tmpl-a', createdBy: 'test', sourceBriefId: brief.id, campaignId: 'cmp-a' });
    await createEmailCampaign({ tenantId: T, orgId: RORG, templateId: 'tmpl-b', createdBy: 'test', sourceBriefId: brief.id, campaignId: 'cmp-b' });
    // ct-1 clicks BOTH campaigns (unique once across the brief); ct-2 clicks one.
    await seedClick('cmp-a', 'ct-1');
    await seedClick('cmp-b', 'ct-1');
    await seedClick('cmp-a', 'ct-2');
    // ADR 0248 opens: ct-1 opens cmp-a TWICE (re-open — opens count both, unique once);
    // ct-3 opens cmp-b. Total opens=3 across the brief; unique openers = {ct-1, ct-3}.
    await seedOpen('cmp-a', 'ct-1');
    await seedOpen('cmp-a', 'ct-1');
    await seedOpen('cmp-b', 'ct-3');

    // A second marketing campaign whose brief owns NO email campaign.
    const bareBrief = await createBrief(T, RORG, 'test', {
      name: 'BareMC', objective: 'o', productName: 'p', personaIds: ['x'],
      messaging: { primaryValueProp: 'v' },
      channels: [{ type: 'ad_variants', enabled: true, config: {} }],
      utm: { campaign: 'bare-key' },
    });
    await setKernel(T, bareBrief.id, KERNEL);
    await updateBrief(T, bareBrief.id, { status: 'confirmed' }, 'test');
    const bare = await finalizeFromBrief(T, { ...bareBrief, kernel: KERNEL, status: 'confirmed' as const, utm: { campaign: 'bare-key' } }, 'test');

    const report = await buildAttribution(T, RORG);

    const rolled = report.rows.find((r) => r.campaignId === mc.id);
    expect(rolled?.emailEngagement).toBeTruthy();
    expect(rolled!.emailEngagement!.briefId).toBe(brief.id);
    expect(rolled!.emailEngagement!.emailCampaigns).toBe(2);
    expect(rolled!.emailEngagement!.clicks).toBe(3);
    expect(rolled!.emailEngagement!.uniqueClicks).toBe(2); // ct-1 deduped across cmp-a + cmp-b
    // ADR 0248: opens roll up too — re-opens count, unique openers dedup across the brief.
    expect(rolled!.emailEngagement!.opens).toBe(3);
    expect(rolled!.emailEngagement!.uniqueOpens).toBe(2); // {ct-1, ct-3}

    // The honest per-EMAIL-campaign column is untouched — the rollup is additive.
    const perEmail = report.email.filter((e) => e.emailCampaignId === 'cmp-a' || e.emailCampaignId === 'cmp-b');
    expect(perEmail.length).toBe(2);
    expect(perEmail.reduce((s, e) => s + e.clicks, 0)).toBe(3);
    expect(perEmail.reduce((s, e) => s + e.opens, 0)).toBe(3); // ADR 0248 per-email opens
    // cmp-a: ct-1 opened twice → opens 2, uniqueOpens 1.
    const cmpA = perEmail.find((e) => e.emailCampaignId === 'cmp-a');
    expect(cmpA?.opens).toBe(2);
    expect(cmpA?.uniqueOpens).toBe(1);

    // No provenance ⇒ no rollup — never a synthesised row.
    const bareRow = report.rows.find((r) => r.campaignId === bare.id);
    expect(bareRow).toBeTruthy();
    expect(bareRow!.emailEngagement).toBeUndefined();
  });
});

/**
 * CI-G1 (docs/steward/UX_UPGRADE-campaign-intel.md) — a MIXED-currency org must be
 * distinguishable from a genuinely-USD one.
 *
 * `AttributionReport.currency` collapses "all campaigns agree on USD" and "the
 * campaigns disagree, here is a neutral default" into the same string. The
 * console used that value to label its org-wide budget/forecast/planner figures,
 * so an EUR+GBP workspace saw `$` — a currency none of its campaigns use — and
 * since there is no FX those sums are not in any single currency at all.
 */
describe('CI-G1: attribution reports WHETHER the org-wide currency is a fact', () => {
  it('unanimous → currency is that currency, and NOT flagged mixed', async () => {
    const O = 'org-cur-flag-unanimous';
    await makeCampaignIn(O, 'FlagA', 'flag-a', 5000, 'GBP');
    await makeCampaignIn(O, 'FlagB', 'flag-b', 7000, 'GBP');
    const report = await buildAttribution(T, O);
    expect(report.currency).toBe('GBP');
    expect(report.currencyMixed).toBe(false);
  });

  it('mixed → flagged, so the console can stop labelling the figures at all', async () => {
    const O = 'org-cur-flag-mixed';
    await makeCampaignIn(O, 'MixA', 'mix-a', 5000, 'EUR');
    await makeCampaignIn(O, 'MixB', 'mix-b', 7000, 'GBP');
    const report = await buildAttribution(T, O);
    // The legacy field keeps its neutral default for back-compat …
    expect(report.currency).toBe('USD');
    // … and the flag is what makes that default legible as a default.
    expect(report.currencyMixed).toBe(true);
  });

  it('a USD-only org is NOT flagged — the flag must not fire on the default itself', async () => {
    const O = 'org-cur-flag-usd';
    await makeCampaignIn(O, 'UsdA', 'usd-a', 5000, 'USD');
    await makeCampaignIn(O, 'UsdB', 'usd-b', 7000, 'USD');
    const report = await buildAttribution(T, O);
    expect(report.currency).toBe('USD');
    // Same string as the mixed case above; only the flag tells them apart.
    expect(report.currencyMixed).toBe(false);
  });
});

describe('R2 CI-SP-5/7 — exponent-aware pacing + memo de-escalation', () => {
  it('a JPY budget reads in yen, not yen/100 (the post-#3094 seam)', async () => {
    // The brief writes ISO minor units per the currency's own exponent: a JPY
    // plan of ¥500,000 stores totalMinor=500000. The old blind /100 read it as
    // ¥5,000 and banded the campaign "over" at 8000%.
    const campaignId = await makeCampaign('Tokyo push', 'tokyo-key', 500000, 'JPY');
    await persistRecords(T, ORG, [row('Tokyo push', '2026-07-01', 400000, 0, 0)], 'csv', campaignId);
    const report = await buildPacing(T, ORG);
    const r = report.rows.find((x) => x.campaignId === campaignId)!;
    expect(r.budget).toBe(500000); // whole yen — NOT 5000
    expect(r.spentPct).toBe(80);
    expect(r.band).toBe('warning');
  });

  it('recover → re-overspend ALERTS AGAIN (the memo is written down, not up-only)', async () => {
    await __clearPacingMemos();
    // Build the campaign by hand so the briefId is in reach for a budget raise.
    const brief = await createBrief(T, ORG, 'test', {
      name: 'Recoverer', objective: 'o', productName: 'p', personaIds: ['x'],
      messaging: { primaryValueProp: 'v' },
      channels: [{ type: 'ad_variants', enabled: true, config: {} }],
      utm: { campaign: 'recover-key' },
      budget: { totalMinor: 20000, currency: 'USD' }, // plan: 200.00
    });
    const withKernel = (await setKernel(T, brief.id, KERNEL))!;
    const campaign = await finalizeFromBrief(T, withKernel, 'test');
    await persistRecords(T, ORG, [row('Recoverer', '2026-07-01', 250, 0, 0)], 'csv', campaign.id);

    // Episode 1: over → alerts.
    const run1 = await runPacingCheck(T, ORG);
    expect(run1.alerted.some((a) => a.campaignId === campaign.id && a.band === 'over')).toBe(true);

    // The operator RAISES the budget; the band returns to ok and the memo must
    // follow it down.
    await updateBrief(T, brief.id, { budget: { totalMinor: 100000, currency: 'USD' } }, 'test'); // plan: 1000.00
    const raised = (await setKernel(T, brief.id, KERNEL))!;
    await finalizeFromBrief(T, raised, 'test'); // upsert copies the new budget
    const run2 = await runPacingCheck(T, ORG);
    expect(run2.report.rows.find((r) => r.campaignId === campaign.id)!.band).toBe('ok');
    expect(run2.alerted.some((a) => a.campaignId === campaign.id)).toBe(false);

    // Episode 2: spend crosses the NEW budget. The old up-only memo still held
    // "over", so this second real overspend was silent FOREVER.
    await persistRecords(T, ORG, [row('Recoverer', '2026-07-02', 800, 0, 0)], 'csv', campaign.id);
    const run3 = await runPacingCheck(T, ORG);
    expect(run3.alerted.some((a) => a.campaignId === campaign.id && a.band === 'over')).toBe(true);
  });
});
