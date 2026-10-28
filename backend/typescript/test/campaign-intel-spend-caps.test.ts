/**
 * ADR 0952 D2 / P1 — hard spend caps with auto-pause.
 *
 * Exit criteria (phase P1): concurrent ticks pause once; a read failure past
 * `maxStaleMinutes` pauses; a breached cap refuses activate. Plus: the join is
 * by id only (a same-named campaign is never counted), a failed read is never
 * zero spend, a cap nothing can enforce refuses launch, a raise re-arms, and the
 * routes split who may lower (workspace:write) from who may raise (org owner).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createBrief, setKernel, updateBrief } from '../src/features/campaign-brief/briefService.js';
import { deleteCampaign, finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import type { AdsAdapter, DispatchLedgerRow, GetAccountMetricsArgs, GetAccountMetricsResult, SetDeliveryStatusArgs, SetDeliveryStatusResult } from '../src/host/adsAdapter.js';
import {
  createCap, enforceCaps, checkLaunchAgainstCaps, hasEnforceableCap, getCapState, setCapLimit, __clearSpendCaps, type SpendCap,
  getCap, eraseSpendCapCreators,
} from '../src/features/campaign-intel/spendCaps.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConnectorSettings } from '../src/features/campaign-connectors/syncService.js';
import { buildCampaignIntelSurface } from '../src/features/campaign-intel/surface.js';
import { nodes as intelNodes } from '../../../packs/feature.campaign-intel.nodes/index.mjs';
import { alertActions } from '../src/features/campaign-intel/alertActions.js';
import { getSetCookies } from './headerCookies.js';

// The dispatch ledger is written only by a live publishAd; tests seed it here.
const seeded = vi.hoisted(() => ({ ledger: new Map<string, DispatchLedgerRow[]>() }));
vi.mock('../src/host/adsAdapter.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/adsAdapter.js')>()),
  listTenantDispatchRecords: vi.fn(async (tenantId: string) => seeded.ledger.get(tenantId) ?? []),
}));

let BASE: string;
let server: http.Server;
let n = 0;
let storage: Storage;

const toggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status }, 'test');
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await toggle('campaign-intel', 'on');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(async () => { vi.restoreAllMocks(); await __clearSpendCaps(); seeded.ledger.clear(); await toggle('campaign-intel', 'on'); });

const KERNEL = {
  headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see',
  tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z',
};

async function makeCampaign(tenantId: string, orgId: string, name: string): Promise<{ id: string; briefId: string }> {
  const brief = await createBrief(tenantId, orgId, 'test', {
    name, objective: 'o', productName: 'p', personaIds: ['x'], messaging: { primaryValueProp: 'v' },
    channels: [{ type: 'ad_variants', enabled: true, config: {} }],
  });
  await setKernel(tenantId, brief.id, KERNEL);
  await updateBrief(tenantId, brief.id, { status: 'confirmed' }, 'test');
  const campaign = await finalizeFromBrief(tenantId, { ...brief, kernel: KERNEL, status: 'confirmed' as const }, 'test');
  return { id: campaign.id, briefId: brief.id };
}

function dispatch(tenantId: string, briefId: string, campaignId: string, adAccountId = 'act_1', platform: 'meta' | 'google' = 'meta'): void {
  const rows = seeded.ledger.get(tenantId) ?? [];
  rows.push({ platform, platformCampaignId: campaignId, platformAdSetId: `${campaignId}-s`, platformAdId: `${campaignId}-a`, briefId, adAccountId, createdAt: '2026-10-01T00:00:00.000Z' });
  seeded.ledger.set(tenantId, rows);
}

function canonicalDispatch(tenantId: string, orgId: string, campaignId: string, platformCampaignId: string, briefId?: string, adAccountId = 'act_1'): void {
  const rows = seeded.ledger.get(tenantId) ?? [];
  rows.push({ platform: 'meta', platformCampaignId, platformAdSetId: `${platformCampaignId}-s`, platformAdId: `${platformCampaignId}-a`,
    campaignId, orgId, ...(briefId !== undefined ? { briefId } : {}), adAccountId, createdAt: '2026-10-01T00:00:00.000Z' });
  seeded.ledger.set(tenantId, rows);
}

/** A fake adapter: a platform with per-campaign delivery state, counting WRITES. */
function fakeAdapter(metrics: (a: GetAccountMetricsArgs) => GetAccountMetricsResult | Promise<GetAccountMetricsResult>) {
  const delivery = new Map<string, 'active' | 'paused'>();
  let writes = 0;
  const adapter = {
    getAccountMetrics: vi.fn(async (a: GetAccountMetricsArgs) => metrics(a)),
    setDeliveryStatus: vi.fn(async (a: SetDeliveryStatusArgs): Promise<SetDeliveryStatusResult> => {
      if (delivery.get(a.campaignId) === a.status) return { outcome: 'unchanged', platform: a.platform, status: a.status };
      delivery.set(a.campaignId, a.status);
      writes += 1;
      return { outcome: 'updated', platform: a.platform, status: a.status };
    }),
  };
  // Only the two methods the watchdog calls are faked.
  return { adapter: adapter as unknown as AdsAdapter, spy: adapter, writes: () => writes };
}

