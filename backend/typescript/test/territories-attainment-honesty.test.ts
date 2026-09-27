/**
 * Territories ROUND 2 (UX_UPGRADE-territories, pass 2) — the seams where the
 * attainment table stated something it could not know.
 *
 * Round 1 (TER-G1) taught the roll-up to notice that the DEALS disagree with each
 * other, and dropped the currency symbol when they did. It never compared them
 * with the QUOTA, and it never touched the PERCENTAGE — which is the number this
 * screen exists to show.
 *
 *  - TER2-B1  deals in one currency, quota in another: no symbol, and no ratio
 *  - TER2-B1  mixed deals had their symbol withheld and their percentage kept
 *  - TER2-B2  quota rows summed across periods kept the FIRST row's currency
 *  - TER2-B3  an amount with no currency was saveable (unbackfillable at intake)
 *  - TER2-B4  a subject erasure never reached territories at all
 *  - TER2-M1  sums were rounded to 2dp regardless of the currency's exponent
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { transitionModelViaReview } from './territoryReview.js';
import { eraseSubject } from '../src/host/subjectErasure.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'territories']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}

let n = 0;
async function admin(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:terh-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
const t = (orgId: string): string => `/v1/host/openwop-app/territories/orgs/${encodeURIComponent(orgId)}`;
const crm = (orgId: string): string => `/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}`;

/** One territory holding every deal, with an optional quota — the shape all the
 *  currency cases share. Returns the single attainment row. */
async function oneTerritory(
  owner: Client,
  orgId: string,
  deals: Array<{ amount: number; currency?: string; status?: string }>,
  quota?: { amount: number; currency?: string; period?: string } | Array<{ amount: number; currency?: string; period: string }>,
  reportPeriod: string | null = '2026-Q1',
): Promise<any> {
  const pipe = (await owner.get(`${crm(orgId)}/pipelines`)).body.pipelines[0];
  const qualified = pipe.stages.find((s: any) => s.probability === 30);
  for (const [i, d] of deals.entries()) {
    await owner.post(`${crm(orgId)}/deals`, {
      title: `D${i}`, amount: d.amount, ...(d.currency ? { currency: d.currency } : {}),
      ...(d.status ? { status: d.status } : {}),
      closeDate: '2026-02-10', pipelineId: pipe.pipelineId, stageId: qualified.stageId,
    });
  }
  const modelId = (await owner.post(`${t(orgId)}/models`, { name: `M${n++}` })).body.modelId;
  const terr = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'All' })).body;
  await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: terr.territoryId, priority: 10, filter: { field: 'amount', op: 'gte', value: 0 } });
  for (const q of quota === undefined ? [] : Array.isArray(quota) ? quota : [quota]) {
    const put = await owner.put(`${t(orgId)}/models/${modelId}/territories/${terr.territoryId}/quota`, { period: q.period ?? '2026-Q1', amount: q.amount, ...(q.currency ? { currency: q.currency } : {}) });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  }
  await transitionModelViaReview(owner, t(orgId), modelId);
  const qs = reportPeriod ? `?period=${reportPeriod}` : '';
  const rep = await owner.get(`${t(orgId)}/models/${modelId}/attainment${qs}`);
  expect(rep.status, JSON.stringify(rep.body)).toBe(200);
  return rep.body.territories.find((x: any) => x.territoryId === terr.territoryId);
}

