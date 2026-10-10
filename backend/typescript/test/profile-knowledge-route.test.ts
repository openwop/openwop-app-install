/**
 * Personal knowledge (ADR 0042) — ROUTE-level harness. Boots the real app and
 * drives the human knowledge surface over HTTP:
 *   - create + bind a collection, ingest a document, view lists it
 *   - retrieve composes BOTH bound docs AND personal memory notes (the shared
 *     subject composition, ADR 0042) — proving the twin corpus end-to-end
 *   - unbind drops it from the view (KB collection survives)
 *   - per-user isolation: two members of the SAME tenant + org — the collection is
 *     readable by both, but only the one who BOUND it sees it in their view
 *   - RBAC fail-closed (viewer cannot create/ingest, can bind) and the cross-org IDOR
 *
 * Sabotage that turns it red:
 *   - retrieval with an empty binding / another user's memory scope → case 1
 *     (w3g2-pkr-kbleg / -memleg)
 *   - the view dropping a collection's documents → case 1 (w3g2-pkr-viewdocs)
 *   - unbind not removing the id → case 1 (w3g2-pkr-unbind)
 *   - the view listing every tenant collection instead of the caller's binding →
 *     the isolation case (w3g2-pkr-isolation)
 *   - create/ingest gated on `workspace:read`, bind on `workspace:write` → the RBAC
 *     case (w3g2-pkr-rbac-*)
 *   - ingest resolving the collection's real org from the binding instead of the
 *     scope-checked body org → the IDOR case (w3g2-pkr-idor)
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
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'kb']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: unknown }
interface LoginBody { user: { userId: string } }
interface OrgBody { orgId: string }
interface ColBody { collectionId: string; orgId: string; name: string }
interface ViewBody { collections: Array<{ collectionId: string; orgId: string; name: string; documents: Array<{ title: string }> }> }
interface RetrieveBody { hasResults: boolean; chunks: Array<{ kind: 'kb' | 'memory'; content: string }> }
const view = (r: Res): ViewBody['collections'] => (r.body as ViewBody).collections;
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p, b) => call('DELETE', p, b) };
}

const uniqEmail = (who: string): string => `${who}-${n++}@acme.test`;
async function ownerWithOrg(): Promise<{ c: Client; orgId: string; userId: string }> {
  const c = client();
  const r = await c.post('/host/openwop-app/test/login', { email: uniqEmail('pk') });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await c.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { c, orgId: (org.body as OrgBody).orgId, userId: (r.body as LoginBody).user.userId };
}

/** A co-tenant owner + a member with `role`, sharing one org. Mirrors the
 *  agent-knowledge RBAC harness. */
async function ownerAndMember(role: string): Promise<{ owner: Client; member: Client; orgId: string }> {
  const tenantId = `org:pk-${n++}`;
  const owner = client();
  const o = await owner.post('/host/openwop-app/test/login', { email: uniqEmail('pk-owner'), tenantId });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  const member = client();
  const m = await member.post('/host/openwop-app/test/login', { email: uniqEmail('pk-member'), tenantId });
  expect(m.status, JSON.stringify(m.body)).toBe(201);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const { orgId } = org.body as OrgBody;
  const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: (m.body as LoginBody).user.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, orgId };
}

const K = '/host/openwop-app/profiles/me/knowledge';
const MEM = '/host/openwop-app/profiles/me/memory';
const FELINE = 'Feline companions: cats groom themselves with their tongue and purr when content.';

