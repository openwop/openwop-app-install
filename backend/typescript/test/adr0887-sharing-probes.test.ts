/**
 * ADR 0887 — the Sharing security probes (feature loop round 2, row 44).
 *
 * Each `describe` is one finding. Every one was RED on `origin/main` @ `132c1ea07`
 * before its fix (recorded in the ADR's implementation table), and each fix was
 * sabotage-checked after it was committed.
 *
 *  S1 — a public link outlived its PUBLISHER: after the member who minted it is
 *       removed from the org (or demoted to Viewer), the link kept serving the
 *       resource. A share link is a publish, and publishing is a write the mint
 *       gate checks once; nothing re-checked it.
 *  S2 — a public link outlived the publisher's ACCESS to the resource: a shared
 *       prompt its owner later made private kept serving its body on a link
 *       another member minted while it was shared.
 *  S3 — the expiry 410 was answered BEFORE every other gate, so an expired link
 *       to a deleted org, a disabled feature or a removed publisher still said
 *       "this token once existed" instead of the uniform 404.
 *  S4 — the public share responses carried no `Cache-Control`, so nothing told
 *       a browser or an intermediary not to keep a capability-token response.
 *  S5 — the management list showed every Viewer the live TITLE of resources
 *       they cannot read (another member's private prompt).
 *
 * The publisher verdict is memoized for 30 s (ADR 0887 D1, architect H3), so
 * every "after the change" read first ELAPSES the clock past that bound — which
 * also witnesses the bound: the change is honoured once it lapses, not instantly.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createUserTemplate } from '../src/host/promptStore.js';
import type { ShareLink } from '../src/features/sharing/sharingService.js';
import { setUserStatus } from '../src/features/users/usersService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'cms']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  createUserTemplate({ templateId: 'tpl-adr0887', version: '1.0.0', kind: 'user', text: 'The secret recipe body', name: 'tpl-adr0887' });
});
afterAll(async () => { vi.useRealTimers(); await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T; headers: Headers }
type Call = <T = Record<string, unknown>>(p: string, b?: unknown) => Promise<Res<T>>;
interface Client { get: Call; post: Call; patch: Call; del: Call }
function client(): Client {
  let cookie = '';
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T, headers: res.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

/** Move the clock forward (cumulative, Date only), past the 30 s verdict memo. */
let skew = 0;
function elapse(ms = 31_000): void {
  skew += ms;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(vi.getRealSystemTime() + skew);
}