const ok = (rows: Array<{ campaignId: string; campaignName?: string; spend: number; currency?: string }>): GetAccountMetricsResult => ({
  outcome: 'ok', platform: 'meta', pages: 1, truncated: false,
  rows: rows.map((r) => ({ date: '2026-10-10', campaignId: r.campaignId, campaignName: r.campaignName ?? r.campaignId, impressions: 1, clicks: 1, spend: r.spend, conversions: null, revenue: null, currency: r.currency ?? 'USD' })),
});

const T = 'user:caps-test';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const at = (min: number): Date => new Date(NOW.getTime() + min * 60_000);

async function campaignCap(org: string, limitMinor: number, extra: Record<string, unknown> = {}): Promise<{ cap: SpendCap; briefId: string }> {
  const c = await makeCampaign(T, org, `Camp ${n++}`);
  dispatch(T, c.briefId, '111');
  const cap = await createCap(T, org, { scope: { kind: 'campaign', campaignId: c.id }, limitMinor, currency: 'USD', ...extra }, 'user:creator', NOW);
  return { cap, briefId: c.briefId };
}

describe('ADR 0952 P1 — the spend-cap watchdog', () => {
  it.each([true, false])('canonical ownership counts and pauses a dispatch with unrelated brief=%s, then refuses launch', async (withOtherBrief) => {
    const org = `org-canonical-${n++}`;
    const a = await makeCampaign(T, org, `Owner ${n++}`);
    const b = await makeCampaign(T, org, `Unrelated ${n++}`);
    canonicalDispatch(T, org, a.id, '111', withOtherBrief ? b.briefId : undefined);
    const cap = await createCap(T, org, { scope: { kind: 'campaign', campaignId: a.id }, limitMinor: 5000, currency: 'USD' }, 'creator', NOW);
    const other = await createCap(T, org, { scope: { kind: 'campaign', campaignId: b.id }, limitMinor: 5000, currency: 'USD' }, 'creator', NOW);
    const { adapter, spy } = fakeAdapter(() => ok([{ campaignId: '111', spend: 60 }]));
    await enforceCaps(adapter, T, org, at(1));
    expect(await getCapState(cap, at(1))).toMatchObject({ status: 'breached', spentMinor: 6000 });
    expect(await getCapState(other, at(1))).toMatchObject({ status: 'ok', spentMinor: 0 });
    expect(spy.setDeliveryStatus).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ campaignId: '111', status: 'paused' }));
    expect(await checkLaunchAgainstCaps(T, { platform: 'meta', adAccountId: 'act_1', campaignId: '111' }, at(2))).toEqual({ verdict: 'cap_exceeded', capId: cap.capId });
  });

  it('an explicitly different campaign never falls back to the capped campaign brief', async () => {
    const org = `org-explicit-other-${n++}`;
    const a = await makeCampaign(T, org, `Capped ${n++}`);
    const b = await makeCampaign(T, org, `Other ${n++}`);
    canonicalDispatch(T, org, b.id, '222', a.briefId);
    const cap = await createCap(T, org, { scope: { kind: 'campaign', campaignId: a.id }, limitMinor: 5000, currency: 'USD' }, 'creator', NOW);
    const { adapter, spy } = fakeAdapter(() => ok([{ campaignId: '222', spend: 60 }]));
    await enforceCaps(adapter, T, org, at(1));
    expect(await getCapState(cap, at(1))).toMatchObject({ status: 'ok', spentMinor: 0 });
    expect(spy.getAccountMetrics).not.toHaveBeenCalled();
    expect(spy.setDeliveryStatus).not.toHaveBeenCalled();
    expect(await checkLaunchAgainstCaps(T, { platform: 'meta', adAccountId: 'act_1', campaignId: '222' }, at(2))).toEqual({ verdict: 'ok' });
  });

  it('explicit foreign org rows cannot enter either campaign or client coverage through a matching brief', async () => {
    const org = `org-foreign-stamp-${n++}`;
    const a = await makeCampaign(T, org, `Capped ${n++}`);
    canonicalDispatch(T, 'another-client', a.id, '222', a.briefId);
    const campaign = await createCap(T, org, { scope: { kind: 'campaign', campaignId: a.id }, limitMinor: 5000, currency: 'USD' }, 'creator', NOW);
    const client = await createCap(T, org, { scope: { kind: 'client' }, limitMinor: 5000, currency: 'USD' }, 'creator', NOW);
    const { adapter, spy } = fakeAdapter(() => ok([{ campaignId: '222', spend: 60 }]));
    await enforceCaps(adapter, T, org, at(1));
    expect(await getCapState(campaign, at(1))).toMatchObject({ spentMinor: 0 });
    expect(await getCapState(client, at(1))).toMatchObject({ spentMinor: null, readError: 'no_accounts' });
    expect(spy.getAccountMetrics).not.toHaveBeenCalled();
    expect(spy.setDeliveryStatus).not.toHaveBeenCalled();
  });

  it('legacy brief coverage accepts missing/matching orgs and rejects a foreign org for both cap kinds', async () => {
    const org = `org-legacy-ownership-${n++}`;
    const a = await makeCampaign(T, org, `Legacy ${n++}`);
    dispatch(T, a.briefId, '111', 'act_1');
    dispatch(T, a.briefId, '222', 'act_2');
    dispatch(T, a.briefId, '333', 'act_3');
    seeded.ledger.get(T)![1]!.orgId = org;
    seeded.ledger.get(T)![2]!.orgId = 'another-client';
    const campaign = await createCap(T, org, { scope: { kind: 'campaign', campaignId: a.id }, limitMinor: 10_000, currency: 'USD' }, 'creator', NOW);
    const client = await createCap(T, org, { scope: { kind: 'client' }, limitMinor: 10_000, currency: 'USD' }, 'creator', NOW);
    const { adapter, spy } = fakeAdapter((args) => ok([{ campaignId: args.adAccountId === 'act_1' ? '111' : args.adAccountId === 'act_2' ? '222' : '333', spend: 60 }]));
    await enforceCaps(adapter, T, org, at(1));
    for (const cap of [campaign, client]) expect(await getCapState(cap, at(1))).toMatchObject({ status: 'breached', spentMinor: 12_000 });
    expect(spy.getAccountMetrics.mock.calls.map(([args]) => args.adAccountId).sort()).toEqual(['act_1', 'act_1', 'act_2', 'act_2']);
    expect(spy.setDeliveryStatus.mock.calls.every(([args]) => args.campaignId === '111' || args.campaignId === '222')).toBe(true);
  });

  it('a client cap retains canonical delivery after its MarketingCampaign retires', async () => {
    const org = `org-retired-owner-${n++}`;
    const a = await makeCampaign(T, org, `Retired ${n++}`);
    canonicalDispatch(T, org, a.id, '111');
    const cap = await createCap(T, org, { scope: { kind: 'client' }, limitMinor: 5000, currency: 'USD' }, 'creator', NOW);
    expect(await deleteCampaign(T, a.id, 'test')).toBe(true);
    const { adapter, spy } = fakeAdapter(() => ok([{ campaignId: '111', spend: 60 }]));
    await enforceCaps(adapter, T, org, at(1));
    expect(await getCapState(cap, at(1))).toMatchObject({ status: 'breached', spentMinor: 6000 });
    expect(spy.setDeliveryStatus).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ campaignId: '111', status: 'paused' }));
    expect(await checkLaunchAgainstCaps(T, { platform: 'meta', adAccountId: 'act_1', campaignId: '111' }, at(2))).toEqual({ verdict: 'cap_exceeded', capId: cap.capId });
  });

  it('concurrent ticks pause ONCE; the join is by id only (a same-named campaign is never counted)', async () => {
    const org = `org-caps-${n++}`;
    const { cap } = await campaignCap(org, 10_000); // $100.00
    // Both ticks read before either claims: a barrier holds the reads.
    let arrived = 0; let release!: () => void;
    const barrier = new Promise<void>((r) => { release = r; });
    const { adapter, spy, writes } = fakeAdapter(async () => {
      arrived += 1; if (arrived === 2) release(); await barrier;
      // 111 is ours ($150); 999 shares a name but not an id ($500) and must not count.
      return ok([{ campaignId: '111', campaignName: 'Shared', spend: 150 }, { campaignId: '999', campaignName: 'Shared', spend: 500 }]);
    });
    const [a, b] = await Promise.all([enforceCaps(adapter, T, org, at(1)), enforceCaps(adapter, T, org, at(1))]);
    const results = [a[0]!, b[0]!];
    expect(results.filter((r) => r.transitioned)).toHaveLength(1);
    expect(results.filter((r) => r.raced)).toHaveLength(1);
    expect(writes()).toBe(1);
    expect(spy.setDeliveryStatus).toHaveBeenCalledTimes(1);
    expect(spy.setDeliveryStatus.mock.calls[0]?.[0]).toMatchObject({ platform: 'meta', adAccountId: 'act_1', campaignId: '111', status: 'paused', reason: { kind: 'cap', ref: cap.capId } });
    const state = await getCapState(cap, at(1));
    expect(state).toMatchObject({ status: 'breached', spentMinor: 15_000 });
    expect(state?.pausedTargets.map((p) => p.campaignId)).toEqual(['111']);
  });

  it('a failed read is never zero spend; past maxStaleMinutes the cap goes stale and PAUSES', async () => {
    const org = `org-caps-${n++}`;
    await campaignCap(org, 10_000, { maxStaleMinutes: 60 });
    const { adapter, writes } = fakeAdapter(() => ({ outcome: 'failed', error: 'http_500' }));

    const early = (await enforceCaps(adapter, T, org, at(30)))[0]!;
    expect(early).toMatchObject({ status: 'ok', spentMinor: null, readError: 'meta:http_500', transitioned: false });
    expect(writes()).toBe(0);

    const late = (await enforceCaps(adapter, T, org, at(61)))[0]!;
    expect(late).toMatchObject({ status: 'stale', spentMinor: null, transitioned: true, paused: 1 });
    expect(writes()).toBe(1);
    // A rate limit is an error too, never "spent nothing".
    const rl = fakeAdapter(() => ({ outcome: 'rate_limited', retryAfterS: 60 }));
    expect((await enforceCaps(rl.adapter, T, org, at(62)))[0]).toMatchObject({ status: 'stale', readError: 'rate_limited:meta', transitioned: false });
  });

  it('a breached cap refuses activate; an uncovered campaign is not affected', async () => {
    const org = `org-caps-${n++}`;
    const { cap } = await campaignCap(org, 5_000);
    const { adapter } = fakeAdapter(() => ok([{ campaignId: '111', spend: 60 }]));
    await enforceCaps(adapter, T, org, at(1));
    expect(await checkLaunchAgainstCaps(T, { platform: 'meta', adAccountId: 'act_1', campaignId: '111' }, at(2))).toEqual({ verdict: 'cap_exceeded', capId: cap.capId });
    // The account id compares without Meta's act_ prefix.
    expect((await checkLaunchAgainstCaps(T, { platform: 'meta', adAccountId: '1', campaignId: '111' }, at(2))).verdict).toBe('cap_exceeded');
    expect(await checkLaunchAgainstCaps(T, { platform: 'meta', adAccountId: 'act_1', campaignId: '222' }, at(2))).toEqual({ verdict: 'ok' });
  });

  it('ADR 0952 Q3 — hasEnforceableCap: no cap is FALSE (never "ok"); a covering cap is true; off watchdog or unverified reader is false', async () => {
    const org = `org-caps-${n++}`;
    const target = { platform: 'meta' as const, adAccountId: 'act_1', campaignId: '111' };
    expect(await hasEnforceableCap(T, target)).toBe(false); // no cap at all
    expect(await checkLaunchAgainstCaps(T, target, at(1))).toEqual({ verdict: 'ok' }); // …which the launch check reads as ok
    await campaignCap(org, 50_000);
    expect(await hasEnforceableCap(T, target)).toBe(true);
    expect(await hasEnforceableCap(T, { ...target, campaignId: '999' })).toBe(false); // not covered
    expect(await hasEnforceableCap(T, { platform: 'tiktok', adAccountId: 'act_1', campaignId: '111' })).toBe(false); // reader unverified
    await toggle('campaign-intel', 'off');
    expect(await hasEnforceableCap(T, target)).toBe(false);
  });

  it('ADR 0952 P2 — the launch check offers a native ceiling ONLY for a lifetime cap on one platform campaign, and says why not otherwise', async () => {
    const target = { platform: 'meta' as const, adAccountId: 'act_1', campaignId: '111' };
    expect(await checkLaunchAgainstCaps(T, target, at(1))).toEqual({ verdict: 'ok' }); // no cap: nothing to say
    const orgA = `org-caps-${n++}`;
    await campaignCap(orgA, 50_000); // calendar-month
    // ADR 0952 P1: only a CURRENT snapshot lets a launch through, so read first.
    const read = async (org: string): Promise<void> => { await enforceCaps(fakeAdapter(() => ok([{ campaignId: '111', spend: 1 }])).adapter, T, org, at(1)); };
    await read(orgA);
    expect(await checkLaunchAgainstCaps(T, target, at(1))).toEqual({ verdict: 'ok', noCeiling: 'period_not_lifetime' });
    await __clearSpendCaps(); seeded.ledger.clear();
    const orgB = `org-caps-${n++}`;
    const { cap } = await campaignCap(orgB, 70_000, { period: 'lifetime' });
    await read(orgB);
    expect(await checkLaunchAgainstCaps(T, target, at(1))).toEqual({ verdict: 'ok', ceiling: { limitMinor: 70_000, currency: 'USD', capId: cap.capId } });
    // A second platform campaign under the same campaign: the cap's spend is shared, so no single ceiling.
    const rows = seeded.ledger.get(T) ?? [];
    const briefId = rows[0]?.briefId ?? '';
    dispatch(T, briefId, '112');
    // The new dispatch changes the cap's coverage, which invalidates the snapshot: read again.
    expect((await checkLaunchAgainstCaps(T, target, at(1))).verdict).toBe('cap_unenforceable');
    await read(orgB);
    expect(await checkLaunchAgainstCaps(T, target, at(1))).toEqual({ verdict: 'ok', noCeiling: 'multi_target' });
  });

  it('a cap nothing can enforce refuses launch: watchdog toggle off ⇒ cap_unenforceable', async () => {
    const org = `org-caps-${n++}`;
    const { cap } = await campaignCap(org, 50_000);
    const target = { platform: 'meta' as const, adAccountId: 'act_1', campaignId: '111' };
    expect(await checkLaunchAgainstCaps(T, target, at(1))).toEqual({ verdict: 'cap_unenforceable', capId: cap.capId });
    await enforceCaps(fakeAdapter(() => ok([{ campaignId: '111', spend: 1 }])).adapter, T, org, at(1));
    // ADR 0952 P2: a calendar-month cap gets no native ceiling, and says why.
    expect(await checkLaunchAgainstCaps(T, target, at(1))).toEqual({ verdict: 'ok', noCeiling: 'period_not_lifetime' });
    await toggle('campaign-intel', 'off');
    expect(await checkLaunchAgainstCaps(T, target, at(1))).toEqual({ verdict: 'cap_unenforceable', capId: cap.capId });
  });

  it('a client cap sums every campaign in the org accounts and pauses known campaigns that have not spent yet', async () => {
    const org = `org-caps-${n++}`;
    const c = await makeCampaign(T, org, `Client ${n++}`);
    dispatch(T, c.briefId, '111');
    dispatch(T, c.briefId, '333'); // dispatched, no spend yet
    await createCap(T, org, { scope: { kind: 'client' }, limitMinor: 20_000, currency: 'USD' }, 'user:creator', NOW);
    // 111 (ours) + 777 (not dispatched by us, same account) = $250.
    const { adapter, spy } = fakeAdapter(() => ok([{ campaignId: '111', spend: 100 }, { campaignId: '777', spend: 150 }]));
    const [r] = await enforceCaps(adapter, T, org, at(1));
    expect(r).toMatchObject({ status: 'breached', spentMinor: 25_000, transitioned: true, paused: 3 });
    expect(spy.setDeliveryStatus.mock.calls.map((x) => x[0].campaignId).sort()).toEqual(['111', '333', '777']);
  });

  it('a mixed-currency read is unreadable, not converted; a raise re-arms a breach without resuming delivery', async () => {
    const org = `org-caps-${n++}`;
    const { cap } = await campaignCap(org, 5_000);
    const eur = fakeAdapter(() => ok([{ campaignId: '111', spend: 60, currency: 'EUR' }]));
    expect((await enforceCaps(eur.adapter, T, org, at(1)))[0]).toMatchObject({ status: 'ok', spentMinor: null, readError: 'currency_mismatch:EUR' });

    const usd = fakeAdapter(() => ok([{ campaignId: '111', spend: 60 }]));
    expect((await enforceCaps(usd.adapter, T, org, at(2)))[0]).toMatchObject({ status: 'breached', transitioned: true });
    const raised = await setCapLimit(cap, 10_000, cap.version, at(3));
    expect(await getCapState(raised, at(3))).toMatchObject({ status: 'ok', spentMinor: 6_000 });
    // Re-armed: the next breach pauses (and notifies) again.
    const more = fakeAdapter(() => ok([{ campaignId: '111', spend: 120 }]));
    expect((await enforceCaps(more.adapter, T, org, at(4)))[0]).toMatchObject({ status: 'breached', transitioned: true });
    await expect(setCapLimit(raised, 1, cap.version, at(5))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a good snapshot expires without another tick; unreadable and future-dated state cannot allow a launch', async () => {
    const org = `org-caps-${n++}`;
    const { cap } = await campaignCap(org, 10_000, { maxStaleMinutes: 60 });
    const target = { platform: 'meta' as const, adAccountId: 'act_1', campaignId: '111' };
    await enforceCaps(fakeAdapter(() => ok([{ campaignId: '111', spend: 1 }])).adapter, T, org, at(1));
    expect(await checkLaunchAgainstCaps(T, target, at(2))).toEqual({ verdict: 'ok', noCeiling: 'period_not_lifetime' });
    expect(await checkLaunchAgainstCaps(T, target, at(62))).toEqual({ verdict: 'cap_unenforceable', capId: cap.capId });
    const stateKey = `hostext:campaign-intel:cap-state:${T}::${cap.capId}::2026-10`;
    const get = storage.kvGet.bind(storage);
    const fault = vi.spyOn(storage, 'kvGet').mockImplementation(async (key) => {
      if (key === stateKey) throw new Error('state unavailable');
      return get(key);
    });
    expect(await checkLaunchAgainstCaps(T, target, at(2))).toEqual({ verdict: 'cap_unenforceable', capId: cap.capId });
    fault.mockRestore();
    const prior = JSON.parse((await storage.kvGet(stateKey))!);
    await storage.kvSet(stateKey, JSON.stringify({ ...prior, readAt: at(10).toISOString() }));
    expect(await checkLaunchAgainstCaps(T, target, at(2))).toEqual({ verdict: 'cap_unenforceable', capId: cap.capId });
  });

  it('a limit lowered during the state read refuses against the current cap, despite an old ok band', async () => {
    const org = `org-caps-${n++}`;
    const { cap } = await campaignCap(org, 10_000);
    await enforceCaps(fakeAdapter(() => ok([{ campaignId: '111', spend: 60 }])).adapter, T, org, at(1));
    const key = `hostext:campaign-intel:cap-state:${T}::${cap.capId}::2026-10`;
    const get = storage.kvGet.bind(storage);
    let lowered = false;
    vi.spyOn(storage, 'kvGet').mockImplementation(async (storageKey) => {
      const raw = await get(storageKey);
      if (storageKey === key && !lowered) { lowered = true; await setCapLimit(cap, 5_000, cap.version, at(2)); }
      return raw;
    });
    expect(await checkLaunchAgainstCaps(T, { platform: 'meta', adAccountId: 'act_1', campaignId: '111' }, at(2))).toEqual({ verdict: 'cap_exceeded', capId: cap.capId });
    expect(lowered).toBe(true);
  });

  it('a lowering while platform metrics are awaited affects this watchdog tick and pauses delivery', async () => {
    const org = `org-caps-${n++}`;
    const { cap } = await campaignCap(org, 9_000);
    const { adapter, writes } = fakeAdapter(async () => {
      await setCapLimit(cap, 5_000, cap.version, at(1));
      return ok([{ campaignId: '111', spend: 70 }]);
    });
    expect((await enforceCaps(adapter, T, org, at(1)))[0]).toMatchObject({ status: 'breached', spentMinor: 7_000, paused: 1 });
    expect(writes()).toBe(1);
    expect(await getCapState(cap, at(1))).toMatchObject({ status: 'breached', spentMinor: 7_000 });
  });

  it('changed account coverage invalidates a fresh snapshot; a matching client launch in an unknown account is unenforceable', async () => {
    const org = `org-caps-${n++}`;
    const cap = await createCap(T, org, { scope: { kind: 'client' }, limitMinor: 10_000, currency: 'USD' }, 'user:creator', NOW);
    await saveConnectorSettings(T, org, 'meta', { syncScope: 'account', adAccountIds: ['act_1'] }, 'test');
    const target = { platform: 'meta' as const, adAccountId: 'act_1', campaignId: '111', orgId: org };
    const { adapter } = fakeAdapter(() => ok([{ campaignId: '111', spend: 1 }]));
    await enforceCaps(adapter, T, org, at(1));
    expect(await checkLaunchAgainstCaps(T, target, at(2))).toEqual({ verdict: 'ok', noCeiling: 'client_scope' });
    expect(await checkLaunchAgainstCaps(T, { ...target, adAccountId: 'act_999' }, at(2))).toEqual({ verdict: 'cap_unenforceable', capId: cap.capId });
    await saveConnectorSettings(T, org, 'meta', { adAccountIds: ['act_1', 'act_2'] }, 'test');
    expect(await checkLaunchAgainstCaps(T, target, at(2))).toEqual({ verdict: 'cap_unenforceable', capId: cap.capId });
    await enforceCaps(adapter, T, org, at(3));
    expect(await checkLaunchAgainstCaps(T, target, at(4))).toEqual({ verdict: 'ok', noCeiling: 'client_scope' });
  });

  it('unreadable connector settings and incomplete ledger rows never prove that a client cap does not cover a target', async () => {
    const org = `org-caps-${n++}`;
    await createCap(T, org, { scope: { kind: 'client' }, limitMinor: 10_000, currency: 'USD' }, 'user:creator', NOW);
    const get = storage.kvGet.bind(storage);
    const fault = vi.spyOn(storage, 'kvGet').mockImplementation(async (key) => {
      if (key.startsWith(`hostext:campaign-connectors:connector-settings:${T}::${org}::`)) throw new Error('settings unavailable');
      return get(key);
    });
    await expect(checkLaunchAgainstCaps(T, { platform: 'meta', adAccountId: 'act_1', campaignId: '111', orgId: org }, at(1))).rejects.toThrow('settings unavailable');
    fault.mockRestore();
    const c = await makeCampaign(T, org, `Incomplete ${n++}`);
    seeded.ledger.set(T, [{ platform: 'meta', platformCampaignId: '111', platformAdSetId: 's', platformAdId: 'a', briefId: c.briefId, createdAt: NOW.toISOString() }]);
    await expect(checkLaunchAgainstCaps(T, { platform: 'meta', adAccountId: 'act_1', campaignId: '111' }, at(1))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a client cap refuses when another covered platform reader loses verification', async () => {
    const org = `org-caps-${n++}`;
    const cap = await createCap(T, org, { scope: { kind: 'client' }, limitMinor: 10_000, currency: 'USD' }, 'user:creator', NOW);
    await saveConnectorSettings(T, org, 'meta', { syncScope: 'account', adAccountIds: ['act_1'] }, 'test');
    await saveConnectorSettings(T, org, 'tiktok', { syncScope: 'account', adAccountIds: ['2'] }, 'test');
    const previous = process.env.OPENWOP_ADS_VERIFIED_READERS;
    try {
      process.env.OPENWOP_ADS_VERIFIED_READERS = 'tiktok';
      await enforceCaps(fakeAdapter(() => ok([{ campaignId: '111', spend: 1 }])).adapter, T, org, at(1));
      const target = { platform: 'meta' as const, adAccountId: 'act_1', campaignId: '111', orgId: org };
      expect(await checkLaunchAgainstCaps(T, target, at(2))).toEqual({ verdict: 'ok', noCeiling: 'client_scope' });
      delete process.env.OPENWOP_ADS_VERIFIED_READERS;
      expect(await checkLaunchAgainstCaps(T, target, at(2))).toEqual({ verdict: 'cap_unenforceable', capId: cap.capId });
    } finally {
      if (previous === undefined) delete process.env.OPENWOP_ADS_VERIFIED_READERS;
      else process.env.OPENWOP_ADS_VERIFIED_READERS = previous;
    }
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])('invalid spend %s never creates a good read or authorizes launch', async (spend) => {
    const org = `org-caps-${n++}`;
    const { cap } = await campaignCap(org, 10_000);
    const { adapter } = fakeAdapter(() => ok([{ campaignId: '111', spend }]));
    expect((await enforceCaps(adapter, T, org, at(1)))[0]).toMatchObject({ spentMinor: null, readError: 'invalid_spend' });
    expect(await getCapState(cap, at(1))).toMatchObject({ readAt: null });
    expect(await checkLaunchAgainstCaps(T, { platform: 'meta', adAccountId: 'act_1', campaignId: '111' }, at(2))).toEqual({ verdict: 'cap_unenforceable', capId: cap.capId });
  });

  it('creator erasure retries a concurrent cap edit without reverting the limit', async () => {
    const org = `org-caps-${n++}`;
    const { cap } = await campaignCap(org, 10_000);
    const key = `hostext:campaign-intel:spend-cap:${cap.key}`;
    const cas = storage.kvCompareAndSwap.bind(storage);
    let raced = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (storageKey, expected, next) => {
      if (storageKey === key && !raced) {
        raced = true;
        expect((await cas(storageKey, expected, JSON.stringify({ ...cap, limitMinor: 20_000, version: 2 }))).swapped).toBe(true);
      }
      return cas(storageKey, expected, next);
    });
    expect(await eraseSpendCapCreators(T, new Set(['user:creator']), 'user:erased')).toBe(1);
    expect(await getCap(T, org, cap.capId)).toMatchObject({ createdBy: 'user:erased', limitMinor: 20_000, version: 2 });
  });

  it('creator erasure reports exhausted contention instead of falsely succeeding', async () => {
    const org = `org-caps-${n++}`;
    const { cap } = await campaignCap(org, 10_000);
    const key = `hostext:campaign-intel:spend-cap:${cap.key}`;
    const cas = storage.kvCompareAndSwap.bind(storage);
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (storageKey, expected, next) => storageKey === key
      ? { swapped: false, actual: await storage.kvGet(storageKey) } : cas(storageKey, expected, next));
    await expect(eraseSpendCapCreators(T, new Set(['user:creator']), 'user:erased')).rejects.toMatchObject({ code: 'conflict' });
    expect(await getCap(T, org, cap.capId)).toMatchObject({ createdBy: 'user:creator', limitMinor: 10_000 });
  });
});