describe('profile-knowledge — create, ingest, view, retrieve', () => {
  it('binds a collection, ingests a doc, and retrieve composes docs + personal notes', async () => {
    const { c, orgId } = await ownerWithOrg();
    expect(view(await c.get(K))).toEqual([]);

    const col = await c.post(`${K}/collections`, { orgId, name: 'My Handbook' });
    expect(col.status, JSON.stringify(col.body)).toBe(201);
    const cid = (col.body as ColBody).collectionId;

    const doc = await c.post(`${K}/collections/${cid}/documents`, { orgId, title: 'Cats', text: FELINE });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);

    const bound = view(await c.get(K));
    expect(bound.map((x) => x.collectionId)).toEqual([cid]);
    expect(bound[0]!.name).toBe('My Handbook');
    expect(bound[0]!.documents.map((d) => d.title)).toEqual(['Cats']);

    // Also add a personal memory note — retrieve must compose BOTH sources.
    const note = await c.post(MEM, { content: 'I summarize cat care every Friday.' });
    expect(note.status, JSON.stringify(note.body)).toBe(201);

    const ret = await c.post(`${K}/retrieve`, { query: 'how do cats groom and purr' });
    expect(ret.status, JSON.stringify(ret.body)).toBe(200);
    const retrieved = ret.body as RetrieveBody;
    expect(retrieved.hasResults).toBe(true);
    const kb = retrieved.chunks.filter((x) => x.kind === 'kb');
    const memory = retrieved.chunks.filter((x) => x.kind === 'memory');
    expect(kb.some((x) => x.content.includes('purr')), 'the bound document').toBe(true);
    expect(memory.some((x) => x.content.includes('Friday')), 'the personal note — one corpus').toBe(true);

    // Unbind drops it from the view; the KB collection still exists.
    expect((await c.del(`${K}/bindings/${cid}`)).status).toBe(204);
    expect(view(await c.get(K))).toEqual([]);
    expect((await c.get(`/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${cid}`)).status).toBe(200);
  });
});

describe('profile-knowledge — per-user isolation', () => {
  it('a caller sees only their OWN bound knowledge', async () => {
    // SAME tenant, SAME org: the member can READ the owner's collection, so the only
    // thing keeping it out of the member's view is that the member never bound it.
    // (Two separate tenants would prove tenant separation, not per-user binding.)
    const { owner, member, orgId } = await ownerAndMember('viewer');
    const col = await owner.post(`${K}/collections`, { orgId, name: 'Owner docs' });
    expect(col.status, JSON.stringify(col.body)).toBe(201);
    const cid = (col.body as ColBody).collectionId;

    expect(view(await owner.get(K)).map((x) => x.collectionId)).toEqual([cid]);
    expect(view(await member.get(K)), "the member sees nothing of the owner's binding").toEqual([]);

    // Positive control: visibility was never the reason — once the member binds
    // it themselves, it appears in THEIR view.
    expect((await member.post(`${K}/bindings`, { collectionId: cid })).status).toBe(201);
    expect(view(await member.get(K)).map((x) => x.collectionId)).toEqual([cid]);
  });
});

describe('profile-knowledge — RBAC fail-closed', () => {
  it('a viewer (read-only) cannot create or ingest (403); the owner can', async () => {
    const { owner, member, orgId } = await ownerAndMember('viewer');
    // Owner (workspace:write) creates a collection.
    const col = await owner.post(`${K}/collections`, { orgId, name: 'Team handbook' });
    expect(col.status, JSON.stringify(col.body)).toBe(201);
    const cid = (col.body as ColBody).collectionId;
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
    const org1 = ((await c.post('/host/openwop-app/orgs', { name: 'Org1' })).body as OrgBody).orgId;
    const org2 = ((await c.post('/host/openwop-app/orgs', { name: 'Org2' })).body as OrgBody).orgId;
    const cid = ((await c.post(`${K}/collections`, { orgId: org1, name: 'In org1' })).body as ColBody).collectionId;
    // The collection lives in org1; ingesting with orgId=org2 (where the caller
    // also has write) must NOT succeed — the collection isn't in org2 ⇒ 404.
    const bad = await c.post(`${K}/collections/${cid}/documents`, { orgId: org2, title: 't', text: 'x' });
    expect(bad.status, JSON.stringify(bad.body)).toBe(404);
    expect((bad.body as { error?: string }).error).toBe('not_found');
    // Sanity: the correct org succeeds — and only that one document landed.
    expect((await c.post(`${K}/collections/${cid}/documents`, { orgId: org1, title: 'good', text: 'x' })).status).toBe(201);
    expect(view(await c.get(K)).find((x) => x.collectionId === cid)?.documents.map((d) => d.title)).toEqual(['good']);
  });
});
