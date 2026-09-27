/**
 * Sales Territory Management — Phase 2 (assignment engine). Route-level.
 * Covers: rule CRUD (planning-only), filter validation (field/op whitelist),
 * filter evaluation across ops, preview dry-run, and materialize-on-activate.
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
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function admin(): Promise<{ owner: Client; orgId: string }> {
  const tenantId = `org:terra-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}
const t = (orgId: string): string => `/v1/host/openwop-app/territories/orgs/${encodeURIComponent(orgId)}`;
const crm = (orgId: string): string => `/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}`;

describe('territories P2 — rules', () => {
  it('validates fields/ops and forbids editing rules on a non-planning model', async () => {
    const { owner, orgId } = await admin();
    const modelId = (await owner.post(`${t(orgId)}/models`, { name: 'M' })).body.modelId;
    const west = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'West' })).body;

    // unknown field → 400
    expect((await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: west.territoryId, filter: { field: 'evil', op: 'eq', value: 'x' } })).status).toBe(400);
    // unknown op → 400
    expect((await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: west.territoryId, filter: { field: 'amount', op: 'regex', value: 'x' } })).status).toBe(400);
    // missing territory → 400/404
    expect([400, 404]).toContain((await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', filter: { field: 'amount', op: 'gte', value: 1 } })).status);

    const rule = await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: west.territoryId, priority: 10, filter: { field: 'amount', op: 'gte', value: 1000 } });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    expect((await owner.get(`${t(orgId)}/models/${modelId}/rules`)).body.rules).toHaveLength(1);

    // prototype/dunder customFields keys are rejected (MEDIUM-1 escape guard)
    for (const bad of ['customFields.__proto__', 'customFields.constructor', 'customFields.toString']) {
      expect((await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: west.territoryId, filter: { field: bad, op: 'exists' } })).status, bad).toBe(400);
    }

    // once active, rules are frozen
    await transitionModelViaReview(owner, t(orgId), modelId);
    expect((await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: west.territoryId, filter: { field: 'amount', op: 'gte', value: 1 } })).status).toBe(409);
  });

  it('`in` matches an array-valued field (tags)', async () => {
    const { owner, orgId } = await admin();
    await owner.post(`${crm(orgId)}/companies`, { name: 'Ent', domain: 'ent.test', tags: ['enterprise'] });
    const modelId = (await owner.post(`${t(orgId)}/models`, { name: 'M' })).body.modelId;
    const terr = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'Ent' })).body;
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'company', territoryId: terr.territoryId, filter: { field: 'tags', op: 'in', value: ['enterprise', 'smb'] } });
    const preview = await owner.get(`${t(orgId)}/models/${modelId}/preview`);
    expect(preview.body.perTerritory.find((p: any) => p.territoryId === terr.territoryId)?.companies).toBe(1);
  });
});

describe('territories P2 — preview + materialize', () => {
  it('assigns matching records by rule, leaves non-matches unassigned, and materializes on activate', async () => {
    const { owner, orgId } = await admin();
    // seed CRM: two deals + one company
    const pipe = (await owner.get(`${crm(orgId)}/pipelines`)).body.pipelines[0];
    const stageId = pipe.stages[0].stageId;
    await owner.post(`${crm(orgId)}/deals`, { title: 'Big', amount: 5000, pipelineId: pipe.pipelineId, stageId });
    await owner.post(`${crm(orgId)}/deals`, { title: 'Small', amount: 100, pipelineId: pipe.pipelineId, stageId });
    await owner.post(`${crm(orgId)}/companies`, { name: 'AcmeCo', domain: 'acme.test' });

    const modelId = (await owner.post(`${t(orgId)}/models`, { name: 'Plan' })).body.modelId;
    const west = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'West' })).body;
    const namedAcct = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'Named' })).body;
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: west.territoryId, filter: { field: 'amount', op: 'gte', value: 1000 } });
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'company', territoryId: namedAcct.territoryId, filter: { field: 'domain', op: 'contains', value: 'acme' } });

    // preview (dry-run) — no writes
    const preview = await owner.get(`${t(orgId)}/models/${modelId}/preview`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.totals).toEqual({ companies: 1, deals: 2 });
    const westRow = preview.body.perTerritory.find((p: any) => p.territoryId === west.territoryId);
    expect(westRow.deals).toBe(1); // only the $5000 deal
    const namedRow = preview.body.perTerritory.find((p: any) => p.territoryId === namedAcct.territoryId);
    expect(namedRow.companies).toBe(1);
    expect(preview.body.unassigned.deals).toBe(1); // the $100 deal

    // activate → materializes; re-sync is idempotent
    const act = await transitionModelViaReview(owner, t(orgId), modelId);
    expect(act.status).toBe(200);
    const resync = await owner.post(`${t(orgId)}/reassign`);
    expect(resync.status, JSON.stringify(resync.body)).toBe(200);
    expect(resync.body.perTerritory.find((p: any) => p.territoryId === west.territoryId).deals).toBe(1);
  });
});
