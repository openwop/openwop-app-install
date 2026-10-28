/**
 * Sales Territory Management — Phase 4 (ADR 0272 §4.4, territory-scoped CRM visibility).
 * The security-critical test: it drives the CRM endpoints (not just /territories)
 * as a territory-scoped member and asserts the narrowed row set. Covers:
 *   - toggle OFF ⇒ CRM reads unfiltered (byte-unchanged)
 *   - a member sees ONLY their territory's assigned deals
 *   - fail-closed: an unassigned record is invisible to a scoped member
 *   - host:territories:view-all (admin/owner) bypass — sees everything
 *   - lazy-eval: a deal created AFTER activation still scopes correctly
 *   - a manager sees their whole subtree
 *   - WRITE is territory-scoped too (Wave 2): a scoped member's PATCH, activity or
 *     task on a hidden deal 404s exactly like a nonexistent id (no existence
 *     oracle); toggle OFF restores org-scoped writes
 * CORRECTED 2026-10-23 (grade-tests wave 61): the last bullet used to say WRITE
 * stays org-scoped and a member can still PATCH a hidden deal. Case 4 asserts the
 * opposite, and the product does the opposite.
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
import type { Territory } from '../src/features/territories/entities/territories.js';
import type { TerritoryAttainment } from '../src/features/territories/entities/quota.js';
import type { Pipeline } from '../src/features/crm/entities/pipelines.js';
import type { Deal } from '../src/features/crm/entities/deals.js';

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

interface Res<T> { status: number; body: T }
interface Client {
  get: <T = unknown>(p: string) => Promise<Res<T>>;
  getText: (p: string) => Promise<{ status: number; text: string }>;
  post: <T = unknown>(p: string, b?: unknown) => Promise<Res<T>>;
  patch: <T = unknown>(p: string, b?: unknown) => Promise<Res<T>>;
}
interface DealsBody { deals: Deal[] }
interface ErrorBody { error: string; message: string }
interface AttainmentBody { territories: TerritoryAttainment[]; unassigned: { weightedPipeline: number; won: number } }
interface LoginBody { user: { userId: string } }
/** A value the case needs; a miss fails the case with its name, not a TypeError. */
function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`missing: ${what}`);
  return v;
}
function client(): Client {
  let cookie = '';
  const raw = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return res;
  };
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await raw(method, path, body);
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    // The one JSON boundary: each call site names the body's type (product types or a local interface).
    return { status: res.status, body: out as T };
  };
  return {
    get: (p) => call('GET', p),
    getText: async (p) => { const res = await raw('GET', p); return { status: res.status, text: await res.text() }; },
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
  };
}

let n = 0;
const setTerritories = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('territories'); if (d) await saveConfig({ ...d, status }, 'test'); };
const t = (orgId: string): string => `/host/openwop-app/territories/orgs/${encodeURIComponent(orgId)}`;
const crm = (orgId: string): string => `/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}`;
const titles = (r: Res<DealsBody>): string[] => r.body.deals.map((d) => d.title).sort();

async function scenario(memberRole: string): Promise<{ owner: Client; rep: Client; repId: string; tenantId: string; orgId: string; modelId: string; west: Territory; east: Territory; cali: Territory; pipe: Pipeline; stageId: string }> {
  const tenantId = `org:terv-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
  const rep = client();
  const repId = (await rep.post<LoginBody>('/host/openwop-app/test/login', { email: `r-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
  const orgId = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'Rep', subject: repId, roles: [memberRole] });

  const pipe = (await owner.get<{ pipelines: Pipeline[] }>(`${crm(orgId)}/pipelines`)).body.pipelines[0]!;
  const stageId = pipe.stages.find((s) => s.probability === 30)!.stageId;
  const modelId = (await owner.post<{ modelId: string }>(`${t(orgId)}/models`, { name: 'M' })).body.modelId;
  const west = (await owner.post<Territory>(`${t(orgId)}/models/${modelId}/territories`, { name: 'West', memberSubjectIds: [repId] })).body;
  const cali = (await owner.post<Territory>(`${t(orgId)}/models/${modelId}/territories`, { name: 'California', parentTerritoryId: west.territoryId })).body;
  const east = (await owner.post<Territory>(`${t(orgId)}/models/${modelId}/territories`, { name: 'East' })).body;
  // amount<3000 → West, 3000..7000 → California, >7000 → East
  await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: east.territoryId, priority: 30, filter: { field: 'amount', op: 'gt', value: 7000 } });
  await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: cali.territoryId, priority: 20, filter: { field: 'amount', op: 'gte', value: 3000 } });
  await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: west.territoryId, priority: 10, filter: { field: 'amount', op: 'lt', value: 3000 } });
  return { owner, rep, repId, tenantId, orgId, modelId, west, east, cali, pipe, stageId };
}