let n = 0;
async function signup(c: Client, tenantId: string): Promise<string> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `adr0887-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId;
}

interface Team { owner: Client; member: Client; viewer: Client; orgId: string; memberId: string; memberUserId: string }
async function team(): Promise<Team> {
  const tenantId = `org:adr0887-${Date.now()}-${n++}`;
  const owner = client(); await signup(owner, tenantId);
  const member = client(); const memberUser = await signup(member, tenantId);
  const viewer = client(); const viewerUser = await signup(viewer, tenantId);
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId;
  const add = await owner.post<{ memberId: string }>(`/host/openwop-app/orgs/${orgId}/members`, { displayName: 'Ed', subject: memberUser, roles: ['editor'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  const addV = await owner.post(`/host/openwop-app/orgs/${orgId}/members`, { displayName: 'Vi', subject: viewerUser, roles: ['viewer'] });
  expect(addV.status, JSON.stringify(addV.body)).toBe(201);
  return { owner, member, viewer, orgId, memberId: add.body.memberId, memberUserId: memberUser };
}

const links = (orgId: string): string => `/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links`;
const shared = (token: string, s = ''): string => `/host/openwop-app/shared/${encodeURIComponent(token)}${s}`;

async function page(c: Client, orgId: string, title: string): Promise<string> {
  const r = await c.post<{ pageId: string }>(`/host/openwop-app/cms/orgs/${orgId}/pages`, { title, sections: [{ type: 'hero', data: { heading: title } }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.pageId;
}
async function mint(c: Client, orgId: string, body: Record<string, unknown>): Promise<string> {
  const r = await c.post<ShareLink & { token: string }>(links(orgId), body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.token;
}

describe('S1 — a link does not outlive its publisher', () => {
  it('a removed publisher\'s link goes dark on every public lane (uniform 404, no reason)', async () => {
    const t = await team();
    const token = await mint(t.member, t.orgId, { resourceType: 'cms_page', resourceId: await page(t.owner, t.orgId, 'Launch plan') });
    expect((await t.owner.get(shared(token))).status, 'live while the publisher is a writer').toBe(200);

    expect((await t.owner.del(`/host/openwop-app/orgs/${t.orgId}/members/${t.memberId}`)).status).toBe(204);
    elapse();

    for (const lane of ['', '/card']) {
      const r = await t.owner.get<{ details?: Record<string, unknown> }>(shared(token, lane));
      expect(r.status, `lane '${lane}' after removal`).toBe(404);
      expect(r.body.details ?? {}, 'the same envelope as a revoked token').toEqual({});
    }
    expect((await t.owner.post(shared(token, '/frame-view'), { frame: 0 })).status).toBe(404);
  });

  it('a publisher demoted to Viewer stops publishing; promoting them back revives the link', async () => {
    const t = await team();
    const token = await mint(t.member, t.orgId, { resourceType: 'cms_page', resourceId: await page(t.owner, t.orgId, 'Pricing') });
    const member = `/host/openwop-app/orgs/${t.orgId}/members/${t.memberId}`;
    expect((await t.owner.patch(member, { roles: ['viewer'] })).status).toBe(200);
    elapse();
    expect((await t.owner.get(shared(token))).status).toBe(404);
    // A live re-check, not a revoke: restoring the authority restores the link.
    expect((await t.owner.patch(member, { roles: ['editor'] })).status).toBe(200);
    elapse();
    expect((await t.owner.get(shared(token))).status).toBe(200);
  });

  it('a DISABLED publisher (SCIM deprovision / admin deactivate) keeps member rows but stops publishing (architect H1)', async () => {
    const t = await team();
    const token = await mint(t.member, t.orgId, { resourceType: 'cms_page', resourceId: await page(t.owner, t.orgId, 'Roadmap') });
    expect((await t.owner.get(shared(token))).status).toBe(200);
    await setUserStatus(t.memberUserId, 'disabled', { reason: 'scim' });
    elapse();
    expect((await t.owner.get(shared(token))).status).toBe(404);
  });

  it('the change is honoured only once the 30 s bound lapses (the stated freshness, not instant)', async () => {
    const t = await team();
    const token = await mint(t.member, t.orgId, { resourceType: 'cms_page', resourceId: await page(t.owner, t.orgId, 'Bound') });
    expect((await t.owner.get(shared(token))).status).toBe(200);
    expect((await t.owner.del(`/host/openwop-app/orgs/${t.orgId}/members/${t.memberId}`)).status).toBe(204);
    expect((await t.owner.get(shared(token))).status, 'inside the bound: the memoized verdict').toBe(200);
    elapse();
    expect((await t.owner.get(shared(token))).status, 'past the bound: dark').toBe(404);
  });
});

describe('S2 — a link does not outlive the publisher\'s access to the resource', () => {
  it('a shared prompt made private by its owner stops serving on another member\'s link', async () => {
    const t = await team();
    const created = await t.owner.post<{ entry: { entryId: string } }>(`/host/openwop-app/prompts/orgs/${t.orgId}/entries`, { name: 'Recipe', promptRef: 'tpl-adr0887', visibility: 'shared' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const entryId = created.body.entry.entryId;
    const token = await mint(t.member, t.orgId, { resourceType: 'prompt', resourceId: entryId });
    const before = await t.owner.get<{ resource: { body?: string } }>(shared(token));
    expect(before.status).toBe(200);
    expect(before.body.resource.body).toContain('secret recipe');

    const priv = await t.owner.patch(`/host/openwop-app/prompts/orgs/${t.orgId}/entries/${entryId}`, { name: 'Recipe', promptRef: 'tpl-adr0887', visibility: 'private' });
    expect(priv.status, JSON.stringify(priv.body)).toBe(200);
    elapse();

    const after = await t.owner.get<{ resource?: { body?: string } }>(shared(token));
    expect(after.status).toBe(404);
    expect(JSON.stringify(after.body)).not.toContain('secret recipe');
    // The owner's OWN link to their now-private prompt still works.
    const own = await mint(t.owner, t.orgId, { resourceType: 'prompt', resourceId: entryId });
    expect((await t.owner.get(shared(own))).status).toBe(200);
  });
});

describe('S3 — the expiry 410 is only ever given for a link that would otherwise be live', () => {
  it('an expired link whose publisher was removed answers the uniform 404, not 410', async () => {
    const t = await team();
    const token = await mint(t.member, t.orgId, { resourceType: 'cms_page', resourceId: await page(t.owner, t.orgId, 'Old'), expiresInDays: 1 });
    const control = await mint(t.owner, t.orgId, { resourceType: 'cms_page', resourceId: await page(t.owner, t.orgId, 'Old2'), expiresInDays: 1 });
    expect((await t.owner.del(`/host/openwop-app/orgs/${t.orgId}/members/${t.memberId}`)).status).toBe(204);
    elapse(2 * 86_400_000);
    expect((await t.owner.get(shared(control))).status, 'positive control: a live publisher\'s expired link is still the honest 410').toBe(410);
    const r = await t.owner.get<{ details?: Record<string, unknown> }>(shared(token));
    expect(r.status).toBe(404);
    expect(r.body.details ?? {}).toEqual({});
  });
});

describe('S4 — public share responses are never cacheable', () => {
  it('200, 404 and the card all carry `Cache-Control: private, no-store`', async () => {
    const t = await team();
    const token = await mint(t.owner, t.orgId, { resourceType: 'cms_page', resourceId: await page(t.owner, t.orgId, 'Cached?') });
    const anon = client();
    for (const p of [shared(token), shared(token, '/card'), shared('shr_doesnotexist')]) {
      const r = await anon.get(p);
      expect(r.headers.get('cache-control'), p).toBe('private, no-store');
    }
  });
});

describe('S5 — the management list does not show a reader titles they cannot read', () => {
  it('another member\'s private prompt link is listed without its title; its publisher still sees it', async () => {
    const t = await team();
    const created = await t.owner.post<{ entry: { entryId: string } }>(`/host/openwop-app/prompts/orgs/${t.orgId}/entries`, { name: 'Board pay memo', promptRef: 'tpl-adr0887', visibility: 'private' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await mint(t.owner, t.orgId, { resourceType: 'prompt', resourceId: created.body.entry.entryId, label: 'pay' });
    type L = { links: Array<ShareLink & { cardTitle?: string; label?: string; cardRedacted?: boolean }> };
    const asViewer = (await t.viewer.get<L>(links(t.orgId))).body.links;
    expect(asViewer).toHaveLength(1);
    expect(JSON.stringify(asViewer)).not.toContain('Board pay memo');
    expect(asViewer[0]!.cardRedacted).toBe(true);
    const asOwner = (await t.owner.get<L>(links(t.orgId))).body.links;
    expect(asOwner[0]!.cardTitle).toBe('Board pay memo');
  });
});

describe('D2 + D5 — the owner list says the publisher lost access, and a writer can adopt the link', () => {
  type L = { links: Array<ShareLink & { publisherInactive?: boolean; canAdopt?: boolean }> };
  const adopt = (c: Client, orgId: string, token: string): Promise<Res<ShareLink & { details?: Record<string, unknown> }>> =>
    c.post(`${links(orgId)}/${encodeURIComponent(token)}/adopt`, {});

  it('a dark link is flagged, adopted by a current writer, and serves again at the SAME URL', async () => {
    const t = await team();
    const token = await mint(t.member, t.orgId, { resourceType: 'cms_page', resourceId: await page(t.owner, t.orgId, 'Handbook') });
    // While the publisher is present: not flagged, and adopt is refused (recovery, not takeover).
    expect((await t.owner.get<L>(links(t.orgId))).body.links[0]!.publisherInactive).toBeUndefined();
    const early = await adopt(t.owner, t.orgId, token);
    expect(early.status).toBe(409);
    expect(early.body.details?.reason).toBe('publisher-active');

    expect((await t.owner.del(`/host/openwop-app/orgs/${t.orgId}/members/${t.memberId}`)).status).toBe(204);
    elapse();
    expect((await t.owner.get(shared(token))).status).toBe(404);
    const flagged = (await t.owner.get<L>(links(t.orgId))).body.links[0]!;
    expect(flagged.publisherInactive).toBe(true);
    expect(flagged.canAdopt, 'the owner (a writer) is offered Adopt').toBe(true);
    const asViewer = (await t.viewer.get<L>(links(t.orgId))).body.links[0]!;
    expect(asViewer.publisherInactive).toBe(true);
    expect(asViewer.canAdopt, 'a Viewer is never offered an action the server refuses').toBeUndefined();

    expect((await adopt(t.viewer, t.orgId, token)).status, 'a Viewer cannot adopt (adopting is publishing)').toBe(403);
    const ok = await adopt(t.owner, t.orgId, token);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.adoptedAt).toBeTruthy();
    expect((await t.owner.get(shared(token))).status, 'the same URL serves again').toBe(200);
    const after = (await t.owner.get<L>(links(t.orgId))).body.links[0]!;
    expect(after.publisherInactive).toBeUndefined();
  });

  it('a revoked link cannot be adopted', async () => {
    const t = await team();
    const token = await mint(t.member, t.orgId, { resourceType: 'cms_page', resourceId: await page(t.owner, t.orgId, 'Gone') });
    expect((await t.owner.del(`${links(t.orgId)}/${encodeURIComponent(token)}`)).status).toBe(204);
    expect((await t.owner.del(`/host/openwop-app/orgs/${t.orgId}/members/${t.memberId}`)).status).toBe(204);
    elapse();
    const r = await adopt(t.owner, t.orgId, token);
    expect(r.status).toBe(409);
    expect(r.body.details?.reason).toBe('revoked');
  });
});