describe('TER2-B1 — the ratio is a claim, and round 1 never checked it', () => {
  it('deals in one currency against a quota in another: no ratio, and the reason is named', async () => {
    const { owner, orgId } = await admin();
    // The exact case round 1's rule cannot see: every deal AGREES (so
    // `currencyMixed` is correctly absent) — with a currency the quota is not in.
    // ¥ won ÷ $ quota was rendered as a confident percentage roughly 150× too high,
    // and the won figure itself carried the quota's `$`.
    const row = await oneTerritory(owner, orgId, [{ amount: 1_000_000, currency: 'JPY' }], { amount: 10_000, currency: 'USD' });
    expect(row.currencyMixed).toBeUndefined();          // round 1's flag stays silent…
    expect(row.valueCurrency).toBe('JPY');              // …and this is why it should not be
    expect(row.quotaCurrencyMismatch).toBe(true);
    expect(row.attainment).toBeNull();
    expect(row.coverage).toBeNull();
    expect(row.ratioUnavailable).toBe('quota-currency-mismatch');
  });

  it('…and a matching currency still gets its percentage (the negative control)', async () => {
    const { owner, orgId } = await admin();
    const row = await oneTerritory(owner, orgId, [{ amount: 1000, currency: 'USD' }], { amount: 10_000, currency: 'USD' });
    expect(row.quotaCurrencyMismatch).toBeUndefined();
    expect(row.valueCurrency).toBe('USD');
    expect(row.ratioUnavailable).toBeUndefined();
    expect(row.coverage).toBeCloseTo(0.03, 5);          // 1000 * 0.3 / 10000
  });

  it('mixed deal currencies lose the PERCENTAGE too, not just the symbol', async () => {
    const { owner, orgId } = await admin();
    // Round 1 withheld the symbol here and left `attainment` computed from the same
    // meaningless sum — the number a sales manager actually reads.
    const row = await oneTerritory(owner, orgId, [{ amount: 1000, currency: 'EUR' }, { amount: 2000, currency: 'GBP' }], { amount: 10_000, currency: 'EUR' });
    expect(row.currencyMixed).toBe(true);
    expect(row.valueCurrency).toBeUndefined();
    expect(row.attainment).toBeNull();
    expect(row.ratioUnavailable).toBe('mixed-deal-currencies');
  });

  it('a missing quota reports WHY, and is distinguishable from a currency problem', async () => {
    const { owner, orgId } = await admin();
    const row = await oneTerritory(owner, orgId, [{ amount: 1000, currency: 'USD' }]);
    expect(row.attainment).toBeNull();
    expect(row.ratioUnavailable).toBe('no-quota');
  });

  it('deals carrying NO currency are not treated as disagreement (named deferral)', async () => {
    const { owner, orgId } = await admin();
    // The CRM currency field is optional and mostly unset; treating absence as a
    // mismatch would blank the ratio for nearly every real model. Absence stays
    // silent — and this test is what makes that a DECISION rather than an accident.
    const row = await oneTerritory(owner, orgId, [{ amount: 1000 }], { amount: 10_000, currency: 'USD' });
    expect(row.valueCurrency).toBeUndefined();
    expect(row.quotaCurrencyMismatch).toBeUndefined();
    expect(row.coverage).toBeCloseTo(0.03, 5);
  });
});

describe('TER2-B2 — a quota summed across periods kept the first row currency', () => {
  it('quota rows in different currencies are not passed off as one number', async () => {
    const { owner, orgId } = await admin();
    // With no `period` filter the report SUMS the quota rows. A 2026-Q1 quota of
    // 100,000 USD and a 2026-Q2 quota of 100,000 EUR became "200,000 USD" — a
    // denominator nobody authored, under a symbol chosen by insertion order.
    const row = await oneTerritory(
      owner, orgId, [{ amount: 1000, currency: 'USD' }],
      [{ amount: 100_000, currency: 'USD', period: '2026-Q1' }, { amount: 100_000, currency: 'EUR', period: '2026-Q2' }],
      null,
    );
    expect(row.quotaCurrencyMixed).toBe(true);
    expect(row.currency).toBeUndefined();               // no symbol on a sum of unlike units
    expect(row.attainment).toBeNull();
    expect(row.ratioUnavailable).toBe('mixed-quota-currencies');
  });

  it('…and same-currency periods still sum and still rank (the negative control)', async () => {
    const { owner, orgId } = await admin();
    const row = await oneTerritory(
      owner, orgId, [{ amount: 1000, currency: 'USD' }],
      [{ amount: 100_000, currency: 'USD', period: '2026-Q1' }, { amount: 100_000, currency: 'USD', period: '2026-Q2' }],
      null,
    );
    expect(row.quotaCurrencyMixed).toBeUndefined();
    expect(row.currency).toBe('USD');
    expect(row.quota).toBe(200_000);
    expect(row.ratioUnavailable).toBeUndefined();
  });
});

