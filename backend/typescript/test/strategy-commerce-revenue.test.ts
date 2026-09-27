/**
 * commerce-revenue metric source (grade-code STRAT-PK1 hardening) — the KR sync
 * must match commerce's OWN revenue definition and never write a meaningless
 * number to an executive KR:
 *   - count paid + fulfilled + partially_refunded order totals, NET the refunded
 *     slice (a full refund → status 'refunded' → excluded);
 *   - scope to ONE currency (source.query, or single-currency auto-detect);
 *   - a mixed-currency org with no configured currency SKIPS honestly rather
 *     than summing across currencies.
 * Regression for the two backend findings in the grade-code pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { buildStrategySurface } from '../src/features/strategy/surface.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('strategy', 'on');
  await enableToggle('commerce', 'on');
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);
const S = '/v1/host/openwop-app/strategy';
const c = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${suffix}`;

async function orderPaid(owner: Client, orgId: string, price: number, currency = 'USD'): Promise<string> {
  const p = await owner.post(c(orgId, '/products'), { type: 'digital', name: 'Guide', price, currency });
  const o = await owner.post(c(orgId, '/orders'), { lines: [{ productId: p.body.productId, quantity: 1 }] });
  const paid = await owner.post(c(orgId, `/orders/${encodeURIComponent(o.body.orderId)}/pay`), { paymentIntentId: 'demo:pi' });
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  return o.body.orderId;
}

/** An owner + org + an ACTIVE org-scoped strategy with a commerce-revenue KR. */
async function setup(query?: string): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:pk-${Date.now()}-${n++}`;
  const owner = client();
  expect((await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pk'), tenantId })).status).toBe(201);
  const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Shop' })).body.orgId;
  const source = { kind: 'commerce-revenue', orgId, ...(query ? { query } : {}) };
  const s = (await owner.post(S, {
    orgId, title: 'Revenue plan', scope: 'org',
    objectives: [{ title: 'Grow revenue', weight: 1, keyResults: [{ title: 'Revenue', weight: 1, measure: { kind: 'currency', baseline: 0, target: 1000, unit: 'USD', source } }] }],
  })).body;
  expect(s.id, JSON.stringify(s)).toBeTruthy();
  // Activation gate is off by default → draft→active transitions directly, and
  // syncSourcedKrs only reconciles ACTIVE shared strategies.
  expect((await owner.patch(`${S}/${s.id}`, { status: 'active' })).status).toBe(200);
  return { owner, orgId, tenantId };
}

async function syncValue(tenantId: string): Promise<{ synced?: number; skippedReason?: string }> {
  const out = JSON.parse(JSON.stringify(await buildStrategySurface({ tenantId }).syncMetrics({ actor: 'run:sync' })));
  const synced = (out.synced as Array<{ value: number; source: string }>).find((x) => x.source === 'commerce-revenue');
  const skip = (out.skipped as Array<{ reason?: string }>).find((x) => String(x.reason ?? '').includes('commerce') || String(x.reason ?? '').includes('currency'));
  return { synced: synced?.value, skippedReason: skip?.reason };
}

describe('commerce-revenue metric source (grade-code)', () => {
  it('nets partial refunds, excludes full refunds, auto-detects a single currency', async () => {
    const { owner, orgId, tenantId } = await setup();
    await orderPaid(owner, orgId, 100);                                   // +100 (paid)
    const partial = await orderPaid(owner, orgId, 100);                  // +100 then −30 = +70
    expect((await owner.post(c(orgId, `/orders/${encodeURIComponent(partial)}/partial-refund`), { amount: 30, refundKey: 'k1' })).status).toBe(200);
    const full = await orderPaid(owner, orgId, 50);                      // fully refunded → +0
    expect((await owner.post(c(orgId, `/orders/${encodeURIComponent(full)}/refund`), {})).status).toBe(200);

    const { synced } = await syncValue(tenantId);
    expect(synced).toBe(170); // 100 + (100 − 30) + 0
  });

  it('skips honestly when the org sells in multiple currencies with no currency configured', async () => {
    const { owner, orgId, tenantId } = await setup();
    await orderPaid(owner, orgId, 100, 'USD');
    await orderPaid(owner, orgId, 100, 'EUR');
    const { synced, skippedReason } = await syncValue(tenantId);
    expect(synced).toBeUndefined();
    expect(skippedReason, 'expected an ambiguous-currency skip').toContain('ambiguous_currency');
  });

  it('scopes to the currency named in source.query (cross-currency orders excluded)', async () => {
    const { owner, orgId, tenantId } = await setup('USD');
    await orderPaid(owner, orgId, 100, 'USD');
    await orderPaid(owner, orgId, 999, 'EUR');
    const { synced } = await syncValue(tenantId);
    expect(synced).toBe(100);
  });
});
