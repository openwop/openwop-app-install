/**
 * ADR 0888 — the profiles directory resolver, the team-view allowlist, the run-lane
 * floor, and retention's byte release. Every case here was a RED probe on
 * `origin/main` @ `482da8a52` (feature loop 2026-10 row 45) unless marked SOUND.
 *
 * Identity fixture: the PRODUCTION path for a shared workspace — sign in to the
 * personal tenant (as OIDC leaves you), become a workspace-root member under the
 * HOME `userId`, then `/workspaces/:id/switch`. A `tenantId`-seeded seam login
 * would mint a workspace-keyed user and test a shape production never has.
 *
 * Sabotage (each witnessed red, see the ADR's phase table):
 *   - `resolveRouteDirectory` ignores the active workspace  → 'lists a co-member who shared'
 *   - the share index skips the membership re-check         → 'a member who left disappears'
 *   - the directory lists members instead of shares         → 'never lists a member who did not share'
 *   - `viewProfile` spreads the row (no allowlist)          → 'peer view is an allowlist'
 *   - `resolveRunDirectory` returns home when actor absent  → 'a run with no acting user'
 *   - the purger skips the byte release                     → 'retention reclaims the avatar bytes'
 *   - the eraser skips share rows                           → 'erasure removes the share'
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, createWorkspace, deleteMember, ensureWorkspaceRootOrg, listMembers } from '../src/host/accessControlService.js';
import { buildProfilesSurface } from '../src/features/profiles/surface.js';
import { setUserStatus } from '../src/features/users/usersService.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { purgeRetained } from '../src/host/retentionPurger.js';
import { isInlineImageType } from '../src/host/assetServeHeaders.js';
import { __rawWorkspaceShares, putShare } from '../src/features/profiles/directory.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res { status: number; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any -- JSON boundary of a test client
async function call(cookie: string, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}
const P = '/host/openwop-app/profiles';

interface Person { cookie: string; userId: string; tenantId: string }
/** Personal login, as OIDC leaves a user. */
async function person(tag: string): Promise<Person> {
  const subject = `oidc:adr0888-${tag}-${Date.now()}-${n++}`;
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, displayName: tag }),
  });
  expect(res.status).toBeLessThan(300);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const { user } = (await res.json()) as { user: { userId: string; tenantId: string } };
  return { cookie, userId: user.userId, tenantId: user.tenantId };
}
async function switchInto(p: Person, ws: string): Promise<string> {
  const sw = await fetch(`${BASE}/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`, { method: 'POST', headers: { cookie: p.cookie } });
  expect(sw.status, await sw.clone().text()).toBe(200);
  return (sw.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}
/** A workspace with Alice (owner) and Bob (viewer); both filled in a profile at home. */
async function team(): Promise<{ ws: string; alice: Person; bob: Person; aliceWs: string; bobWs: string }> {
  const ws = (await createWorkspace({ name: `adr0888 ${n++}`, ownerSubject: 'oidc:adr0888-founder' })).tenantId;
  const alice = await person('alice');
  const bob = await person('bob');
  await createMember({ orgId: ws, tenantId: ws, displayName: 'Alice', subject: alice.userId, roles: ['owner'] });
  await createMember({ orgId: ws, tenantId: ws, displayName: 'Bob', subject: bob.userId, roles: ['viewer'] });
  expect((await call(alice.cookie, 'PATCH', `${P}/me`, { jobTitle: 'Producer', bio: 'Alice bio', contact: { location: 'Lisbon', links: [] } })).status).toBe(200);
  expect((await call(bob.cookie, 'PATCH', `${P}/me`, { jobTitle: 'Roaster', bio: 'Bob bio' })).status).toBe(200);
  expect((await call(bob.cookie, 'PUT', `${P}/me/skills`, { skills: [{ name: 'Espresso', proficiency: 4 }] })).status).toBe(200);
  return { ws, alice, bob, aliceWs: await switchInto(alice, ws), bobWs: await switchInto(bob, ws) };
}
const ids = (r: Res): string[] => (r.body.profiles as Array<{ userId: string }>).map((p) => p.userId);

describe('ADR 0888 D1 — a shared workspace lists the people who chose to be seen', () => {
  it('never lists a member who did not share, and lists a co-member who shared', async () => {
    const { alice, bob, aliceWs, bobWs, ws } = await team();
    const before = await call(aliceWs, 'GET', P);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ scope: 'workspace', workspaceId: ws, sharedByMe: false, truncated: false });
    expect(ids(before)).not.toContain(bob.userId); // consent: no share, no listing
    expect((await call(aliceWs, 'GET', `${P}/${encodeURIComponent(bob.userId)}`)).status).toBe(404);

    const share = await call(bobWs, 'PUT', `${P}/me/workspace-share`);
    expect(share.status, JSON.stringify(share.body)).toBe(200);
    expect(share.body.sharedWorkspaceIds).toEqual([ws]);

    const after = await call(aliceWs, 'GET', P);
    expect(ids(after)).toEqual([bob.userId]);
    const row = after.body.profiles[0];
    expect(row.jobTitle).toBe('Roaster');
    expect(row.workflows).toEqual([]); // home-tenant workflow ids do not resolve here
    expect(row.skills[0].endorsements).toEqual({ count: 0, endorsedByMe: false, endorserUserIds: [] });
    const one = await call(aliceWs, 'GET', `${P}/${encodeURIComponent(bob.userId)}`);
    expect(one.status).toBe(200);
    expect(one.body.userId).toBe(bob.userId);
    // Bob's own directory says he is sharing; Alice's home directory is untouched.
    expect((await call(bobWs, 'GET', P)).body.sharedByMe).toBe(true);
    expect(ids(await call(alice.cookie, 'GET', P))).not.toContain(bob.userId);
  });

  it('un-sharing hides the person on the next read; the endpoint is self-only', async () => {
    const { bob, aliceWs, bobWs, ws } = await team();
    await call(bobWs, 'PUT', `${P}/me/workspace-share`);
    expect(ids(await call(aliceWs, 'GET', P))).toContain(bob.userId);
    const un = await call(bob.cookie, 'DELETE', `${P}/me/workspace-share/${encodeURIComponent(ws)}`);
    expect(un.status).toBe(200);
    expect(un.body.sharedWorkspaceIds).toEqual([]);
    expect(ids(await call(aliceWs, 'GET', P))).not.toContain(bob.userId);
  });

  it('a member who left the workspace disappears without any write', async () => {
    const { bob, aliceWs, bobWs, ws } = await team();
    await call(bobWs, 'PUT', `${P}/me/workspace-share`);
    const m = (await listMembers(ws, ws)).find((x) => x.subject === bob.userId)!;
    await deleteMember(m.memberId);
    expect(ids(await call(aliceWs, 'GET', P))).not.toContain(bob.userId);
    expect((await call(aliceWs, 'GET', `${P}/${encodeURIComponent(bob.userId)}`)).status).toBe(404);
  });

  it('PROF2CD-1 — a departed sharer costs no deployment-wide member scan', async () => {
    const { bob, aliceWs, bobWs, ws } = await team();
    await call(bobWs, 'PUT', `${P}/me/workspace-share`);
    const m = (await listMembers(ws, ws)).find((x) => x.subject === bob.userId)!;
    await deleteMember(m.memberId);
    const scanned: string[] = [];
    const orig = DurableCollection.prototype.list;
    const spy = vi.spyOn(DurableCollection.prototype, 'list').mockImplementation(function (this: DurableCollection<unknown>, ...args: unknown[]) {
      scanned.push((this as unknown as { name: string }).name);
      return (orig as (...a: unknown[]) => Promise<unknown[]>).apply(this, args);
    } as typeof orig);
    try {
      expect(ids(await call(aliceWs, 'GET', P))).not.toContain(bob.userId);
      expect((await call(aliceWs, 'GET', `${P}/${encodeURIComponent(bob.userId)}`)).status).toBe(404);
    } finally {
      spy.mockRestore();
    }
    expect(scanned.filter((n) => n === 'access-members')).toEqual([]);
  });

  it('PROF2CD-3 — a share proved under a pre-bind subject survives the member re-key to the userId', async () => {
    const { bob, aliceWs, ws } = await team();
    // Bob shared while his member row was keyed by his unbound principal; the bind
    // re-keyed it to his userId, so the stored subject no longer matches any row.
    await putShare({ workspaceId: ws, userId: bob.userId, memberSubject: 'oidc:pre-bind-bob', sharedAt: new Date().toISOString() });
    expect(ids(await call(aliceWs, 'GET', P))).toContain(bob.userId);
  });

  it('two IdPs, one principal string: a share is never matched to a DIFFERENT person\'s member row', async () => {
    const { ws, aliceWs } = await team();
    const x = await person('x'); // NOT a member of ws
    await call(x.cookie, 'PATCH', `${P}/me`, { jobTitle: 'Outsider' });
    // X's (legacy) share row carries X's own principal from IdP A; a DIFFERENT
    // human from IdP B holds a root membership under the same raw string.
    await putShare({ workspaceId: ws, userId: x.userId, memberSubject: 'scim:jsmith', sharedAt: new Date().toISOString() });
    await createMember({ orgId: ws, tenantId: ws, displayName: 'J Smith (IdP B)', subject: 'scim:jsmith', roles: ['viewer'] });
    expect(ids(await call(aliceWs, 'GET', P))).not.toContain(x.userId);
    expect((await call(aliceWs, 'GET', `${P}/${encodeURIComponent(x.userId)}`)).status).toBe(404);
  });

  it('a workspace erasure keyed by the bound id that proved membership still removes the row', async () => {
    const { ws, bob, bobWs } = await team();
    await call(bobWs, 'PUT', `${P}/me/workspace-share`);
    const { eraseWorkspaceShare } = await import('../src/features/profiles/directory.js');
    // Simulate the split account: the row's memberSubject differs from its userId.
    await putShare({ workspaceId: ws, userId: bob.userId, memberSubject: 'user:bound-alias-of-bob', sharedAt: new Date().toISOString() });
    expect(await eraseWorkspaceShare(ws, 'user:bound-alias-of-bob')).toEqual({ rowsTouched: 1 });
    expect(await __rawWorkspaceShares(ws)).toEqual([]);
  });

  it('sharing is refused outside a shared workspace (home tenant)', async () => {
    const p = await person('solo');
    const r = await call(p.cookie, 'PUT', `${P}/me/workspace-share`);
    expect(r.status).toBe(409);
    expect(r.body.details).toMatchObject({ reason: 'not_in_a_shared_workspace' });
  });

  it('endorsing from a workspace is refused (the write would escape that workspace\'s erasure)', async () => {
    const { bob, aliceWs, bobWs } = await team();
    await call(bobWs, 'PUT', `${P}/me/workspace-share`);
    const r = await call(aliceWs, 'POST', `${P}/${encodeURIComponent(bob.userId)}/skills/Espresso/endorse`);
    expect(r.status).toBe(409);
    expect(r.body.details).toMatchObject({ reason: 'endorse_unavailable_here' });
  });

  it('a workspace root WITHOUT the `ws:` prefix (a feature default workspace) is a workspace too', async () => {
    const root = `host-adr0888-${n++}`;
    await ensureWorkspaceRootOrg({ orgId: root, tenantId: root, name: 'Default WS', createdBy: 'system' });
    const alice = await person('ha');
    const bob = await person('hb');
    await createMember({ orgId: root, tenantId: root, displayName: 'Alice', subject: alice.userId, roles: ['editor'] });
    await createMember({ orgId: root, tenantId: root, displayName: 'Bob', subject: bob.userId, roles: ['editor'] });
    await call(bob.cookie, 'PATCH', `${P}/me`, { jobTitle: 'Barista' });
    const aliceWs = await switchInto(alice, root);
    const bobWs = await switchInto(bob, root);
    expect((await call(aliceWs, 'GET', P)).body).toMatchObject({ scope: 'workspace', workspaceId: root });
    await call(bobWs, 'PUT', `${P}/me/workspace-share`);
    expect(ids(await call(aliceWs, 'GET', P))).toEqual([bob.userId]);
  });
});