describe('review fold-ins — defects the independent pass found in the fix', () => {
  it('B2: the symbol comes from the SET, not from whichever row merged first', async () => {
    const { owner, orgId } = await admin();
    // The first version tracked the currency set and then read `q?.currency` off the
    // merged row — computed and bypassed. A zero-amount row with no currency then
    // decided the symbol by insertion order.
    const row = await oneTerritory(
      owner, orgId, [{ amount: 1000, currency: 'USD' }],
      [{ amount: 0, period: '2026-Q1' }, { amount: 100_000, currency: 'USD', period: '2026-Q2' }],
      null,
    );
    expect(row.currency).toBe('USD');                  // unambiguously USD either way round
    expect(row.quotaCurrencyMixed).toBeUndefined();
    expect(row.ratioUnavailable).toBeUndefined();
  });

  it('B2: a legacy unit-less quota row poisons a sum it is added to', async () => {
    const { owner, orgId, tenantId } = await admin();
    // Round 1's blank "No currency" option created this population, and TER2-B3
    // preserves it deliberately. Adding 50,000-of-unknown to 100,000 USD is the
    // "denominator nobody authored" TER2-B2 is about — and it went undetected because a
    // currency-LESS row never entered the currency set at all.
    const { __putQuotaForErasure } = await import('../src/features/territories/entities/quota.js');
    const pipe = (await owner.get(`${crm(orgId)}/pipelines`)).body.pipelines[0];
    const qualified = pipe.stages.find((s: any) => s.probability === 30);
    await owner.post(`${crm(orgId)}/deals`, { title: 'D', amount: 1000, currency: 'USD', closeDate: '2026-02-10', pipelineId: pipe.pipelineId, stageId: qualified.stageId });
    const modelId = (await owner.post(`${t(orgId)}/models`, { name: 'Legacy' })).body.modelId;
    const terr = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'All' })).body;
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: terr.territoryId, priority: 10, filter: { field: 'amount', op: 'gte', value: 0 } });
    expect((await owner.put(`${t(orgId)}/models/${modelId}/territories/${terr.territoryId}/quota`, { period: '2026-Q2', amount: 100_000, currency: 'USD' })).status).toBe(200);
    await transitionModelViaReview(owner, t(orgId), modelId);

    const before = (await owner.get(`${t(orgId)}/models/${modelId}/attainment`)).body.territories[0];
    expect(before.currency).toBe('USD');                 // control: one real row, fine
    expect(before.ratioUnavailable).toBeUndefined();

    // Neither the route NOR the service can create this row any more (TER2-B3 guards at
    // the service), so it is written straight to the store — which is exactly the state
    // the rows already in production are in, and the only state this case can be in.
    await __putQuotaForErasure({
      quotaId: `${modelId}:${terr.territoryId}:2026-Q1`, tenantId, orgId, modelId,
      territoryId: terr.territoryId, period: '2026-Q1', amount: 50_000, repSplits: [],
      updatedAt: new Date().toISOString(),
    });
    const after = (await owner.get(`${t(orgId)}/models/${modelId}/attainment`)).body.territories[0];
    expect(after.quota).toBe(150_000);                   // the sum is still reported…
    expect(after.quotaCurrencyMixed).toBe(true);         // …but it claims no unit
    expect(after.currency).toBeUndefined();
    expect(after.attainment).toBeNull();
    expect(after.ratioUnavailable).toBe('mixed-quota-currencies');
  });

  it('M1: a ZERO-amount quota row cannot make the total ambiguous', async () => {
    const { owner, orgId } = await admin();
    // The deal side already said this in so many words; the quota side added every
    // row's currency unconditionally, so a 0 EUR row nulled a 100,000 USD ratio.
    const row = await oneTerritory(
      owner, orgId, [{ amount: 1000, currency: 'USD' }],
      [{ amount: 100_000, currency: 'USD', period: '2026-Q1' }, { amount: 0, currency: 'EUR', period: '2026-Q2' }],
      null,
    );
    expect(row.quotaCurrencyMixed).toBeUndefined();
    expect(row.currency).toBe('USD');
    expect(row.attainment).not.toBeNull();
  });

  it('M2: the model AUTHOR is erased too — the commit counted three subject fields, there were four', async () => {
    const { owner, orgId, tenantId } = await admin();
    const me = (await owner.get('/v1/host/openwop-app/me')).body;
    const modelId = (await owner.post(`${t(orgId)}/models`, { name: 'Authored' })).body.modelId;
    const before = (await owner.get(`${t(orgId)}/models`)).body.models.find((m: any) => m.modelId === modelId);
    expect(before.createdBy).toBeTruthy();
    await eraseSubject(tenantId, before.createdBy);
    const after = (await owner.get(`${t(orgId)}/models`)).body.models.find((m: any) => m.modelId === modelId);
    expect(after.createdBy).toBe('[erased]');
    expect(me).toBeTruthy();
  });
});

