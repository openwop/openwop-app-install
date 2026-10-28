/**
 * ADR 0952 D3 / P3 — cross-channel reallocation as ONE approved plan.
 *
 * Exit criteria (phase P3): a partial failure leaves under-spend (decreases
 * first; a failed decrease skips every increase); a fork does not re-apply.
 * Plus: live "from" budgets (an unreadable one is dropped, never guessed); a
 * cap-blocked increase is dropped; one approval per plan, idempotent per run;
 * a stale budget is never overwritten; an expired plan never applies; a
 * concurrent apply is claimed once; the one-click route stamps back.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getApproval, resolveApproval } from '../src/host/approvalService.js';
import { createBrief, setKernel, updateBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import type { AdsAdapter, DispatchLedgerRow, GetCampaignBudgetArgs, GetCampaignBudgetResult, UpdateBudgetArgs, UpdateBudgetResult } from '../src/host/adsAdapter.js';
import {
  proposeReallocation, applyReallocation, listPlans, recordRouteApply, getPlan, __clearReallocationPlans, PLAN_TTL_MS,
} from '../src/features/campaign-intel/reallocation.js';
import { createCap, enforceCaps, __clearSpendCaps } from '../src/features/campaign-intel/spendCaps.js';

const seeded = vi.hoisted(() => ({ ledger: new Map<string, DispatchLedgerRow[]>() }));
vi.mock('../src/host/adsAdapter.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/adsAdapter.js')>()),
  listTenantDispatchRecords: vi.fn(async (tenantId: string) => seeded.ledger.get(tenantId) ?? []),
}));

let server: http.Server;
let n = 0;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  const d = getToggleDefault('campaign-intel');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(async () => { await __clearReallocationPlans(); await __clearSpendCaps(); seeded.ledger.clear(); });

const T = 'user:realloc-test';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const KERNEL = { headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see', tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z' };

async function orgWithCampaigns(targets: Array<{ platform: 'meta' | 'google'; campaignId: string }>): Promise<string> {
  const org = `org-realloc-${n++}`;
  const brief = await createBrief(T, org, 'test', { name: `C${n}`, objective: 'o', productName: 'p', personaIds: ['x'], messaging: { primaryValueProp: 'v' }, channels: [{ type: 'ad_variants', enabled: true, config: {} }] });
  await setKernel(T, brief.id, KERNEL);
  await updateBrief(T, brief.id, { status: 'confirmed' }, 'test');
  await finalizeFromBrief(T, { ...brief, kernel: KERNEL, status: 'confirmed' as const }, 'test');
  const rows = seeded.ledger.get(T) ?? [];
  for (const t of targets) rows.push({ platform: t.platform, platformCampaignId: t.campaignId, platformAdSetId: 's', platformAdId: 'a', briefId: brief.id, adAccountId: t.platform === 'meta' ? 'act_1' : '1234567890', createdAt: '2026-10-01T00:00:00.000Z' });
  seeded.ledger.set(T, rows);
  return org;
}

/** A fake platform: per-campaign daily budgets, counting budget WRITES. */
function platform(budgets: Record<string, number | 'unreadable'>, failWrites: string[] = []) {
  const writes: UpdateBudgetArgs[] = [];
  const spy = {
    getCampaignBudget: vi.fn(async (a: GetCampaignBudgetArgs): Promise<GetCampaignBudgetResult> => {
      const b = budgets[a.campaignId];
      return b === undefined || b === 'unreadable' ? { outcome: 'failed', error: 'http_500' } : { outcome: 'ok', platform: a.platform, dailyBudgetMinor: b };
    }),
    updateBudget: vi.fn(async (a: UpdateBudgetArgs): Promise<UpdateBudgetResult> => {
      if (failWrites.includes(a.campaignId)) return { outcome: 'failed', error: 'http_400' };
      writes.push(a);
      budgets[a.campaignId] = a.dailyBudgetMinor;
      return { outcome: 'updated', platform: a.platform, dailyBudgetMinor: a.dailyBudgetMinor, target: a.campaignId };
    }),
  };
  // Only the two methods reallocation calls are faked.
  return { adapter: spy as unknown as AdsAdapter, spy, writes, budgets };
}

