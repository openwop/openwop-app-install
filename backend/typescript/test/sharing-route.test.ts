/**
 * Sharing (ADR 0013) — ROUTE-level harness. Drives both surfaces: the AUTHED
 * link management (RBAC-gated mint/list/revoke) and the PUBLIC, unauthenticated
 * token resolve — including the value-add over Publishing (sharing a DRAFT page),
 * a KB-collection overview share, the social card, and revoke/toggle-off gating.
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const PORT = 18695;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
  for (const id of ['users', 'cms', 'kb', 'sharing']) {
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
    const sc = typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : [];
    for (const ck of sc as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p), snapshot: () => cookie };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/sample/users/auth/signup', { email: uniqEmail('shr'), password: 'password123' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const enableSharing = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('sharing'); if (d) await saveConfig({ ...d, status }, 'test'); };

async function ownerWithMember(role: string): Promise<{ owner: Client; member: Client; orgId: string }> {
  const seed = client();
  await signup(seed);
  const ownerCookie = seed.snapshot();
  const memberUser = await signup(seed);
  const member = client(seed.snapshot());
  const owner = client(ownerCookie);
  const org = await owner.post('/v1/host/sample/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId;
  const add = await owner.post(`/v1/host/sample/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, orgId };
}

async function draftPage(owner: Client, orgId: string, title: string): Promise<string> {
  const r = await owner.post(`/v1/host/sample/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title, sections: [{ type: 'hero', data: { heading: 'Hi', subheading: 'Card description text.' } }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body.status).toBe('draft');
  return r.body.pageId;
}

const links = (orgId: string): string => `/v1/host/sample/sharing/orgs/${encodeURIComponent(orgId)}/links`;
const shared = (token: string, s = ''): string => `/v1/host/sample/shared/${encodeURIComponent(token)}${s}`;

describe('sharing — link management (RBAC)', () => {
  it('owner mints + lists + revokes; viewer lists but cannot mint/revoke (403)', async () => {
    const { owner, member, orgId } = await ownerWithMember('viewer');
    const pageId = await draftPage(owner, orgId, 'Page A');

    const mint = await owner.post(links(orgId), { resourceType: 'cms_page', resourceId: pageId, label: 'Review link' });
    expect(mint.status, JSON.stringify(mint.body)).toBe(201);
    expect(mint.body.token).toBeTruthy();
    expect(mint.body.revoked).toBe(false);

    const list = await member.get(links(orgId));
    expect(list.status).toBe(200);
    expect(list.body.links[0].cardTitle).toBe('Page A');

    expect((await member.post(links(orgId), { resourceType: 'cms_page', resourceId: pageId })).status).toBe(403);
    expect((await member.del(`${links(orgId)}/${encodeURIComponent(mint.body.token)}`)).status).toBe(403);
    expect((await owner.del(`${links(orgId)}/${encodeURIComponent(mint.body.token)}`)).status).toBe(204);
    // Idempotent revoke; a non-existent token 404s.
    expect((await owner.del(`${links(orgId)}/${encodeURIComponent(mint.body.token)}`)).status).toBe(204);
    expect((await owner.del(`${links(orgId)}/nope`)).status).toBe(404);
  });

  it('rejects an unknown resourceType (400) and a resource not in the org (404)', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    expect((await owner.post(links(orgId), { resourceType: 'nope', resourceId: 'x' })).status).toBe(400);
    expect((await owner.post(links(orgId), { resourceType: 'cms_page', resourceId: 'no-such-page' })).status).toBe(404);
    expect((await owner.post(links(orgId), { resourceType: 'cms_page', resourceId: 'x', expiresInDays: -1 })).status).toBe(400);
  });
});

describe('sharing — public resolve (unauthenticated)', () => {
  it('resolves a DRAFT CMS page by token (what the published-only public surface cannot serve)', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draftPage(owner, orgId, 'Secret Draft');
    const mint = await owner.post(links(orgId), { resourceType: 'cms_page', resourceId: pageId, label: 'preview' });
    const token = mint.body.token;

    const anon = client(); // NO cookie
    const r = await anon.get(shared(token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.resourceType).toBe('cms_page');
    expect(r.body.label).toBe('preview');
    expect(r.body.resource.title).toBe('Secret Draft');
    expect(r.body.resource.status).toBe('draft');

    const card = await anon.get(shared(token, '/card'));
    expect(card.status).toBe(200);
    expect(card.body.title).toBe('Secret Draft');
    expect(card.body.description).toBe('Card description text.');
  });

  it('resolves a KB-collection overview by token', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const col = await owner.post(`/v1/host/sample/kb/orgs/${encodeURIComponent(orgId)}/collections`, { name: 'Handbook' });
    const cid = col.body.collectionId;
    await owner.post(`/v1/host/sample/kb/orgs/${encodeURIComponent(orgId)}/collections/${cid}/documents`, { title: 'Doc One', text: 'hello world' });
    const mint = await owner.post(links(orgId), { resourceType: 'kb_collection', resourceId: cid });

    const anon = client();
    const r = await anon.get(shared(mint.body.token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.resource.name).toBe('Handbook');
    expect(r.body.resource.documents[0].title).toBe('Doc One');
  });

  it('404s a revoked link, an unknown/garbage token, and when the toggle is off', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draftPage(owner, orgId, 'Live');
    const token = (await owner.post(links(orgId), { resourceType: 'cms_page', resourceId: pageId })).body.token;
    const anon = client();
    expect((await anon.get(shared(token))).status).toBe(200);

    // garbage / unknown token
    expect((await anon.get(shared('not a real token!!'))).status).toBe(404);
    expect((await anon.get(shared('Zm9vYmFy'))).status).toBe(404);

    // revoke → 404
    await owner.del(`${links(orgId)}/${encodeURIComponent(token)}`);
    expect((await anon.get(shared(token))).status).toBe(404);

    // toggle off → 404 (even a fresh, valid link)
    const token2 = (await owner.post(links(orgId), { resourceType: 'cms_page', resourceId: pageId })).body.token;
    expect((await anon.get(shared(token2))).status).toBe(200);
    await enableSharing('off');
    try {
      expect((await anon.get(shared(token2))).status).toBe(404);
      expect((await anon.get(shared(token2, '/card'))).status).toBe(404);
    } finally {
      await enableSharing('on');
    }
  });

  it('a cross-org caller cannot revoke another org link (IDOR → 404), and a deleted resource 404s the link', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draftPage(owner, orgId, 'Doomed');
    const token = (await owner.post(links(orgId), { resourceType: 'cms_page', resourceId: pageId })).body.token;

    // A different tenant's user can't revoke this org's link (not a member → 404/403).
    const stranger = client();
    await signup(stranger);
    expect([403, 404]).toContain((await stranger.del(`${links(orgId)}/${encodeURIComponent(token)}`)).status);

    // Delete the underlying page → the link resolves to a gone resource → 404.
    await owner.del(`/v1/host/sample/cms/orgs/${encodeURIComponent(orgId)}/pages/${pageId}`);
    const anon = client();
    expect((await anon.get(shared(token))).status).toBe(404);
  });
});