describe('ADR 0888 D2 — the peer view is an allowlist', () => {
  it('pins, knowledge pointers, share list and bookkeeping never reach a peer', async () => {
    const T = `org:adr0888-${Date.now()}-${n++}`;
    const login = async (email: string): Promise<{ cookie: string; userId: string }> => {
      const res = await fetch(`${BASE}/host/openwop-app/test/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, tenantId: T }) });
      const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const { user } = (await res.json()) as { user: { userId: string } };
      return { cookie, userId: user.userId };
    };
    const alice = await login(`a-${n}@acme.test`);
    const bob = await login(`b-${n}@acme.test`);
    await createMember({ tenantId: T, orgId: T, subject: bob.userId, displayName: 'Bob', roles: ['viewer'] });
    await call(alice.cookie, 'PATCH', `${P}/me`, { jobTitle: 'Producer' });
    const own = await call(alice.cookie, 'GET', `${P}/me`);
    for (const k of ['pinnedAgentIds', 'pinnedChatAgentIds', 'tenantId']) expect(k in own.body, `own view keeps ${k}`).toBe(true);
    const one = await call(bob.cookie, 'GET', `${P}/${encodeURIComponent(alice.userId)}`);
    expect(one.status).toBe(200);
    const dir = await call(bob.cookie, 'GET', P);
    const row = (dir.body.profiles as Array<Record<string, unknown>>).find((p) => p.userId === alice.userId)!;
    for (const view of [one.body, row]) {
      for (const k of ['pinnedAgentIds', 'pinnedChatAgentIds', 'knowledge', 'sharedWorkspaceIds', 'updatedBy', 'tenantId', 'completenessMissing']) {
        expect(k in view, k).toBe(false);
      }
      expect(view.jobTitle).toBe('Producer');
    }
  });
});

describe('ADR 0888 D3 — the run lane has the route\'s floor', () => {
  it('RATCHET — EVERY ctx.features.profiles method refuses a run with no acting user (a new method cannot skip the predicate)', async () => {
    const s = buildProfilesSurface({ tenantId: 'org:adr0888-ratchet' });
    const methods = Object.keys(s);
    expect(methods.length).toBeGreaterThan(0);
    for (const m of methods) {
      const fn = (s as Record<string, (a: Record<string, unknown>) => Promise<unknown>>)[m]!;
      await expect(fn({ userId: 'user:any' }), m).rejects.toMatchObject({ code: 'forbidden_scope', details: { reason: 'no_acting_user' } });
    }
  });

  it('a run with no acting user is refused (named reason), never served the directory', async () => {
    const s = buildProfilesSurface({ tenantId: 'org:adr0888-run' });
    await expect(s.listProfiles!({})).rejects.toMatchObject({ code: 'forbidden_scope', details: { reason: 'no_acting_user' } });
    await expect(s.getProfile!({ userId: 'user:x' })).rejects.toMatchObject({ code: 'forbidden_scope' });
  });
  it('an API key / anonymous actor is refused', async () => {
    for (const actingUserId of ['apikey:k1', 'session:s1', 'oidc:unbound']) {
      const s = buildProfilesSurface({ tenantId: 'org:adr0888-run', actingUserId });
      await expect(s.listProfiles!({}), actingUserId).rejects.toMatchObject({ code: 'forbidden_scope', details: { reason: 'not_a_durable_user' } });
    }
  });
  it('a non-member and a disabled member are refused', async () => {
    const { ws, alice } = await team();
    const stranger = await person('stranger');
    await expect(buildProfilesSurface({ tenantId: ws, actingUserId: stranger.userId }).listProfiles!({}))
      .rejects.toMatchObject({ code: 'forbidden_scope', details: { reason: 'not_a_member' } });
    await setUserStatus(alice.userId, 'disabled', { reason: 'admin' });
    await expect(buildProfilesSurface({ tenantId: ws, actingUserId: alice.userId }).listProfiles!({}))
      .rejects.toMatchObject({ code: 'forbidden_scope', details: { reason: 'acting_user_disabled' } });
  });
  it('a member\'s run sees the SAME people the route shows, without bio, contact or asset tokens', async () => {
    const { ws, alice, bob, bobWs, aliceWs } = await team();
    await call(bobWs, 'PUT', `${P}/me/workspace-share`);
    await call(aliceWs, 'PUT', `${P}/me/workspace-share`);
    const route = ids(await call(aliceWs, 'GET', P)).sort();
    const run = await buildProfilesSurface({ tenantId: ws, actingUserId: alice.userId }).listProfiles!({}) as { profiles: Array<Record<string, unknown>> };
    expect(run.profiles.map((p) => p.userId as string).sort()).toEqual(route);
    for (const p of run.profiles) {
      for (const k of ['bio', 'contact', 'avatarAssetToken', 'portfolioAssetTokens', 'pinnedAgentIds', 'knowledge', 'tenantId']) expect(k in p, k).toBe(false);
    }
    const got = await buildProfilesSurface({ tenantId: ws, actingUserId: alice.userId }).getProfile!({ userId: bob.userId }) as { found: boolean };
    expect(got.found).toBe(true);
    // Home lane: Alice's own personal tenant.
    const home = await buildProfilesSurface({ tenantId: alice.tenantId, actingUserId: alice.userId }).listProfiles!({}) as { profiles: Array<{ userId: string }> };
    expect(home.profiles.map((p) => p.userId)).toContain(alice.userId);
  });
});

describe('ADR 0888 — erasure and retention reach', () => {
  it('erasure removes the share (home-tenant eraser) and the workspace eraser removes its own row', async () => {
    const { ws, bob, aliceWs, bobWs } = await team();
    await call(bobWs, 'PUT', `${P}/me/workspace-share`);
    expect(ids(await call(aliceWs, 'GET', P))).toContain(bob.userId);
    await eraseSubject(ws, bob.userId); // an erasure run IN the workspace
    expect(ids(await call(aliceWs, 'GET', P))).not.toContain(bob.userId);
    expect(await __rawWorkspaceShares(ws)).toEqual([]);

    const t2 = await team();
    await call(t2.bobWs, 'PUT', `${P}/me/workspace-share`);
    const { profileEraser } = await import('../src/features/profiles/profilesService.js');
    expect((await __rawWorkspaceShares(t2.ws)).map((r) => r.userId)).toEqual([t2.bob.userId]);
    await profileEraser(t2.bob.tenantId, t2.bob.userId); // the home-tenant eraser
    expect(ids(await call(t2.aliceWs, 'GET', P))).not.toContain(t2.bob.userId);
    // The ROW is gone, not merely hidden by the read path (a dangling row still
    // holds the person's id and membership subject).
    expect(await __rawWorkspaceShares(t2.ws)).toEqual([]);
  });

  it('retention reclaims the avatar bytes it un-references', async () => {
    const p = await person('rt');
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const up = await call(p.cookie, 'POST', '/host/openwop-app/media/upload', { contentBase64: PNG, contentType: 'image/png', name: 'a.png' });
    expect(up.status).toBe(201);
    const token = up.body.token as string;
    expect((await call(p.cookie, 'PUT', `${P}/me/avatar`, { token })).status).toBe(200);
    const out = await purgeRetained(p.tenantId, 'confidential-pii', new Date(Date.now() + 60_000).toISOString());
    expect(out.find((r) => r.feature === 'profiles')?.deleted).toBe(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    try {
      expect((await fetch(`${BASE}/host/openwop-app/assets/${encodeURIComponent(token)}`, { headers: { cookie: p.cookie } })).status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ADR 0888 D5 — avatar types are the ones the exit renders inline', () => {
  it('raster images pass; attachment-served image types and active types do not', () => {
    for (const t of ['image/png', 'image/jpeg', 'IMAGE/WEBP; charset=x', 'image/gif', 'image/avif']) expect(isInlineImageType(t), t).toBe(true);
    for (const t of ['image/tiff', 'image/heic', 'image/bmp', 'image/svg+xml', 'text/html', '', undefined]) expect(isInlineImageType(t), String(t)).toBe(false);
  });
});

describe('SOUND on origin/main (kept as regression)', () => {
  it('an unauthenticated caller cannot read the directory', async () => {
    expect([401, 403]).toContain((await call('', 'GET', P)).status);
  });
});
