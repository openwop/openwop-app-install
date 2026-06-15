/**
 * Knowledge Base / RAG (ADR 0011) — ROUTE-level harness. Boots the real app and
 * drives the org-scoped, RBAC-gated KB over HTTP: toggle gating, collection +
 * document CRUD, ingest (pasted text + Media-asset token), semantic search with
 * citations, the RAG augment endpoint, and the three-tier RBAC (viewer searches,
 * editor/owner ingests, cross-tenant fail-closed).
 */

import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const PORT = 18691;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
  for (const id of ['users', 'kb']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res>; snapshot: () => string }
function client(initialCookie = ''): Client {
  let cookie = initialCookie;
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const sc = getSetCookies(res.headers);
    for (const ck of sc as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p), snapshot: () => cookie };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
// ADR 0026: real sign-in is Firebase OIDC; tests mint an authenticated user via
// the env-gated auth test seam. Pass a shared `tenantId` to make co-tenant users.
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('kb'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const enableKb = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('kb'); if (d) await saveConfig({ ...d, status }, 'test'); };

async function ownerWithMember(role: string): Promise<{ owner: Client; member: Client; orgId: string }> {
  // Co-tenant owner + member: mint each into one shared explicit tenantId, each
  // in its own client (org-RBAC requires org.tenantId === caller.user.tenantId).
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, { tenantId });
  const member = client();
  const memberUser = await signup(member, { tenantId });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId;
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, orgId };
}
const u = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}${suffix}`;

const FELINE = 'Feline companions: cats groom themselves with their tongue and purr when content. A kitten is a young cat that loves to play and pounce.';
const DB = 'Relational databases use B-tree indexes to speed up SQL query execution and JOIN operations across large tables.';

describe('kb — toggle gating', () => {
  it('404s when the kb toggle is off', async () => {
    await enableKb('off');
    const { owner, orgId } = await ownerWithMember('viewer');
    expect((await owner.get(u(orgId, '/collections'))).status).toBe(404);
    await enableKb('on');
  });
});

describe('kb — collections + ingest + search', () => {
  it('creates a collection, ingests text, and ranks the relevant doc first', async () => {
    await enableKb('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const col = await owner.post(u(orgId, '/collections'), { name: 'Handbook' });
    expect(col.status, JSON.stringify(col.body)).toBe(201);
    const cid = col.body.collectionId;

    const dA = await owner.post(u(orgId, `/collections/${cid}/documents`), { title: 'Cats', text: FELINE });
    const dB = await owner.post(u(orgId, `/collections/${cid}/documents`), { title: 'Databases', text: DB });
    expect(dA.status, JSON.stringify(dA.body)).toBe(201);
    expect(dB.status).toBe(201);
    expect(dA.body.chunkCount).toBeGreaterThan(0);

    // The collection's counts reflect the two docs.
    const got = await owner.get(u(orgId, `/collections/${cid}`));
    expect(got.body.documentCount).toBe(2);

    const search = await owner.post(u(orgId, `/collections/${cid}/search`), { query: 'how do cats groom and purr', topK: 3 });
    expect(search.status, JSON.stringify(search.body)).toBe(200);
    expect(search.body.results.length).toBeGreaterThan(0);
    // Lexical-overlap embedder ⇒ the feline doc outranks the database doc.
    expect(search.body.results[0].documentId).toBe(dA.body.documentId);
    expect(search.body.results[0].score).toBeGreaterThan(0);
  });

  it('rag endpoint returns citations + an augmented prompt grounded in the context', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const cid = (await owner.post(u(orgId, '/collections'), { name: 'KB' })).body.collectionId;
    await owner.post(u(orgId, `/collections/${cid}/documents`), { title: 'Cats', text: FELINE });
    const rag = await owner.post(u(orgId, `/collections/${cid}/rag`), { query: 'what do kittens do' });
    expect(rag.status, JSON.stringify(rag.body)).toBe(200);
    expect(rag.body.citations.length).toBeGreaterThan(0);
    expect(rag.body.citations[0].title).toBe('Cats');
    expect(rag.body.augmentedPrompt).toContain('kitten');
    expect(rag.body.augmentedPrompt).toContain('Question: what do kittens do');
  });

  it('empty collection search returns [] (never an error)', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const cid = (await owner.post(u(orgId, '/collections'), { name: 'Empty' })).body.collectionId;
    const search = await owner.post(u(orgId, `/collections/${cid}/search`), { query: 'anything' });
    expect(search.status).toBe(200);
    expect(search.body.results).toEqual([]);
  });
});

describe('kb — Media-token source', () => {
  it('ingests a text/plain Media asset by token, and 415s a binary asset', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const cid = (await owner.post(u(orgId, '/collections'), { name: 'Docs' })).body.collectionId;

    const upload = await owner.post('/v1/host/openwop-app/media/upload', {
      contentBase64: Buffer.from(FELINE, 'utf8').toString('base64'),
      contentType: 'text/plain',
      name: 'cats.txt',
    });
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const token = upload.body.token;

    const doc = await owner.post(u(orgId, `/collections/${cid}/documents`), { mediaToken: token });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);
    // The capability token is NOT stored/echoed (it's a credential); provenance
    // is the kind only.
    expect(doc.body.source).toEqual({ kind: 'media' });
    expect(JSON.stringify(doc.body)).not.toContain(token);

    const search = await owner.post(u(orgId, `/collections/${cid}/search`), { query: 'cats purr' });
    expect(search.body.results[0].documentId).toBe(doc.body.documentId);

    // A binary asset can't be text-extracted → 415.
    const png = await owner.post('/v1/host/openwop-app/media/upload', {
      contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      contentType: 'image/png',
      name: 'x.png',
    });
    expect(png.status).toBe(201);
    const bad = await owner.post(u(orgId, `/collections/${cid}/documents`), { mediaToken: png.body.token });
    expect(bad.status).toBe(415);
  });
});

describe('kb — RBAC + tenant isolation', () => {
  it('viewer searches but cannot ingest (403); a cross-tenant stranger is fail-closed (404)', async () => {
    const { owner, member, orgId } = await ownerWithMember('viewer');
    const cid = (await owner.post(u(orgId, '/collections'), { name: 'KB' })).body.collectionId;
    await owner.post(u(orgId, `/collections/${cid}/documents`), { title: 'Cats', text: FELINE });

    // Viewer (workspace:read) can search…
    expect((await member.post(u(orgId, `/collections/${cid}/search`), { query: 'cats' })).status).toBe(200);
    // …but cannot ingest (needs workspace:write).
    expect((await member.post(u(orgId, `/collections/${cid}/documents`), { text: 'x' })).status).toBe(403);
    // …and cannot create a collection.
    expect((await member.post(u(orgId, '/collections'), { name: 'Nope' })).status).toBe(403);

    // A different tenant's user is not a member of this org → 404 (IDOR guard).
    const stranger = client();
    await signup(stranger);
    expect((await stranger.get(u(orgId, '/collections'))).status).toBe(404);
    expect((await stranger.post(u(orgId, `/collections/${cid}/search`), { query: 'cats' })).status).toBe(404);
  });
});

describe('kb — delete cascades', () => {
  it('deleting a collection removes its documents and search 404s', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const cid = (await owner.post(u(orgId, '/collections'), { name: 'Temp' })).body.collectionId;
    const doc = await owner.post(u(orgId, `/collections/${cid}/documents`), { title: 'Cats', text: FELINE });
    expect((await owner.del(u(orgId, `/collections/${cid}`))).status).toBe(204);
    expect((await owner.get(u(orgId, `/collections/${cid}`))).status).toBe(404);
    expect((await owner.post(u(orgId, `/collections/${cid}/search`), { query: 'cats' })).status).toBe(404);
    expect((await owner.get(u(orgId, `/collections/${cid}/documents/${doc.body.documentId}`))).status).toBe(404);
  });
});
