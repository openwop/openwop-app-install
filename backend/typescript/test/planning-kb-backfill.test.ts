/**
 * ADR 0100 Phase 3 — content-hash guard + backfill routes. ROUTE harness.
 *   - the upsert content-hash guard skips re-embed when indexable text is
 *     unchanged (observed via the doc's preserved `createdAt`), and re-ingests
 *     when it changes
 *   - POST /{strategy,priority-matrix}/reindex-kb sweeps entities that predate
 *     the toggles flipping on (always-on gating only catches future CRUD)
 *   - reindex is toggle- + workspace:write-gated
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['strategy', 'priority-matrix', 'kb', 'projects']) await setToggle(id, 'on');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const S = '/v1/host/openwop-app/strategy';
const L = '/v1/host/openwop-app/priority-matrix/lists';

async function ownerWithOrg(): Promise<{ owner: Client; orgId: string }> {
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('bf'), tenantId: `org:bf-${Date.now()}-${n++}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  return { owner, orgId: org.body.orgId };
}
async function stratDoc(owner: Client, orgId: string, id: string): Promise<any> {
  const colId = `mgd-strategy-${orgId}`;
  return (await owner.get(`/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(colId)}/documents/${encodeURIComponent(id)}`)).body;
}
async function stratDocIds(owner: Client, orgId: string): Promise<string[]> {
  const colId = `mgd-strategy-${orgId}`;
  const docs = await owner.get(`/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(colId)}/documents`);
  return docs.status === 200 ? (docs.body.documents as Array<{ documentId: string }>).map((d) => d.documentId) : [];
}

describe('ADR 0100 P3 — content-hash guard', () => {
  it('skips re-embed when text is unchanged (createdAt preserved), re-ingests on change', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const s = (await owner.post(S, { orgId, title: 'Hash me', summary: 'stable' })).body;
    const created1 = (await stratDoc(owner, orgId, s.id)).createdAt;
    expect(created1).toBeTruthy();

    await sleep(5);
    // No content change to the indexable text → guard skips → createdAt preserved.
    await owner.patch(`${S}/${s.id}`, { summary: 'stable' });
    expect((await stratDoc(owner, orgId, s.id)).createdAt).toBe(created1);

    await sleep(5);
    // Real content change → re-ingested → createdAt advances.
    await owner.patch(`${S}/${s.id}`, { summary: 'CHANGED' });
    expect((await stratDoc(owner, orgId, s.id)).createdAt).not.toBe(created1);
  });
});

describe('ADR 0100 P3 — backfill routes', () => {
  it('strategy reindex-kb re-sweeps the org’s strategies (idempotent; kb always-on)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const a = (await owner.post(S, { orgId, title: 'Pre-existing A' })).body;
    const b = (await owner.post(S, { orgId, title: 'Pre-existing B' })).body;
    const r = await owner.post(`${S}/reindex-kb`, { orgId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.processed).toBe(2);
    expect(await stratDocIds(owner, orgId)).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('priority-matrix reindex-kb sweeps pre-existing lists + ideas', async () => {
    await setToggle('kb', 'off');
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Old list' })).body;
    const idea = (await owner.post(`${L}/${encodeURIComponent(list.id)}/ideas`, { title: 'Old idea' })).body;
    await setToggle('kb', 'on');

    const r = await owner.post('/v1/host/openwop-app/priority-matrix/reindex-kb', { orgId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const colId = `mgd-priority-matrix-${orgId}`;
    const docs = await owner.get(`/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(colId)}/documents`);
    const ids = (docs.body.documents as Array<{ documentId: string }>).map((d) => d.documentId);
    expect(ids).toEqual(expect.arrayContaining([`pm-list:${list.id}`, `pm-idea:${idea.id}`]));
  });

  // (Removed) "AUTO-backfills pre-existing strategies on first collection creation"
  // — its premise was strategies created while the KB toggle was OFF (unindexed).
  // KB is now always-on (toggle removed; ADR 0010/0024 graduation), so a strategy
  // is indexed on create and that unindexed-predecessor state can't arise.

  it('AUTO-backfills pre-existing priority-matrix lists on first collection creation', async () => {
    await setToggle('kb', 'off');
    const { owner, orgId } = await ownerWithOrg();
    const old = (await owner.post(L, { orgId, name: 'Old list before flip' })).body;
    await setToggle('kb', 'on');
    const fresh = (await owner.post(L, { orgId, name: 'New list after flip' })).body;
    const colId = `mgd-priority-matrix-${orgId}`;
    const docs = await owner.get(`/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(colId)}/documents`);
    const ids = (docs.body.documents as Array<{ documentId: string }>).map((d) => d.documentId);
    expect(ids).toEqual(expect.arrayContaining([`pm-list:${old.id}`, `pm-list:${fresh.id}`]));
  });

  it('reindex-kb is toggle- and write-gated', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await setToggle('strategy', 'off');
    expect((await owner.post(`${S}/reindex-kb`, { orgId })).status).toBe(404);
    await setToggle('strategy', 'on');
    // a member without workspace:write in the org → 403
    const stranger = client();
    await stranger.post('/v1/host/openwop-app/test/login', { email: uniqEmail('stranger'), tenantId: `org:other-${Date.now()}-${n++}` });
    expect((await stranger.post(`${S}/reindex-kb`, { orgId })).status).toBe(403);
  });
});