/** Meta spend -20% (decrease), Google +50% (increase). */
const REC = { reallocations: [
  { platform: 'meta', currentSpend: 1000, suggestedSpend: 800, changeAmount: -200, changePercent: -20, roas: 1, reason: '' },
  { platform: 'google', currentSpend: 400, suggestedSpend: 600, changeAmount: 200, changePercent: 50, roas: 4, reason: '' },
] };

async function approve(planApprovalId: string | undefined): Promise<void> {
  if (!planApprovalId) throw new Error('plan has no approval');
  await resolveApproval(planApprovalId, { status: 'approved' });
}

describe('ADR 0952 P3 — propose', () => {
  it('builds per-campaign ops from live budgets, decreases first, one approval, idempotent per run; an unreadable budget is dropped', async () => {
    const org = await orgWithCampaigns([{ platform: 'google', campaignId: '21' }, { platform: 'meta', campaignId: '11' }, { platform: 'meta', campaignId: '12' }]);
    const p = platform({ '11': 5000, '12': 'unreadable', '21': 2000 });
    const out = await proposeReallocation(p.adapter, T, org, { recommendation: REC, runId: 'run-1', actor: 'user:a' }, NOW);
    expect(out.outcome).toBe('proposed');
    if (out.outcome !== 'proposed') return;
    expect(out.plan.ops).toEqual([
      { platform: 'meta', adAccountId: 'act_1', campaignId: '11', fromDailyMinor: 5000, toDailyMinor: 4000 },
      { platform: 'google', adAccountId: '1234567890', campaignId: '21', fromDailyMinor: 2000, toDailyMinor: 3000 },
    ]);
    expect(out.plan.dropped).toEqual([{ platform: 'meta', adAccountId: 'act_1', campaignId: '12', reason: 'budget_unreadable:http_500' }]);
    const approval = await getApproval(out.plan.approvalId ?? '');
    expect(approval).toMatchObject({ kind: 'campaign-spend', spendKind: 'reallocation', status: 'pending', dailyBudgetMinor: 1000 });
    expect(approval?.proposal).toMatch(/decreases apply first/);
    // A retry of the same run returns the same plan and the same approval.
    const again = await proposeReallocation(p.adapter, T, org, { recommendation: REC, runId: 'run-1' }, NOW);
    expect(again.outcome === 'proposed' && again.plan.planId).toBe(out.plan.planId);
    expect(again.outcome === 'proposed' && again.plan.approvalId).toBe(out.plan.approvalId);
    expect(await listPlans(T, org)).toHaveLength(1);
    expect(p.writes).toHaveLength(0);
  });

  it('an increase a spend cap would not allow is dropped with the cap named; nothing to change ⇒ no plan, no approval', async () => {
    const org = await orgWithCampaigns([{ platform: 'google', campaignId: '21' }]);
    const cap = await createCap(T, org, { scope: { kind: 'client' }, limitMinor: 10_000, currency: 'USD' }, 'user:a', NOW);
    // Never read ⇒ no CURRENT snapshot (the ADR 0952 P1 bar a launch meets) ⇒ refused.
    const p = platform({ '21': 2000 });
    const out = await proposeReallocation(p.adapter, T, org, { recommendation: REC, runId: 'run-2' }, NOW);
    expect(out).toEqual({ outcome: 'no_change', dropped: [{ platform: 'google', adAccountId: '1234567890', campaignId: '21', toDailyMinor: 3000, reason: `cap_stale:${cap.capId}` }] });
    // Read once (spent 50.00); 3000/day × 17 days left would blow 10,000.
    const reader = { getAccountMetrics: async () => ({ outcome: 'ok', platform: 'google', pages: 1, truncated: false, rows: [{ date: '2026-10-10', campaignId: '21', campaignName: 'x', impressions: 1, clicks: 1, spend: 50, conversions: null, revenue: null, currency: 'USD' }] }), setDeliveryStatus: async () => ({ outcome: 'unchanged', platform: 'google', status: 'paused' }) };
    await enforceCaps(reader as unknown as AdsAdapter, T, org, NOW);
    const blocked = await proposeReallocation(p.adapter, T, org, { recommendation: REC, runId: 'run-3' }, NOW);
    expect(blocked.outcome === 'no_change' && blocked.dropped[0]?.reason).toBe(`cap_headroom:${cap.capId}`);
  });
});

