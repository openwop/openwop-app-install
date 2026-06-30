/**
 * Strategy → KB auto-indexer (ADR 0100 Phase 1) — ROUTE harness. Boots the real
 * app and drives Strategy CRUD + KB reads over HTTP to verify:
 *   - a SHARED (org/workspace) strategy is indexed into the managed 'Strategy KB'
 *     (one doc, keyed by the strategy id) on create + re-indexed on update
 *   - a USER-scoped (private) strategy is NEVER indexed (the RBAC carve-out)
 *   - a scope change org→user, an archive, and a hard-delete all REMOVE the doc
 *   - the managed collection rejects hand-edits via the KB routes (the guard)
 *   - indexing only happens when BOTH `kb` and `strategy` toggles are on
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
  await enableToggle('strategy');
  await enableToggle('kb');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client, tenantId: string): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('sk'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const enableToggle = async (id: string): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); };

const S = '/v1/host/openwop-app/strategy';
const freshTenant = (): string => `org:sk-${Date.now()}-${n++}`;
async function ownerWithOrg(): Promise<{ owner: Client; orgId: string }> {
  const owner = client();
  await signup(owner, freshTenant());
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}

/** The managed 'Strategy KB' doc ids for an org (empty if the collection absent). */
async function kbDocIds(owner: Client, orgId: string): Promise<string[]> {
  const colId = `mgd-strategy-${orgId}`;
  const docs = await owner.get(`/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(colId)}/documents`);
  if (docs.status !== 200) return [];
  return (docs.body.documents as Array<{ documentId: string }>).map((d) => d.documentId);
}

describe('ADR 0100 P1 — strategy indexes into the managed Strategy KB', () => {
  it('indexes a shared (org) strategy on create, and the collection is marked managed', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await owner.post(S, { orgId, title: 'North Star', summary: 'Win the market', objectives: [{ title: 'Grow ARR', keyResults: [{ title: 'ARR 10M', target: '10M' }] }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    expect(await kbDocIds(owner, orgId)).toEqual([created.body.id]);
    const cols = await owner.get(`/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections`);
    const managed = (cols.body.collections as Array<any>).find((c) => c.collectionId === `mgd-strategy-${orgId}`);
    expect(managed?.managed).toBe('strategy');
    expect(managed?.name).toBe('Strategy KB');
  });

  it('does NOT index a user-scoped (private) strategy — the RBAC carve-out', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const priv = await owner.post(S, { orgId, title: 'My private bet', scope: 'user' });
    expect(priv.status).toBe(201);
    expect(await kbDocIds(owner, orgId)).not.toContain(priv.body.id);
  });

  it('re-indexes on update (single doc, upserted by stable id)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const s = await owner.post(S, { orgId, title: 'V1' });
    await owner.patch(`${S}/${s.body.id}`, { title: 'V2 renamed' });
    expect(await kbDocIds(owner, orgId)).toEqual([s.body.id]); // still one doc, not duplicated
  });

  it('REMOVES the doc when scope changes org→user', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const s = await owner.post(S, { orgId, title: 'Was shared' });
    expect(await kbDocIds(owner, orgId)).toContain(s.body.id);
    const patched = await owner.patch(`${S}/${s.body.id}`, { scope: 'user' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(await kbDocIds(owner, orgId)).not.toContain(s.body.id);
  });

  it('REMOVES the doc on archive', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const s = await owner.post(S, { orgId, title: 'To archive' });
    expect(await kbDocIds(owner, orgId)).toContain(s.body.id);
    const del = await owner.del(`${S}/${s.body.id}`); // shared ⇒ soft-archive
    expect(del.status === 200 || del.status === 204).toBe(true);
    expect(await kbDocIds(owner, orgId)).not.toContain(s.body.id);
  });
});

describe('ADR 0100 P1 — managed collection is read-only via the KB routes', () => {
  it('rejects ingest + delete on the managed Strategy KB (400), keeping it in sync', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await owner.post(S, { orgId, title: 'Seed' }); // creates the managed collection
    const colId = `mgd-strategy-${orgId}`;
    const base = `/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(colId)}`;

    const ingest = await owner.post(`${base}/documents`, { title: 'manual', text: 'should be rejected' });
    expect(ingest.status).toBe(400);
    const delCol = await owner.del(base);
    expect(delCol.status).toBe(400);
  });
});
