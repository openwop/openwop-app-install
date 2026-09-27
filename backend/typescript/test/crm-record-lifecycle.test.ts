/**
 * CRM record-lifecycle seam (ADR 0283; closes TERR-DATA-1 / RI-2 first consumer).
 *
 * ROUTE-level harness (mirrors territories-assignment.test.ts): a materialized
 * territory assignment must be pruned when its CRM deal/company is deleted via
 * the real DELETE routes — plus seam-contract units (keyed re-registration,
 * best-effort error isolation, fire-count).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { listAssignmentsForModel } from '../src/features/territories/entities/assignment.js';
import { onCrmRecordDeleted, fireCrmRecordDeleted } from '../src/host/crmRecordLifecycle.js';
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
async function admin(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:crl-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
const t = (orgId: string): string => `/v1/host/openwop-app/territories/orgs/${encodeURIComponent(orgId)}`;
const crm = (orgId: string): string => `/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}`;

describe('ADR 0283 — CRM deletion prunes territory assignments', () => {
  it('deal delete via the real route drops its materialized assignment (other assignments intact)', async () => {
    const { owner, orgId, tenantId } = await admin();
    const pipe = (await owner.get(`${crm(orgId)}/pipelines`)).body.pipelines[0];
    const stageId = pipe.stages[0].stageId;
    const big = (await owner.post(`${crm(orgId)}/deals`, { title: 'Big', amount: 5000, pipelineId: pipe.pipelineId, stageId })).body;
    const big2 = (await owner.post(`${crm(orgId)}/deals`, { title: 'Big2', amount: 7000, pipelineId: pipe.pipelineId, stageId })).body;

    const modelId = (await owner.post(`${t(orgId)}/models`, { name: 'Plan' })).body.modelId;
    const west = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'West' })).body;
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'deal', territoryId: west.territoryId, filter: { field: 'amount', op: 'gte', value: 1000 } });
    expect((await transitionModelViaReview(owner, t(orgId), modelId)).status).toBe(200);

    let assigned = await listAssignmentsForModel(tenantId, orgId, modelId);
    expect(assigned.filter((a) => a.target === 'deal')).toHaveLength(2);

    const del = await owner.del(`${crm(orgId)}/deals/${encodeURIComponent(big.dealId)}`);
    expect([200, 204]).toContain(del.status);

    assigned = await listAssignmentsForModel(tenantId, orgId, modelId);
    const dealAssignments = assigned.filter((a) => a.target === 'deal');
    expect(dealAssignments).toHaveLength(1); // pruned, not orphaned (TERR-DATA-1)
    expect(dealAssignments[0]!.recordId).toBe(big2.dealId);
  });

  it('company delete prunes its assignment too', async () => {
    const { owner, orgId, tenantId } = await admin();
    const co = (await owner.post(`${crm(orgId)}/companies`, { name: 'AcmeCo', domain: 'acme.test' })).body;
    const modelId = (await owner.post(`${t(orgId)}/models`, { name: 'Plan' })).body.modelId;
    const named = (await owner.post(`${t(orgId)}/models/${modelId}/territories`, { name: 'Named' })).body;
    await owner.post(`${t(orgId)}/models/${modelId}/rules`, { target: 'company', territoryId: named.territoryId, filter: { field: 'domain', op: 'contains', value: 'acme' } });
    await transitionModelViaReview(owner, t(orgId), modelId);

    expect((await listAssignmentsForModel(tenantId, orgId, modelId)).filter((a) => a.target === 'company')).toHaveLength(1);
    const del = await owner.del(`${crm(orgId)}/companies/${encodeURIComponent(co.companyId)}`);
    expect([200, 204]).toContain(del.status);
    expect((await listAssignmentsForModel(tenantId, orgId, modelId)).filter((a) => a.target === 'company')).toHaveLength(0);
  });
});

describe('seam contract', () => {
  it('keyed registration overwrites (no duplicate handlers); errors are isolated; count returned', async () => {
    const calls: string[] = [];
    onCrmRecordDeleted('test-a', async () => { calls.push('a-old'); });
    onCrmRecordDeleted('test-a', async () => { calls.push('a-new'); }); // overwrites the slot
    onCrmRecordDeleted('test-boom', async () => { throw new Error('boom'); });
    onCrmRecordDeleted('test-b', async () => { calls.push('b'); });

    const ran = await fireCrmRecordDeleted({ tenantId: 't-x', entity: 'contact', recordId: 'c-1' });
    expect(calls).not.toContain('a-old'); // keyed slot was overwritten
    expect(calls).toContain('a-new');
    expect(calls).toContain('b'); // the throwing handler did not block b
    // ran counts SUCCESSFUL handlers only (boom excluded); >= 2 because the
    // app-booted territories handler may also be registered in this process.
    expect(ran).toBeGreaterThanOrEqual(2);
  });
});
