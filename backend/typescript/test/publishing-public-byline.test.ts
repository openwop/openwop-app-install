/**
 * `CMSA-13` / ADR 0593 §C9 (adversarial review of #3428, F5) — the public blog
 * byline is a DOUBLE-PREFIX bug, not just a governance question.
 *
 * `resolveAuthorNames` builds its subject refs with
 * `userRef(p.authorId ?? p.createdBy)`, and `userRef` is a naive
 * `` `user:${id}` ``. But `User.userId` is ALREADY `user:<32-hex>` on this host,
 * so the ref becomes `user:user:<hex>`; the users resolver is keyed on the bare
 * id, misses, and `fallbackName` strips one prefix and returns the other —
 * emitting **the raw internal principal** into an anonymous RSS `<dc:creator>`
 * and the blog list. `subjectDisplay.ts`'s own header says "Raw refs must never
 * render as UI", and the seam upholds that; the CALLER broke it.
 *
 * Two consequences, both witnessed below: the byline never showed the author's
 * real name at all (a plain functional bug hiding inside a security one), and
 * the internal principal leaked to unauthenticated readers. This is the same
 * DSAR double-prefix class the memory index records — scoped-vs-raw subject
 * keys silently disagreeing.
 *
 * The governance half of `CMSA-13` (the string is attacker-controlled at zero
 * scope via `PATCH /users/me`, and `authorId` is settable by any
 * `workspace:write` actor) stays filed: a byline showing the author's current
 * name is arguably correct product behaviour, and pinning it at publish time is
 * a ruling. What is NOT arguable is that it must be a NAME, escaped and
 * bounded — which is what this fix guarantees.
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

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const t = getToggleDefault('users');
  if (t) await saveConfig({ ...t, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Res<T = any> { status: number; body: T }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
}
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ c: Client; orgId: string; userId: string }> {
  const tenantId = `org:byline-${Date.now()}-${n++}`;
  const c = client();
  const login = await c.post('/v1/host/openwop-app/test/login', { email: `byline-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { c, orgId: org.body.orgId as string, userId: login.body.user.userId as string };
}
const cms = (orgId: string, s = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;

async function publishPost(c: Client, orgId: string, title: string): Promise<void> {
  const created = await c.post(cms(orgId, '/pages'), {
    title, kind: 'post', sections: [{ type: 'richText', data: { body: 'Hello world.' } }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await c.post(cms(orgId, `/pages/${created.body.pageId}/publish`))).status).toBe(200);
}

/** The anonymous, author-enriched blog feed. */
async function feed(orgId: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/blog/feed.xml`);
  expect(res.status).toBe(200);
  return res.text();
}
async function blogList(orgId: string): Promise<any> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/blog`);
  expect(res.status).toBe(200);
  return res.json();
}

describe('CMSA-13 — the anonymous byline must be a NAME, never the internal principal', () => {
  it('emits the author display name in <dc:creator>, and never `user:<id>`', async () => {
    const { c, orgId, userId } = await ownerOrg();
    const setName = await c.patch('/v1/host/openwop-app/users/me', { displayName: 'Ada Lovelace' });
    expect(setName.status, JSON.stringify(setName.body)).toBe(200);
    await publishPost(c, orgId, 'First post');

    const xml = await feed(orgId);
    expect(xml).toContain('<dc:creator>Ada Lovelace</dc:creator>');
    // The bug this closes: the ref was double-prefixed, so the users lookup
    // MISSED and the fallback emitted the principal. The byline therefore never
    // showed the real name either — a functional bug hiding inside a leak.
    expect(xml).not.toContain(userId);
    expect(xml).not.toMatch(/<dc:creator>user:/);

    const list = await blogList(orgId);
    expect(list.posts[0].authorName).toBe('Ada Lovelace');
  });

  it('with NO display name it degrades to a humanized id — still never the raw principal', async () => {
    // `subjectDisplay.ts`: "Absent resolvers degrade to fallbacks — never a raw
    // ref, never a throw." The seam upholds that; the caller must not undo it
    // with a `?? id` of its own.
    const { c, orgId, userId } = await ownerOrg();
    await publishPost(c, orgId, 'Anonymous-ish post');
    const xml = await feed(orgId);
    expect(xml).toMatch(/<dc:creator>[^<]+<\/dc:creator>/); // present…
    expect(xml).not.toContain(userId);                       // …but not the principal
    expect(xml).not.toMatch(/<dc:creator>user:/);
    const bare = userId.replace(/^user:/, '');
    expect(xml).not.toContain(bare);                         // nor the bare 32-hex
  });

  it('an attacker-controlled display name is XML-escaped, not injected', async () => {
    // `displayName` is writable by ANY active signed-in user at NO scope
    // (`PATCH /users/me`), so the public surface must treat it as hostile input.
    const { c, orgId } = await ownerOrg();
    const evil = '</dc:creator><script>alert(1)</script><dc:creator>';
    expect((await c.patch('/v1/host/openwop-app/users/me', { displayName: evil })).status).toBe(200);
    await publishPost(c, orgId, 'Escaped post');
    const xml = await feed(orgId);
    expect(xml).not.toContain('<script>');
    expect(xml).toContain('&lt;script&gt;');
    // Exactly one creator element for the one post — the injection did not
    // manufacture a second.
    expect((xml.match(/<dc:creator>/g) ?? []).length).toBe(1);
  });
});
