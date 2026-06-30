/**
 * Personal knowledge (ADR 0042) — ROUTE-level harness. Boots the real app and
 * drives the human knowledge surface over HTTP:
 *   - create + bind a collection, ingest a document, view lists it
 *   - retrieve composes BOTH bound docs AND personal memory notes (the shared
 *     subject composition, ADR 0042) — proving the twin corpus end-to-end
 *   - unbind drops it from the view (KB collection survives)
 *   - per-user isolation (a caller sees only their OWN bound knowledge)
 *
 * @see docs/adr/0042-human-knowledge-binding.md
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
  for (const id of ['users', 'kb']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p, b) => call('DELETE', p, b) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(): Promise<{ c: Client; orgId: string; userId: string }> {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pk') });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { c, orgId: org.body.orgId, userId: r.body.user.userId };
}

/** A co-tenant owner + a member with `role`, sharing one org. Mirrors the
 *  agent-knowledge RBAC harness. */
async function ownerAndMember(role: string): Promise<{ owner: Client; member: Client; orgId: string }> {
  const tenantId = `org:pk-${Date.now()}-${n++}`;
  const owner = client();
  const o = await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pk-owner'), tenantId });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  const member = client();
  const m = await member.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pk-member'), tenantId });
  expect(m.status, JSON.stringify(m.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  const orgId = org.body.orgId;
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: m.body.user.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, orgId };
}

const K = '/v1/host/openwop-app/profiles/me/knowledge';
const MEM = '/v1/host/openwop-app/profiles/me/memory';
const FELINE = 'Feline companions: cats groom themselves with their tongue and purr when content.';

describe('profile-knowledge — create, ingest, view, retrieve', () => {
  it('binds a collection, ingests a doc, and retrieve composes docs + personal notes', async () => {
    const { c, orgId } = await ownerWithOrg();
    expect((await c.get(K)).body.collections).toEqual([]);

    const col = await c.post(`${K}/collections`, { orgId, name: 'My Handbook' });
    expect(col.status, JSON.stringify(col.body)).toBe(201);
    const cid = col.body.collectionId;

    const doc = await c.post(`${K}/collections/${cid}/documents`, { orgId, title: 'Cats', text: FELINE });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);

    const view = await c.get(K);
    expect(view.body.collections.length).toBe(1);
    expect(view.body.collections[0].documents.length).toBe(1);

    // Also add a personal memory note — retrieve must compose BOTH sources.
    await c.post(MEM, { content: 'I summarize cat care every Friday.' });

    const ret = await c.post(`${K}/retrieve`, { query: 'how do cats groom and purr' });
    expect(ret.status, JSON.stringify(ret.body)).toBe(200);
    expect(ret.body.hasResults).toBe(true);
    const kinds = (ret.body.chunks as Array<{ kind: string }>).map((x) => x.kind);
    expect(kinds).toContain('kb');     // the bound document
    expect(kinds).toContain('memory'); // the personal note — one corpus

    // Unbind drops it from the view; the KB collection still exists.
    expect((await c.del(`${K}/bindings/${cid}`)).status).toBe(204);
    expect((await c.get(K)).body.collections.length).toBe(0);
    expect((await c.get(`/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${cid}`)).status).toBe(200);
  });
});

describe('profile-knowledge — per-user isolation', () => {
  it('a caller sees only their OWN bound knowledge', async () => {
    const a = await ownerWithOrg();
    await a.c.post(`${K}/collections`, { orgId: a.orgId, name: 'A docs' });
    const b = await ownerWithOrg();
    expect((await b.c.get(K)).body.collections).toEqual([]); // B sees nothing of A's
    expect((await a.c.get(K)).body.collections.length).toBe(1);
  });
});

describe('profile-knowledge — RBAC fail-closed', () => {
  it('a viewer (read-only) cannot create or ingest (403); the owner can', async () => {
    const { owner, member, orgId } = await ownerAndMember('viewer');
    // Owner (workspace:write) creates a collection.
    const col = await owner.post(`${K}/collections`, { orgId, name: 'Team handbook' });
    expect(col.status, JSON.stringify(col.body)).toBe(201);
    const cid = col.body.collectionId;
    // Viewer lacks workspace:write → create + ingest are 403, fail-closed.
    expect((await member.post(`${K}/collections`, { orgId, name: 'Nope' })).status).toBe(403);
    expect((await member.post(`${K}/collections/${cid}/documents`, { orgId, title: 'x', text: 'y' })).status).toBe(403);
    // …but a viewer CAN bind an existing collection they can read (workspace:read).
    expect((await member.post(`${K}/bindings`, { collectionId: cid })).status).toBe(201);
  });
});

describe('profile-knowledge — cross-org IDOR', () => {
  it('cannot ingest into a bound collection by claiming a different org (404)', async () => {
    const { c } = await ownerWithOrg();
    const org1 = (await c.post('/v1/host/openwop-app/orgs', { name: 'Org1' })).body.orgId;
    const org2 = (await c.post('/v1/host/openwop-app/orgs', { name: 'Org2' })).body.orgId;
    const cid = (await c.post(`${K}/collections`, { orgId: org1, name: 'In org1' })).body.collectionId;
    // The collection lives in org1; ingesting with orgId=org2 (where the caller
    // also has write) must NOT succeed — the collection isn't in org2 ⇒ 404.
    const bad = await c.post(`${K}/collections/${cid}/documents`, { orgId: org2, title: 't', text: 'x' });
    expect(bad.status, JSON.stringify(bad.body)).toBe(404);
    // Sanity: the correct org succeeds.
    expect((await c.post(`${K}/collections/${cid}/documents`, { orgId: org1, title: 't', text: 'x' })).status).toBe(201);
  });
});