describe('ADR 0952 P3 — apply', () => {
  async function proposed(budgets: Record<string, number | 'unreadable'>, failWrites: string[] = []) {
    const org = await orgWithCampaigns([{ platform: 'meta', campaignId: '11' }, { platform: 'google', campaignId: '21' }]);
    const p = platform(budgets, failWrites);
    const out = await proposeReallocation(p.adapter, T, org, { recommendation: REC, runId: `run-${n++}` }, NOW);
    if (out.outcome !== 'proposed') throw new Error('expected a plan');
    return { org, p, plan: out.plan };
  }

  it('waits for the approval, applies once approved (decrease first), and a second apply (a fork) re-applies nothing', async () => {
    const { org, p, plan } = await proposed({ '11': 5000, '21': 2000 });
    const pending = await applyReallocation(p.adapter, T, org, plan.planId, NOW);
    expect(pending).toMatchObject({ outcome: 'requires_approval', approvalId: plan.approvalId });
    expect(p.writes).toHaveLength(0);
    await approve(plan.approvalId);
    const done = await applyReallocation(p.adapter, T, org, plan.planId, NOW);
    expect(done.outcome).toBe('applied');
    expect(p.writes.map((w) => [w.campaignId, w.dailyBudgetMinor])).toEqual([['11', 4000], ['21', 3000]]);
    const again = await applyReallocation(p.adapter, T, org, plan.planId, NOW);
    expect(again.outcome).toBe('applied');
    expect(p.writes).toHaveLength(2);
  });

  it('a failed DECREASE skips every increase: the plan ends partial and under-spends, never over-spends', async () => {
    const { org, p, plan } = await proposed({ '11': 5000, '21': 2000 }, ['11']);
    await approve(plan.approvalId);
    const out = await applyReallocation(p.adapter, T, org, plan.planId, NOW);
    expect(out.outcome).toBe('partial');
    expect(p.writes).toHaveLength(0);
    expect(p.budgets['21']).toBe(2000);
    const stored = await getPlan(T, org, plan.planId);
    expect(stored?.results.map((r) => [r.opIx, r.outcome, r.error])).toEqual([[0, 'failed', 'http_400'], [1, 'skipped', 'skipped_after_decrease_failure']]);
  });

  it('a budget changed since the proposal is never overwritten (stale_budget)', async () => {
    const { org, p, plan } = await proposed({ '11': 5000, '21': 2000 });
    await approve(plan.approvalId);
    p.budgets['11'] = 4500; // someone moved it on the platform
    const out = await applyReallocation(p.adapter, T, org, plan.planId, NOW);
    expect(out.outcome).toBe('partial');
    expect(p.writes).toHaveLength(0);
    expect(out.outcome !== 'not_found' && 'plan' in out && out.plan.results[0]?.error).toBe('stale_budget');
  });

  it('an expired plan never applies, even approved; a rejected plan is rejected', async () => {
    const { org, p, plan } = await proposed({ '11': 5000, '21': 2000 });
    await approve(plan.approvalId);
    expect((await applyReallocation(p.adapter, T, org, plan.planId, new Date(NOW.getTime() + PLAN_TTL_MS + 1))).outcome).toBe('expired');
    expect(p.writes).toHaveLength(0);
    const r = await proposed({ '11': 5000, '21': 2000 });
    await resolveApproval(r.plan.approvalId ?? '', { status: 'rejected' });
    expect((await applyReallocation(r.p.adapter, T, r.org, r.plan.planId, NOW)).outcome).toBe('rejected');
  });

  it('a new proposal after a FINISHED plan with the same hash gets a new plan and approval, never the old record back', async () => {
    const org = await orgWithCampaigns([{ platform: 'meta', campaignId: '11' }, { platform: 'google', campaignId: '21' }]);
    const p = platform({ '11': 5000, '21': 2000 });
    const first = await proposeReallocation(p.adapter, T, org, { recommendation: REC, runId: 'chat' }, NOW);
    if (first.outcome !== 'proposed') throw new Error('expected a plan');
    await resolveApproval(first.plan.approvalId ?? '', { status: 'rejected' });
    expect((await applyReallocation(p.adapter, T, org, first.plan.planId, NOW)).outcome).toBe('rejected');
    const again = await proposeReallocation(p.adapter, T, org, { recommendation: REC, runId: 'chat' }, NOW);
    if (again.outcome !== 'proposed') throw new Error('expected a plan');
    expect(again.plan.planId).not.toBe(first.plan.planId);
    expect(again.plan.status).toBe('proposed');
    expect(again.plan.approvalId).not.toBe(first.plan.approvalId);
  });

  it('two concurrent applies: one claims, the other is in_progress; every op is written once', async () => {
    const { org, p, plan } = await proposed({ '11': 5000, '21': 2000 });
    await approve(plan.approvalId);
    const [a, b] = await Promise.all([applyReallocation(p.adapter, T, org, plan.planId, NOW), applyReallocation(p.adapter, T, org, plan.planId, NOW)]);
    expect([a.outcome, b.outcome].sort()).toEqual(['applied', 'in_progress']);
    expect(p.writes).toHaveLength(2);
  });
});

