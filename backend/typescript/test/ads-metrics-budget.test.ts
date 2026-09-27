/**
 * ADR 0186 slice 4a/4b — provider-agnostic ad metrics + budget update.
 *
 * Node coverage (mock ctx.ads): core.openwop.connectors.ad-metrics reads via
 * ctx.ads.getMetrics and fails SAFE; core.openwop.connectors.ad-budget-update
 * RECOMMENDS by default (dryRun on, applied:false) and only applies via
 * ctx.ads.updateBudget on an explicit dryRun:false + real account (4b).
 * The adapter HTTP paths (Meta /insights + POST; Google googleAds:search +
 * campaignBudgets:mutate) mirror the publishAd broker pattern and are exercised by
 * the env-gated ads-adapter-{meta,google} suites.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { NodeContext } from '../src/executor/types.js';

function makeCtx(over: Partial<NodeContext>): NodeContext {
  const base: NodeContext = {
    runId: 'run_1', nodeId: 'n1', tenantId: 'demo', inputs: {}, configurable: {},
    attempt: 1, secrets: {}, emit: async () => ({ eventId: 'e1', sequence: 1 }),
  };
  return { ...base, ...over };
}
const outputsOf = (res: { status: string; outputs?: unknown }): Record<string, unknown> => {
  if (res.status !== 'success') throw new Error(`expected success, got ${res.status}`);
  return (res.outputs ?? {}) as Record<string, unknown>;
};

type AdsSurface = NonNullable<NodeContext['ads']>;
/** A ctx.ads double with the required publishAd stub. Pass a bare getMetrics fn (4a
 *  call sites) or an object of the surface(s) under test. */
function adsDouble(over: AdsSurface['getMetrics'] | Pick<Partial<AdsSurface>, 'getMetrics' | 'updateBudget'> = {}): AdsSurface {
  const o = typeof over === 'function' ? { getMetrics: over } : over;
  return { publishAd: async () => ({ outcome: 'no_connection' as const }), ...o };
}