describe('TER2-B3 — an amount with no currency is not an amount of money', () => {
  it('refuses a quota amount with no currency, naming the field', async () => {
    const { owner, orgId } = await admin();
    const modelId = (await owner.post(`${t(orgId)}/models`, { name: 'NoCur' })).body.modelId;
    const terr = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'All' })).body;
    const res = await owner.put(`${t(orgId)}/models/${modelId}/territories/${terr.territoryId}/quota`, { period: '2026-Q1', amount: 5000 });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/currency/i);
  });

  it('a ZERO quota needs no currency — there is no unit to get wrong', async () => {
    const { owner, orgId } = await admin();
    const modelId = (await owner.post(`${t(orgId)}/models`, { name: 'Zero' })).body.modelId;
    const terr = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'All' })).body;
    const res = await owner.put(`${t(orgId)}/models/${modelId}/territories/${terr.territoryId}/quota`, { period: '2026-Q1', amount: 0 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe('TER2-M1 — sums are quantised to the currency the money is in', () => {
  it('a JPY figure carries no decimals (round(n, 2) invented two)', async () => {
    const { owner, orgId } = await admin();
    // 1001 * 0.30 = 300.3 — a representable amount in USD and not one in JPY.
    const row = await oneTerritory(owner, orgId, [{ amount: 1001, currency: 'JPY' }], { amount: 10_000, currency: 'JPY' });
    expect(row.rolled.weightedPipeline).toBe(300);
    expect(row.valueCurrency).toBe('JPY');
  });

  it('…and a USD figure keeps its two (the negative control)', async () => {
    const { owner, orgId } = await admin();
    const row = await oneTerritory(owner, orgId, [{ amount: 1001, currency: 'USD' }], { amount: 10_000, currency: 'USD' });
    expect(row.rolled.weightedPipeline).toBeCloseTo(300.3, 5);
  });
});

describe('TER2-B4 — subject erasure never reached territories', () => {
  it('the host fan-out clears memberships and manager grants, and anonymises quota splits', async () => {
    const { owner, orgId, tenantId } = await admin();
    const gone = 'user:rep-gone';
    const stays = 'user:rep-stays';
    const modelId = (await owner.post(`${t(orgId)}/models`, { name: 'Erase' })).body.modelId;
    const terr = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, {
      name: 'West', managerSubjectId: gone, memberSubjectIds: [gone, stays],
    })).body;
    expect((await owner.put(`${t(orgId)}/models/${modelId}/territories/${terr.territoryId}/quota`, {
      period: '2026-Q1', amount: 10_000, currency: 'USD',
      repSplits: [{ subjectId: gone, amount: 4000 }, { subjectId: stays, amount: 6000 }],
    })).status).toBe(200);

    // Driven through the HOST seam, not the feature function — that is the half that
    // was broken: the eraser existed nowhere, so nothing was registered to call.
    await eraseSubject(tenantId, gone);

    const after = (await owner.get(`${t(orgId)}/models/${modelId}/territories`)).body.territories.find((x: any) => x.territoryId === terr.territoryId);
    expect(after.memberSubjectIds).toEqual([stays]);
    expect(after.managerSubjectId).toBeUndefined();

    const quotas = (await owner.get(`${t(orgId)}/models/${modelId}/quotas`)).body.quotas;
    const split = quotas[0].repSplits;
    expect(split.find((s: any) => s.subjectId === gone)).toBeUndefined();
    expect(split.find((s: any) => s.subjectId === stays).amount).toBe(6000);
    // The amount SURVIVES under the sentinel: erasure is a privacy action, not a
    // quiet restatement of what the territory was asked to sell.
    expect(split.find((s: any) => s.subjectId === 'user:[erased]').amount).toBe(4000);
  });

  it('leaves another subject alone (the negative control)', async () => {
    const { owner, orgId, tenantId } = await admin();
    const keep = 'user:rep-keep';
    const modelId = (await owner.post(`${t(orgId)}/models`, { name: 'Erase2' })).body.modelId;
    const terr = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'East', managerSubjectId: keep, memberSubjectIds: [keep] })).body;
    await eraseSubject(tenantId, 'user:somebody-else');
    const after = (await owner.get(`${t(orgId)}/models/${modelId}/territories`)).body.territories.find((x: any) => x.territoryId === terr.territoryId);
    expect(after.memberSubjectIds).toEqual([keep]);
    expect(after.managerSubjectId).toBe(keep);
  });
});