describe('ADR 0952 P3 — the one-click route stamps back (finding P3)', () => {
  it('records updated / requires_approval / failed outcomes; a preview records nothing', async () => {
    const org = `org-route-${n++}`;
    const op = { platform: 'meta' as const, adAccountId: 'act_1', campaignId: '11', dailyBudgetMinor: 5000 };
    await recordRouteApply(T, org, 'user:a', op, { outcome: 'updated', platform: 'meta', dailyBudgetMinor: 5000, target: '11' }, NOW);
    await recordRouteApply(T, org, 'user:a', op, { outcome: 'requires_approval', approvalId: 'appr:x' }, NOW);
    await recordRouteApply(T, org, 'user:a', op, { outcome: 'failed', error: 'policy_disabled' }, NOW);
    await recordRouteApply(T, org, 'user:a', op, { outcome: 'preview', platform: 'meta', dailyBudgetMinor: 5000, target: '11' }, NOW);
    const plans = await listPlans(T, org);
    // The store is capped per org: old terminal records are trimmed, never open ones.
    const capped = `org-cap-${n++}`;
    for (let i = 0; i < 203; i++) await recordRouteApply(T, capped, 'user:a', op, { outcome: 'updated', platform: 'meta', dailyBudgetMinor: 5000, target: '11' }, new Date(NOW.getTime() + i * 1000));
    expect(await listPlans(T, capped)).toHaveLength(200);
    expect(plans.map((p) => [p.source.kind, p.status, p.approvalId ?? null, p.results[0]?.error ?? null]).sort()).toEqual([
      ['route', 'applied', null, null],
      ['route', 'partial', null, 'policy_disabled'],
      ['route', 'proposed', 'appr:x', null],
    ]);
  });
});

describe('ADR 0952 P3 × P1 — apply re-checks caps on a CURRENT snapshot', () => {
  it('an increase whose cap snapshot went stale after approval is refused at apply (no write); the decrease still applies', async () => {
    {
      const org = await orgWithCampaigns([{ platform: 'meta', campaignId: '11' }, { platform: 'google', campaignId: '21' }]);
      const cap = await createCap(T, org, { scope: { kind: 'client' }, limitMinor: 10_000_000, currency: 'USD', maxStaleMinutes: 60 }, 'user:a', NOW);
      const reader = { getAccountMetrics: async (a: { platform: 'meta' | 'google' }) => ({ outcome: 'ok', platform: a.platform, pages: 1, truncated: false, rows: [] }), setDeliveryStatus: async () => ({ outcome: 'unchanged', platform: 'google', status: 'paused' }) };
      await enforceCaps(reader as unknown as AdsAdapter, T, org, NOW);
      const p = platform({ '11': 5000, '21': 2000 });
      const out = await proposeReallocation(p.adapter, T, org, { recommendation: REC, runId: 'run-stale-apply' }, NOW);
      if (out.outcome !== 'proposed') throw new Error(`expected a plan, got ${out.outcome}`);
      expect(out.plan.ops.map((o) => o.campaignId)).toEqual(['11', '21']);
      await approve(out.plan.approvalId);
      // Two hours later, with no watchdog read since: the snapshot is stale.
      const later = new Date(NOW.getTime() + 2 * 3_600_000);
      const applied = await applyReallocation(p.adapter, T, org, out.plan.planId, later);
      expect(applied.outcome).toBe('partial');
      expect(p.writes.map((w) => w.campaignId)).toEqual(['11']);
      const r21 = applied.outcome === 'partial' ? applied.plan.results.find((r) => r.opIx === 1) : undefined;
      expect(r21).toMatchObject({ outcome: 'failed', error: `cap_stale:${cap.capId}` });
    }
  });
});