describe('ADR 0952 P1 — the enforce-caps node and its surface', () => {
  it('runs as a person: no acting user ⇒ refused; toggle off ⇒ an honest disabled no-op', async () => {
    const surface = buildCampaignIntelSurface({ tenantId: T });
    const enforce = surface.enforceCaps;
    if (!enforce) throw new Error('campaign-intel surface lacks enforceCaps');
    // No caps ⇒ nothing to enforce, no identity needed (the pacing chain stays green).
    expect(await enforce({ orgId: 'org-x' })).toEqual({ outcome: 'enforced', caps: [] });
    await createCap(T, 'org-x', { scope: { kind: 'client' }, limitMinor: 1000, currency: 'USD' }, 'user:creator', NOW);
    expect(await enforce({ orgId: 'org-x' })).toEqual({ outcome: 'no_acting_user' });
    const node = intelNodes['feature.campaign-intel.nodes.enforce-caps'];
    const ctx = { inputs: { orgId: 'org-x' }, features: { 'campaign-intel': surface } };
    expect(await node(ctx)).toMatchObject({ status: 'failed', error: { code: 'no_acting_user' } });
    await toggle('campaign-intel', 'off');
    expect(await node(ctx)).toEqual({ status: 'success', outputs: { outcome: 'disabled', caps: [] } });
    expect(await node({ inputs: {}, features: { 'campaign-intel': surface } })).toMatchObject({ status: 'failed', error: { code: 'validation_error' } });
  });
});

