/**
 * Sales Territory Management — Phase 3 (quotas + attainment). Route-level.
 * Covers: quota CRUD + period validation, weighted-pipeline + won attainment,
 * parent-child hierarchy rollup, and per-rep splits keyed on deal.owner.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { transitionModelViaReview } from './territoryReview.js';

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
async function admin(): Promise<{ owner: Client; orgId: string }> {
  const tenantId = `org:terq-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}
const t = (orgId: string): string => `/v1/host/openwop-app/territories/orgs/${encodeURIComponent(orgId)}`;
const crm = (orgId: string): string => `/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}`;

describe('territories P3 — quotas + attainment', () => {
  it('rejects a bad period and computes weighted attainment with hierarchy rollup + rep splits', async () => {
    const { owner, orgId } = await admin();
    const pipe = (await owner.get(`${crm(orgId)}/pipelines`)).body.pipelines[0];
    // use the 30%-probability stage (default 'Qualified') so weighting is 0.30
    const qualified = pipe.stages.find((s: any) => s.probability === 30) ?? pipe.stages.find((s: any) => s.probability > 0 && s.probability < 100);
    const P = qualified.probability / 100;
    expect(P).toBe(0.3);

    // seed deals: two open in West, owned by two reps; one open in child California
    await owner.post(`${crm(orgId)}/deals`, { title: 'W1', amount: 1000, owner: 'user:rep-a', closeDate: '2026-02-10', pipelineId: pipe.pipelineId, stageId: qualified.stageId });
    await owner.post(`${crm(orgId)}/deals`, { title: 'W2', amount: 2000, owner: 'user:rep-b', closeDate: '2026-02-11', pipelineId: pipe.pipelineId, stageId: qualified.stageId });
    await owner.post(`${crm(orgId)}/deals`, { title: 'C1', amount: 4000, owner: 'user:rep-a', closeDate: '2026-03-15', pipelineId: pipe.pipelineId, stageId: qualified.stageId });

    const modelId = (await owner.post(`${t(orgId)}/models`, { name: 'FY26' })).body.modelId;
    const west = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'West', regionId: 'usa' })).body;
    const cali = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'California', parentTerritoryId: west.territoryId })).body;
    // assign: W* (amount<3000) → West, C1 (amount>=3000) → California
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: cali.territoryId, priority: 20, filter: { field: 'amount', op: 'gte', value: 3000 } });
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: west.territoryId, priority: 10, filter: { field: 'amount', op: 'lt', value: 3000 } });

    // bad period rejected
    expect((await owner.put(`${t(orgId)}/models/${modelId}/territories/${west.territoryId}/quota`, { period: '2026', amount: 100, currency: 'USD' })).status).toBe(400);
    // set quotas (West + California), West with rep splits (PUT upsert → 200)
    expect((await owner.put(`${t(orgId)}/models/${modelId}/territories/${west.territoryId}/quota`, { period: '2026-Q1', amount: 10000, currency: 'USD', repSplits: [{ subjectId: 'user:rep-a', amount: 4000 }, { subjectId: 'user:rep-b', amount: 6000 }] })).status).toBe(200);
    // R2 TER2-B3 — a quota amount now REQUIRES a currency (an amount with no unit is
    // not an amount of money), so this fixture states one. The deals here carry none,
    // which is deliberately not treated as disagreement — see `ratioUnavailable`.
    expect((await owner.put(`${t(orgId)}/models/${modelId}/territories/${cali.territoryId}/quota`, { period: '2026-Q1', amount: 5000, currency: 'USD' })).status).toBe(200);
    // bad currency rejected
    expect((await owner.put(`${t(orgId)}/models/${modelId}/territories/${cali.territoryId}/quota`, { period: '2026-Q1', amount: 1, currency: 'dollars' })).status).toBe(400);

    await transitionModelViaReview(owner, t(orgId), modelId); // materializes assignments

    const rep = await owner.get(`${t(orgId)}/models/${modelId}/attainment?period=2026-Q1`);
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    const byId = Object.fromEntries(rep.body.territories.map((x: any) => [x.territoryId, x]));
    const w = byId[west.territoryId];
    const c = byId[cali.territoryId];

    // California: one deal $4000 @30% = 1200 weighted (direct + rolled equal, it's a leaf)
    expect(c.direct.weightedPipeline).toBeCloseTo(1200, 5);
    expect(c.rolled.weightedPipeline).toBeCloseTo(1200, 5);
    // West direct: (1000+2000)*0.30 = 900; rolled = 900 + California 1200 = 2100
    expect(w.direct.weightedPipeline).toBeCloseTo(900, 5);
    expect(w.rolled.weightedPipeline).toBeCloseTo(2100, 5);
    // West quota 10000; no won yet ⇒ attainment 0, coverage = rolled.weighted/quota = 2100/10000
    expect(w.attainment).toBe(0);
    expect(w.coverage).toBeCloseTo(0.21, 5);
    // rep splits carried: rep-a quota 4000, rep-b quota 6000
    const splitA = w.repSplits.find((s: any) => s.subjectId === 'user:rep-a');
    const splitB = w.repSplits.find((s: any) => s.subjectId === 'user:rep-b');
    expect(splitA.quota).toBe(4000);
    expect(splitB.quota).toBe(6000);
    // rep-a's rep split on West ROLLS UP the subtree (M1): W1 in West ($1000@30%=300)
    // + C1 in child California ($4000@30%=1200) = 1500.
    expect(splitA.weightedPipeline).toBeCloseTo(1500, 5);
    // rep-b owns only W2 in West → 2000@30% = 600
    expect(splitB.weightedPipeline).toBeCloseTo(600, 5);
    // regionId (ADR 0282 §8) rides the attainment payload; absent when unset
    expect(w.regionId).toBe('usa');
    expect(c.regionId).toBeUndefined();
  });

  /**
   * TER-G1 (docs/steward/UX_UPGRADE-territories.md) — the attainment sums add raw deal
   * `amount`s and never consult the deal's own currency, so a territory holding
   * EUR and GBP deals produces a figure that is not in any currency at all. The
   * console then labelled it with the QUOTA's symbol. There is no FX in this
   * app, so the fix is not to convert but to REPORT the ambiguity.
   */
  it('TER-G1: flags a territory whose contributing deals span currencies', async () => {
    const { owner, orgId } = await admin();
    const pipe = (await owner.get(`${crm(orgId)}/pipelines`)).body.pipelines[0];
    const qualified = pipe.stages.find((s: any) => s.probability === 30);

    await owner.post(`${crm(orgId)}/deals`, { title: 'EUR deal', amount: 1000, currency: 'EUR', closeDate: '2026-02-10', pipelineId: pipe.pipelineId, stageId: qualified.stageId });
    await owner.post(`${crm(orgId)}/deals`, { title: 'GBP deal', amount: 2000, currency: 'GBP', closeDate: '2026-02-11', pipelineId: pipe.pipelineId, stageId: qualified.stageId });

    const modelId = (await owner.post(`${t(orgId)}/models`, { name: 'Mixed' })).body.modelId;
    const all = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'All' })).body;
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: all.territoryId, priority: 10, filter: { field: 'amount', op: 'gte', value: 0 } });
    await transitionModelViaReview(owner, t(orgId), modelId);

    const rep = await owner.get(`${t(orgId)}/models/${modelId}/attainment?period=2026-Q1`);
    const row = rep.body.territories.find((x: any) => x.territoryId === all.territoryId);
    // The sum itself is unchanged — this reports the ambiguity, it does not convert.
    expect(row.rolled.weightedPipeline).toBeCloseTo(900, 5); // (1000+2000)*0.3
    expect(row.currencyMixed).toBe(true);
  });

  it('TER-G1: a single-currency territory is NOT flagged', async () => {
    const { owner, orgId } = await admin();
    const pipe = (await owner.get(`${crm(orgId)}/pipelines`)).body.pipelines[0];
    const qualified = pipe.stages.find((s: any) => s.probability === 30);

    await owner.post(`${crm(orgId)}/deals`, { title: 'A', amount: 1000, currency: 'EUR', closeDate: '2026-02-10', pipelineId: pipe.pipelineId, stageId: qualified.stageId });
    await owner.post(`${crm(orgId)}/deals`, { title: 'B', amount: 2000, currency: 'EUR', closeDate: '2026-02-11', pipelineId: pipe.pipelineId, stageId: qualified.stageId });

    const modelId = (await owner.post(`${t(orgId)}/models`, { name: 'Single' })).body.modelId;
    const all = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'All' })).body;
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: all.territoryId, priority: 10, filter: { field: 'amount', op: 'gte', value: 0 } });
    await transitionModelViaReview(owner, t(orgId), modelId);

    const rep = await owner.get(`${t(orgId)}/models/${modelId}/attainment?period=2026-Q1`);
    const row = rep.body.territories.find((x: any) => x.territoryId === all.territoryId);
    expect(row.currencyMixed).toBeUndefined();
  });

  it('TER-G1: the ROLL-UP is where a clean parent becomes mixed', async () => {
    const { owner, orgId } = await admin();
    const pipe = (await owner.get(`${crm(orgId)}/pipelines`)).body.pipelines[0];
    const qualified = pipe.stages.find((s: any) => s.probability === 30);

    await owner.post(`${crm(orgId)}/deals`, { title: 'Parent EUR', amount: 1000, currency: 'EUR', closeDate: '2026-02-10', pipelineId: pipe.pipelineId, stageId: qualified.stageId });
    await owner.post(`${crm(orgId)}/deals`, { title: 'Child GBP', amount: 5000, currency: 'GBP', closeDate: '2026-02-11', pipelineId: pipe.pipelineId, stageId: qualified.stageId });

    const modelId = (await owner.post(`${t(orgId)}/models`, { name: 'Roll' })).body.modelId;
    const parent = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'Parent' })).body;
    const child = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'Child', parentTerritoryId: parent.territoryId })).body;
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: child.territoryId, priority: 20, filter: { field: 'amount', op: 'gte', value: 3000 } });
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: parent.territoryId, priority: 10, filter: { field: 'amount', op: 'lt', value: 3000 } });
    await transitionModelViaReview(owner, t(orgId), modelId);

    const rep = await owner.get(`${t(orgId)}/models/${modelId}/attainment?period=2026-Q1`);
    const byId = Object.fromEntries(rep.body.territories.map((x: any) => [x.territoryId, x]));
    // Each node holds ONE currency on its own …
    expect(byId[child.territoryId].currencyMixed).toBeUndefined();
    // … but the parent's rolled figure sums EUR and GBP, and says so. This is
    // exactly the case a per-node check would miss.
    expect(byId[parent.territoryId].currencyMixed).toBe(true);
  });

  it('period-scoped attainment counts only deals closing in that period (no all-time/period mismatch)', async () => {
    const { owner, orgId } = await admin();
    const pipe = (await owner.get(`${crm(orgId)}/pipelines`)).body.pipelines[0];
    const stageId = (pipe.stages.find((s: any) => s.probability === 30) ?? pipe.stages[0]).stageId;
    // one deal closes in Q1, one in Q2, one undated
    await owner.post(`${crm(orgId)}/deals`, { title: 'InQ1', amount: 1000, closeDate: '2026-02-01', pipelineId: pipe.pipelineId, stageId });
    await owner.post(`${crm(orgId)}/deals`, { title: 'InQ2', amount: 5000, closeDate: '2026-05-01', pipelineId: pipe.pipelineId, stageId });
    await owner.post(`${crm(orgId)}/deals`, { title: 'Undated', amount: 9000, pipelineId: pipe.pipelineId, stageId });
    const modelId = (await owner.post(`${t(orgId)}/models`, { name: 'M' })).body.modelId;
    const terr = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'All' })).body;
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: terr.territoryId, filter: { field: 'amount', op: 'gte', value: 1 } });
    await transitionModelViaReview(owner, t(orgId), modelId);

    // Q1 report: only the $1000 Q1 deal (1000*0.30=300); Q2 + undated excluded
    const q1 = (await owner.get(`${t(orgId)}/models/${modelId}/attainment?period=2026-Q1`)).body.territories.find((x: any) => x.territoryId === terr.territoryId);
    expect(q1.rolled.weightedPipeline).toBeCloseTo(300, 5);
    // all-time (no period): all three (1000+5000+9000)*0.30 = 4500
    const all = (await owner.get(`${t(orgId)}/models/${modelId}/attainment`)).body.territories.find((x: any) => x.territoryId === terr.territoryId);
    expect(all.rolled.weightedPipeline).toBeCloseTo(4500, 5);
  });
});