describe('territories P4 — CRM record visibility', () => {
  it('scopes a member to their territory, is fail-closed, and view-all + toggle-off see all', async () => {
    await setTerritories('on');
    try {
      const s = await scenario('viewer');
      const mk = (title: string, amount: number) => s.owner.post<Deal>(`${crm(s.orgId)}/deals`, { title, amount, pipelineId: s.pipe.pipelineId, stageId: s.stageId });
      await mk('W', 1000); // West (rep is a member)
      await mk('C', 4000); // California (rep NOT a member)
      await mk('E', 9000); // East
      await s.owner.post<Deal>(`${crm(s.orgId)}/deals`, { title: 'U', amount: 5000, pipelineId: s.pipe.pipelineId, stageId: s.stageId, currency: 'ZZZ' }); // still California by amount
      await transitionModelViaReview(s.owner, t(s.orgId), s.modelId); // materialize

      // rep (viewer, no view-all) sees ONLY West's deal
      expect(titles(await s.rep.get<DealsBody>(`${crm(s.orgId)}/deals`))).toEqual(['W']);
      // owner (has host:territories:view-all) sees everything
      expect(titles(await s.owner.get<DealsBody>(`${crm(s.orgId)}/deals`)).length).toBe(4);

      // lazy-eval: a NEW West deal created after activation is visible without re-sync
      await s.owner.post<Deal>(`${crm(s.orgId)}/deals`, { title: 'W2', amount: 500, pipelineId: s.pipe.pipelineId, stageId: s.stageId });
      expect(titles(await s.rep.get<DealsBody>(`${crm(s.orgId)}/deals`))).toEqual(['W', 'W2']);

      // SIBLING READ PATHS must not leak (deep-review CRITICAL/HIGH):
      // 1. CSV export honors visibility — rep's deals export has only West rows
      const exp = await s.rep.getText(`${crm(s.orgId)}/export?entityType=deals`);
      expect(exp.status).toBe(200);
      const dataLines = exp.text.trim().split('\n').slice(1); // drop header
      expect(dataLines).toHaveLength(2); // W + W2 only, not C/E/U
      // East deal amount absent — matched as a CSV FIELD, not a substring: a
      // randomly-minted id can contain '9000' (observed: `user:19000f34…` turned
      // this red on an unrelated PR), so anchor on the column delimiters.
      expect(exp.text).not.toMatch(/(^|,)9000(,|$)/m);
      // 2. pipeline report's aging/perStage scoped — exact counts, not a comparison:
      //    the rep's report holds W + W2, the owner's all five open deals.
      const report = (c: Client) => c.get<{ totals: { openCount: number } }>(`${crm(s.orgId)}/reports/pipeline`);
      expect((await report(s.rep)).body.totals.openCount).toBe(2);
      expect((await report(s.owner)).body.totals.openCount).toBe(5);
      // 3. single-get by id — rep 404s on a hidden (East) deal, with the SAME refusal
      //    a nonexistent id gets (no existence oracle)
      const eastDeal = must((await s.owner.get<DealsBody>(`${crm(s.orgId)}/deals`)).body.deals.find((d) => d.title === 'E'), 'East deal');
      const hidden = await s.rep.get<ErrorBody>(`${crm(s.orgId)}/deals/${eastDeal.dealId}`);
      const absent = await s.rep.get<ErrorBody>(`${crm(s.orgId)}/deals/deal:does-not-exist`);
      expect(hidden.status).toBe(404);
      expect(absent.status).toBe(404);
      expect({ error: hidden.body.error, message: hidden.body.message }).toEqual({ error: absent.body.error, message: absent.body.message });
      expect((await s.owner.get(`${crm(s.orgId)}/deals/${eastDeal.dealId}`)).status).toBe(200); // view-all still reads it

      // toggle OFF ⇒ unfiltered (byte-unchanged): rep now sees all + single-get works
      await setTerritories('off');
      expect(titles(await s.rep.get<DealsBody>(`${crm(s.orgId)}/deals`)).length).toBe(5);
      expect((await s.rep.get(`${crm(s.orgId)}/deals/${eastDeal.dealId}`)).status).toBe(200);
    } finally {
      await setTerritories('on'); // never leave the toggle off for a later case
    }
  });

  it('scopes attainment to the viewer territories (A2) and re-sync keeps reads coherent (A1)', async () => {
    await setTerritories('on');
    const s = await scenario('viewer'); // rep is a MEMBER of West only
    const mk = (title: string, amount: number) => s.owner.post<Deal>(`${crm(s.orgId)}/deals`, { title, amount, pipelineId: s.pipe.pipelineId, stageId: s.stageId });
    await mk('W', 1000); // West
    await mk('E', 9000); // East (rep can't see)
    await transitionModelViaReview(s.owner, t(s.orgId), s.modelId);

    // owner (view-all) sees all territories in attainment; rep sees ONLY West
    const ownerAtt = await s.owner.get<AttainmentBody>(`${t(s.orgId)}/models/${s.modelId}/attainment`);
    const repAtt = await s.rep.get<AttainmentBody>(`${t(s.orgId)}/models/${s.modelId}/attainment`);
    expect(ownerAtt.body.territories.length).toBeGreaterThan(repAtt.body.territories.length);
    expect(repAtt.body.territories.map((x) => x.name)).toEqual(['West']);
    expect(repAtt.body.unassigned).toEqual({ weightedPipeline: 0, won: 0 }); // no org-wide leak

    // A1 coherence: rep's CRM list stays correct across a re-sync
    expect((await s.rep.get<DealsBody>(`${crm(s.orgId)}/deals`)).body.deals.map((d) => d.title).sort()).toEqual(['W']);
    await s.owner.post(`${t(s.orgId)}/reassign`); // invalidates the index
    expect((await s.rep.get<DealsBody>(`${crm(s.orgId)}/deals`)).body.deals.map((d) => d.title).sort()).toEqual(['W']);
  });

  it('R2 review B3 — an erasure cuts the ACL edge NOW, not in five minutes', async () => {
    // `visibility.ts` answers every row-visibility question from a cached index with a
    // 5-minute backstop, and every other writer of an ACTIVE model's rows is blocked by
    // `requirePlanningModel` — so the new subject eraser is the only in-place mutator of
    // a live ACL, and the first version of it invalidated nothing. `eraseSubject`
    // returned ok while the erased person kept reading their former territory's deals.
    await setTerritories('on');
    const s = await scenario('viewer');
    await s.owner.post<Deal>(`${crm(s.orgId)}/deals`, { title: 'W', amount: 1000, pipelineId: s.pipe.pipelineId, stageId: s.stageId });
    await transitionModelViaReview(s.owner, t(s.orgId), s.modelId);
    expect(titles(await s.rep.get<DealsBody>(`${crm(s.orgId)}/deals`))).toEqual(['W']);   // warms the cache

    await eraseSubject(s.tenantId, s.repId); // the tenant both users logged into

    // The membership is gone durably…
    const after = (await s.owner.get<{ territories: Territory[] }>(`${t(s.orgId)}/models/${s.modelId}/territories`)).body.territories
      .find((x) => x.territoryId === s.west.territoryId);
    expect(after?.memberSubjectIds).toEqual([]);
    // …and the very next read reflects it, with no wait.
    expect(titles(await s.rep.get<DealsBody>(`${crm(s.orgId)}/deals`))).toEqual([]);
  });

  it('territory-scopes WRITE (Wave 2): a rep can edit its own deal, 404s on a hidden one', async () => {
    await setTerritories('on');
    try {
      const s = await scenario('editor'); // editor has workspace:write, not view-all
      const w = await s.owner.post<Deal>(`${crm(s.orgId)}/deals`, { title: 'W', amount: 1000, pipelineId: s.pipe.pipelineId, stageId: s.stageId });
      const e = await s.owner.post<Deal>(`${crm(s.orgId)}/deals`, { title: 'E', amount: 9000, pipelineId: s.pipe.pipelineId, stageId: s.stageId });
      await transitionModelViaReview(s.owner, t(s.orgId), s.modelId);

      // rep can edit the West deal it can see...
      expect((await s.rep.patch(`${crm(s.orgId)}/deals/${w.body.dealId}`, { title: 'W-edited' })).status).toBe(200);
      // ...but a WRITE to the hidden East deal 404s (not 403 — no existence disclosure)
      expect((await s.rep.patch(`${crm(s.orgId)}/deals/${e.body.dealId}`, { title: 'hax' })).status).toBe(404);
      // owner (view-all) can still edit any deal
      expect((await s.owner.patch(`${crm(s.orgId)}/deals/${e.body.dealId}`, { title: 'E-ok' })).status).toBe(200);
      // toggle OFF ⇒ WRITE is org-scoped again (byte-unchanged)
      await setTerritories('off');
      expect((await s.rep.patch(`${crm(s.orgId)}/deals/${e.body.dealId}`, { title: 'now-ok' })).status).toBe(200);
    } finally {
      await setTerritories('on');
    }
  });

  it('gates linked deal/company on activities+tasks (Wave-2 review MEDIUM: oracle + unseen-timeline write)', async () => {
    await setTerritories('on');
    const s = await scenario('editor');
    const w = await s.owner.post<Deal>(`${crm(s.orgId)}/deals`, { title: 'W', amount: 1000, pipelineId: s.pipe.pipelineId, stageId: s.stageId });
    const e = await s.owner.post<Deal>(`${crm(s.orgId)}/deals`, { title: 'E', amount: 9000, pipelineId: s.pipe.pipelineId, stageId: s.stageId });
    await transitionModelViaReview(s.owner, t(s.orgId), s.modelId);

    // rep can log an activity on its own (West) deal...
    expect((await s.rep.post(`${crm(s.orgId)}/activities`, { kind: 'note', body: 'x', dealId: w.body.dealId })).status).toBe(201);
    // ...but logging on the hidden East deal 404s UNIFORMLY (same as a nonexistent id — no oracle)
    const hidden = await s.rep.post<ErrorBody>(`${crm(s.orgId)}/activities`, { kind: 'note', body: 'x', dealId: e.body.dealId });
    const absent = await s.rep.post<ErrorBody>(`${crm(s.orgId)}/activities`, { kind: 'note', body: 'x', dealId: 'deal:does-not-exist' });
    expect(hidden.status).toBe(404);
    expect(absent.status).toBe(404);
    expect({ error: hidden.body.error, message: hidden.body.message }).toEqual({ error: absent.body.error, message: absent.body.message });
    // a task linked to the hidden deal is likewise 404
    expect((await s.rep.post(`${crm(s.orgId)}/tasks`, { title: 'T', dealId: e.body.dealId })).status).toBe(404);
    // owner (view-all) can attach to any deal
    expect((await s.owner.post(`${crm(s.orgId)}/activities`, { kind: 'note', body: 'x', dealId: e.body.dealId })).status).toBe(201);
  });

  it('a manager who is ALSO a member keeps their subtree (Wave-1 review HIGH)', async () => {
    await setTerritories('on');
    const tenantId = `org:tervmm-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
    const u = client();
    const uid = (await u.post<LoginBody>('/host/openwop-app/test/login', { email: `u-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
    const orgId = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'U', subject: uid, roles: ['viewer'] });
    const pipe = (await owner.get<{ pipelines: Pipeline[] }>(`${crm(orgId)}/pipelines`)).body.pipelines[0]!;
    const stageId = pipe.stages.find((x) => x.probability === 30)!.stageId;
    const modelId = (await owner.post<{ modelId: string }>(`${t(orgId)}/models`, { name: 'M' })).body.modelId;
    // U is BOTH manager AND member of West (the parent of California)
    const west = (await owner.post<Territory>(`${t(orgId)}/models/${modelId}/territories`, { name: 'West', managerSubjectId: uid, memberSubjectIds: [uid] })).body;
    const cali = (await owner.post<Territory>(`${t(orgId)}/models/${modelId}/territories`, { name: 'California', parentTerritoryId: west.territoryId })).body;
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: cali.territoryId, priority: 20, filter: { field: 'amount', op: 'gte', value: 3000 } });
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: west.territoryId, priority: 10, filter: { field: 'amount', op: 'lt', value: 3000 } });
    await owner.post<Deal>(`${crm(orgId)}/deals`, { title: 'W', amount: 1000, pipelineId: pipe.pipelineId, stageId });
    await owner.post<Deal>(`${crm(orgId)}/deals`, { title: 'C', amount: 4000, pipelineId: pipe.pipelineId, stageId });
    await transitionModelViaReview(owner, t(orgId), modelId);
    // subtree NOT dropped: sees both West and its child California
    expect((await u.get<DealsBody>(`${crm(orgId)}/deals`)).body.deals.map((d) => d.title).sort()).toEqual(['C', 'W']);
  });

  it('a plain member of a parent gets no child subtree pipeline in rolled (Wave-1 review MEDIUM)', async () => {
    await setTerritories('on');
    const tenantId = `org:tervpm-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
    const m = client();
    const mid = (await m.post<LoginBody>('/host/openwop-app/test/login', { email: `m-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
    const orgId = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: mid, roles: ['viewer'] });
    const pipe = (await owner.get<{ pipelines: Pipeline[] }>(`${crm(orgId)}/pipelines`)).body.pipelines[0]!;
    const stageId = pipe.stages.find((x) => x.probability === 30)!.stageId;
    const modelId = (await owner.post<{ modelId: string }>(`${t(orgId)}/models`, { name: 'M' })).body.modelId;
    // M is a plain MEMBER of the parent (not a manager) — must NOT see child rolled pipeline
    const na = (await owner.post<Territory>(`${t(orgId)}/models/${modelId}/territories`, { name: 'NA', memberSubjectIds: [mid] })).body;
    const cali = (await owner.post<Territory>(`${t(orgId)}/models/${modelId}/territories`, { name: 'California', parentTerritoryId: na.territoryId })).body;
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: cali.territoryId, priority: 10, filter: { field: 'amount', op: 'gte', value: 1 } });
    await owner.post<Deal>(`${crm(orgId)}/deals`, { title: 'C', amount: 4000, pipelineId: pipe.pipelineId, stageId }); // → California child
    await transitionModelViaReview(owner, t(orgId), modelId);
    const att = await m.get<AttainmentBody>(`${t(orgId)}/models/${modelId}/attainment`);
    const naRow = must(att.body.territories.find((x) => x.name === 'NA'), 'NA row');
    // NA has no direct deals; California's $4000 must NOT leak into NA's rolled for a plain member
    expect(naRow.rolled.weightedPipeline).toBe(0);
    expect(att.body.territories.find((x) => x.name === 'California')).toBeUndefined(); // child not visible
  });

  it('a manager sees their whole subtree (West + California)', async () => {
    await setTerritories('on');
    const tenantId = `org:tervm-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post<LoginBody>('/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
    const mgr = client();
    const mgrId = (await mgr.post<LoginBody>('/host/openwop-app/test/login', { email: `m-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
    const orgId = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'Mgr', subject: mgrId, roles: ['viewer'] });
    const pipe = (await owner.get<{ pipelines: Pipeline[] }>(`${crm(orgId)}/pipelines`)).body.pipelines[0]!;
    const stageId = pipe.stages.find((x) => x.probability === 30)!.stageId;
    const modelId = (await owner.post<{ modelId: string }>(`${t(orgId)}/models`, { name: 'M' })).body.modelId;
    const west = (await owner.post<Territory>(`${t(orgId)}/models/${modelId}/territories`, { name: 'West', managerSubjectId: mgrId })).body;
    const cali = (await owner.post<Territory>(`${t(orgId)}/models/${modelId}/territories`, { name: 'California', parentTerritoryId: west.territoryId })).body;
    const east = (await owner.post<Territory>(`${t(orgId)}/models/${modelId}/territories`, { name: 'East' })).body; // sibling, NOT in West's subtree
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: east.territoryId, priority: 30, filter: { field: 'amount', op: 'gt', value: 7000 } });
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: cali.territoryId, priority: 20, filter: { field: 'amount', op: 'gte', value: 3000 } });
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: west.territoryId, priority: 10, filter: { field: 'amount', op: 'lt', value: 3000 } });
    await owner.post<Deal>(`${crm(orgId)}/deals`, { title: 'W', amount: 1000, pipelineId: pipe.pipelineId, stageId });
    await owner.post<Deal>(`${crm(orgId)}/deals`, { title: 'C', amount: 4000, pipelineId: pipe.pipelineId, stageId });
    await owner.post<Deal>(`${crm(orgId)}/deals`, { title: 'E', amount: 9000, pipelineId: pipe.pipelineId, stageId }); // → East, outside West's subtree
    await transitionModelViaReview(owner, t(orgId), modelId);

    // manager of West sees West + its child California, but NOT sibling East's deal
    expect((await mgr.get<DealsBody>(`${crm(orgId)}/deals`)).body.deals.map((d) => d.title).sort()).toEqual(['C', 'W']);
  });
});