// ── Route RBAC ─────────────────────────────────────────────────────────────

interface Res<T> { status: number; body: T }
function client() {
  let cookie = '';
  async function call<T>(method: string, path: string, body?: unknown): Promise<Res<T>> {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
    return { status: res.status, body: out };
  }
  return call;
}
async function signup(c: ReturnType<typeof client>, tenantId: string): Promise<{ userId: string }> {
  const r = await c<{ user: { userId: string } }>('POST', '/host/openwop-app/test/login', { email: `caps-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

describe('ADR 0952 P1 — cap routes: lowering is workspace:write, raising/removing is the org owner', () => {
  it('editor creates and lowers; editor cannot raise or delete; owner can; viewer cannot create', async () => {
    const tenantId = `org:caps-${Date.now()}-${n++}`;
    const owner = client(); await signup(owner, tenantId);
    const editor = client(); const editorUser = await signup(editor, tenantId);
    const viewer = client(); const viewerUser = await signup(viewer, tenantId);
    const orgId = (await owner<{ orgId: string }>('POST', '/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner('POST', `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'E', subject: editorUser.userId, roles: ['editor'] });
    await owner('POST', `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'V', subject: viewerUser.userId, roles: ['viewer'] });
    const CAPS = '/host/openwop-app/campaign-intel/caps';

    expect((await viewer('POST', CAPS, { orgId, scope: { kind: 'client' }, limitMinor: 1000, currency: 'USD' })).status).toBe(403);
    const created = await editor<SpendCap>('POST', CAPS, { orgId, scope: { kind: 'client' }, limitMinor: 1000, currency: 'usd' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ currency: 'USD', period: 'calendar-month', maxStaleMinutes: 180, onBreach: 'pause' });
    const id = created.body.capId;

    const lowered = await editor<SpendCap>('PATCH', `${CAPS}/${id}`, { orgId, limitMinor: 800, version: 1 });
    expect(lowered.status).toBe(200);
    expect((await editor('PATCH', `${CAPS}/${id}`, { orgId, limitMinor: 5000, version: 2 })).status).toBe(403);
    expect((await editor('DELETE', `${CAPS}/${id}?orgId=${encodeURIComponent(orgId)}`)).status).toBe(403);
    expect((await owner('PATCH', `${CAPS}/${id}`, { orgId, limitMinor: 5000, version: 2 })).status).toBe(200);

    const listed = await viewer<{ caps: Array<SpendCap & { state: unknown }> }>('GET', `${CAPS}?orgId=${encodeURIComponent(orgId)}`);
    expect(listed.status).toBe(200);
    expect(listed.body.caps.map((c) => [c.capId, c.limitMinor, c.state])).toEqual([[id, 5000, null]]);

    expect((await owner('DELETE', `${CAPS}/${id}?orgId=${encodeURIComponent(orgId)}`)).status).toBe(204);
    expect((await viewer<{ caps: unknown[] }>('GET', `${CAPS}?orgId=${encodeURIComponent(orgId)}`)).body.caps).toEqual([]);
  });
});

describe('ADR 0952 D4 — alerts carry staged actions; the page confirms them', () => {
  it('alertActions: at most three deep links, each staging one action, never applying it', () => {
    const over = alertActions('pacing-over', { orgId: 'o 1', campaignId: 'c1' });
    expect(over.map((a) => a.action)).toEqual(['pause', 'reallocate']);
    expect(over[0]?.url).toBe('/campaigns?tab=campaign-intelligence&org=o+1&campaign=c1&stage=pause');
    expect(alertActions('cap-breached', { orgId: 'o', capId: 'k' })[0]?.url).toBe('/campaigns?tab=campaign-intelligence&org=o&cap=k&stage=raise-cap');
    expect(alertActions('pacing-warning', { orgId: 'o' }).map((a) => a.action)).toEqual(['reallocate']);
  });

  it('pause and propose routes: workspace:write only; pause covers every dispatched platform campaign of the campaign', async () => {
    const tenantId = `org:caps-d4-${Date.now()}-${n++}`;
    const owner = client(); await signup(owner, tenantId);
    const viewer = client(); const viewerUser = await signup(viewer, tenantId);
    const orgId = (await owner<{ orgId: string }>('POST', '/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner('POST', `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'V', subject: viewerUser.userId, roles: ['viewer'] });
    const c = await makeCampaign(tenantId, orgId, 'Paused one');
    dispatch(tenantId, c.briefId, '111');
    dispatch(tenantId, c.briefId, '222', '123', 'google');

    expect((await viewer('POST', '/host/openwop-app/campaign-intel/pause', { orgId, campaignId: c.id })).status).toBe(403);
    expect((await viewer('POST', '/host/openwop-app/campaign-intel/reallocations/propose', { orgId })).status).toBe(403);
    // No ad connection in tests: each target reports it, nothing pretends success.
    const paused = await owner<{ results: Array<{ platform: string; campaignId: string; outcome: string }> }>('POST', '/host/openwop-app/campaign-intel/pause', { orgId, campaignId: c.id });
    expect(paused.status).toBe(200);
    expect(paused.body.results.map((r) => [r.platform, r.campaignId]).sort()).toEqual([['google', '222'], ['meta', '111']]);
    expect(paused.body.results.every((r) => r.outcome !== 'updated')).toBe(true);
    expect((await owner('POST', '/host/openwop-app/campaign-intel/pause', { orgId, campaignId: 'nope' })).status).toBe(404);
    // Propose: nothing readable ⇒ no plan and no approval.
    const proposed = await owner<{ outcome: string }>('POST', '/host/openwop-app/campaign-intel/reallocations/propose', { orgId });
    expect(proposed.status).toBe(200);
    expect(proposed.body.outcome).toBe('no_change');
  });
});