describe('ADR 0186 slice 4a/4b — ad-metrics + ad-budget-update nodes', () => {
  beforeAll(() => ensureNodesRegistered());
  const metricsNode = () => getNodeRegistry().get('core.openwop.connectors.ad-metrics')!;
  const budgetNode = () => getNodeRegistry().get('core.openwop.connectors.ad-budget-update')!;

  it('ad-metrics: reads via ctx.ads.getMetrics and returns normalized metrics', async () => {
    let asked: unknown = null;
    const ctx = makeCtx({
      config: { platform: 'google', adAccountId: '111', campaignId: '222' },
      ads: adsDouble(async (a) => { asked = a; return { outcome: 'ok', platform: 'google', metrics: { impressions: 10, clicks: 2, spend: 3.5, ctr: 0.2, cpc: 1.75 } }; }),
    });
    const res = await metricsNode().execute(ctx);
    expect(asked).toEqual({ platform: 'google', adAccountId: '111', campaignId: '222' });
    expect(outputsOf(res)).toMatchObject({ connected: true, platform: 'google', metrics: { impressions: 10, spend: 3.5 } });
  });

  it('ad-metrics: degrades to connected:false with no ctx.ads or no account/campaign', async () => {
    expect(outputsOf(await metricsNode().execute(makeCtx({})))).toMatchObject({ connected: false, metrics: null });
    const ctx = makeCtx({ config: { platform: 'meta' }, ads: adsDouble(async () => ({ outcome: 'ok', platform: 'meta', metrics: { impressions: 0, clicks: 0, spend: 0, ctr: 0, cpc: 0 } })) });
    expect(outputsOf(await metricsNode().execute(ctx))).toMatchObject({ connected: false }); // missing adAccountId/campaignId → no read
  });

  it('ad-metrics: no_connection / unsupported degrade; failed → failure', async () => {
    const mk = (outcome: 'no_connection' | 'unsupported' | 'failed') => makeCtx({
      config: { platform: 'tiktok', adAccountId: '1', campaignId: '2' },
      ads: adsDouble(async () => (outcome === 'unsupported' ? { outcome, platform: 'tiktok' } : outcome === 'failed' ? { outcome, error: 'boom' } : { outcome })),
    });
    expect(outputsOf(await metricsNode().execute(mk('no_connection')))).toMatchObject({ connected: false });
    expect(outputsOf(await metricsNode().execute(mk('unsupported')))).toMatchObject({ connected: false, reason: 'platform_unsupported' });
    expect((await metricsNode().execute(mk('failed'))).status).toBe('failure');
  });

  it('ad-budget-update: recommends (applied:false) BY DEFAULT — dryRun on, no platform call', async () => {
    let called = false;
    const ctx = makeCtx({ config: { platform: 'google', adAccountId: 'acct', campaignId: '222', dailyBudgetMinor: 7500 }, ads: adsDouble({ updateBudget: async () => { called = true; return { outcome: 'updated', platform: 'google', dailyBudgetMinor: 7500, target: 't' }; } }) });
    expect(outputsOf(await budgetNode().execute(ctx))).toMatchObject({ applied: false, planned: { platform: 'google', campaignId: '222', dailyBudgetMinor: 7500 } });
    expect(called).toBe(false); // dryRun default ⇒ ctx.ads.updateBudget NOT called
    // No budget/campaign → planned:null, still applied:false.
    expect(outputsOf(await budgetNode().execute(makeCtx({ config: { platform: 'meta' } })))).toMatchObject({ applied: false, planned: null });
  });

  it('ad-budget-update: applies via ctx.ads.updateBudget only on explicit dryRun:false + account', async () => {
    let asked: unknown = null;
    const ctx = makeCtx({ config: { platform: 'google', adAccountId: 'acct', campaignId: '222', dailyBudgetMinor: 7500, dryRun: false }, ads: adsDouble({ updateBudget: async (a) => { asked = a; return { outcome: 'updated', platform: 'google', dailyBudgetMinor: 7500, target: 'customers/1/campaignBudgets/9' }; } }) });
    const res = await budgetNode().execute(ctx);
    expect(asked).toMatchObject({ platform: 'google', adAccountId: 'acct', campaignId: '222', dailyBudgetMinor: 7500, dryRun: false });
    expect(outputsOf(res)).toMatchObject({ applied: true, target: 'customers/1/campaignBudgets/9' });
  });

  it('ad-budget-update: dryRun:false without an account cannot apply — stays applied:false', async () => {
    let called = false;
    const ctx = makeCtx({ config: { platform: 'google', campaignId: '222', dailyBudgetMinor: 7500, dryRun: false }, ads: adsDouble({ updateBudget: async () => { called = true; return { outcome: 'updated', platform: 'google', dailyBudgetMinor: 7500, target: 't' }; } }) });
    expect(outputsOf(await budgetNode().execute(ctx))).toMatchObject({ applied: false });
    expect(called).toBe(false);
  });

  it('ad-budget-update: no_connection/unsupported degrade; failed → failure', async () => {
    const mk = (outcome: 'no_connection' | 'unsupported' | 'failed') => makeCtx({
      config: { platform: 'google', adAccountId: 'acct', campaignId: '222', dailyBudgetMinor: 7500, dryRun: false },
      ads: adsDouble({ updateBudget: async () => (outcome === 'unsupported' ? { outcome, platform: 'google' } : outcome === 'failed' ? { outcome, error: 'boom' } : { outcome }) }),
    });
    expect(outputsOf(await budgetNode().execute(mk('no_connection')))).toMatchObject({ applied: false });
    expect(outputsOf(await budgetNode().execute(mk('unsupported')))).toMatchObject({ applied: false, reason: 'platform_unsupported' });
    expect((await budgetNode().execute(mk('failed'))).status).toBe('failure');
  });
});
