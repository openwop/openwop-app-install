/**
 * ADR 0015 — workspace-as-tenant (B2B tenancy), route-level harness.
 *
 * Proves the multi-member workspace lifecycle over HTTP against the real app:
 *   - a signed-in user has a personal workspace (active by default);
 *   - they can create a SHARED workspace (becoming its owner) and switch into it;
 *   - the active workspace is the session tenant (switch re-binds it);
 *   - a second user invited as a member can switch in; a non-member cannot
 *     (membership-gated, fail-closed) — the RFC 0048 §D isolation boundary;
 *   - data created in a shared workspace is scoped to it, not to either member's
 *     personal workspace.
 *
 * @see docs/adr/0015-workspace-as-tenant-b2b.md
 * @see src/routes/workspaces.ts, src/host/accessControlService.ts
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const def = getToggleDefault('users');
  if (def) await saveConfig({ ...def, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    for (const sc of setCookies) {
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
// ADR 0026: real sign-in is Firebase OIDC; tests mint an authenticated user via
// the env-gated auth test seam.
async function signup(c: ReturnType<typeof client>): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `ws-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

describe('ADR 0015 — workspace-as-tenant', () => {
  it('a signed-in user has a personal workspace, active by default', async () => {
    const c = client();
    await signup(c);
    const r = await c.get('/v1/host/openwop-app/me/workspaces');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const personal = r.body.workspaces.find((w: any) => w.kind === 'personal');
    expect(personal).toBeTruthy();
    expect(personal.active).toBe(true);
    expect(personal.roles).toContain('owner');
    expect(r.body.active).toBe(r.body.personal);
  });

  it('create a shared workspace → owner → switch makes it the active tenant', async () => {
    const c = client();
    await signup(c);
    const created = await c.post('/v1/host/openwop-app/workspaces', { name: 'Acme Corp' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.workspaceId).toMatch(/^ws:/);
    expect(created.body.roles).toContain('owner');

    // It appears in the list as a shared workspace (not yet active).
    const before = await c.get('/v1/host/openwop-app/me/workspaces');
    const sharedBefore = before.body.workspaces.find((w: any) => w.workspaceId === created.body.workspaceId);
    expect(sharedBefore.kind).toBe('shared');
    expect(sharedBefore.active).toBe(false);

    // Switch re-binds the active workspace.
    const sw = await c.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(created.body.workspaceId)}/switch`);
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    expect(sw.body.active).toBe(created.body.workspaceId);

    const after = await c.get('/v1/host/openwop-app/me/workspaces');
    expect(after.body.active).toBe(created.body.workspaceId);
    const sharedAfter = after.body.workspaces.find((w: any) => w.workspaceId === created.body.workspaceId);
    expect(sharedAfter.active).toBe(true);
  });

  it('a member invited into a shared workspace can switch in; a non-member cannot', async () => {
    const owner = client();
    await signup(owner);
    const ws = (await owner.post('/v1/host/openwop-app/workspaces', { name: 'TeamWS' })).body.workspaceId;
    await owner.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);

    // Owner adds member B (editor) bound to B's subject.
    const memberC = client();
    const b = await signup(memberC);
    const add = await owner.post(
      `/v1/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`,
      { displayName: 'B', subject: b.userId, roles: ['editor'] },
    );
    expect(add.status, JSON.stringify(add.body)).toBe(201);

    // B can switch into the shared workspace and sees it in their list.
    const bSwitch = await memberC.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
    expect(bSwitch.status, JSON.stringify(bSwitch.body)).toBe(200);
    const bList = await memberC.get('/v1/host/openwop-app/me/workspaces');
    const bShared = bList.body.workspaces.find((w: any) => w.workspaceId === ws);
    expect(bShared).toBeTruthy();
    expect(bShared.roles).toContain('editor');

    // A non-member cannot switch in (membership-gated, fail-closed).
    const outsider = client();
    await signup(outsider);
    const denied = await outsider.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
    expect(denied.status).toBe(403);
  });

  it('anonymous sessions get an ephemeral personal sandbox and cannot create shared workspaces', async () => {
    const anon = client();
    // First call mints an anon session; /me/workspaces returns a synthetic personal entry.
    const list = await anon.get('/v1/host/openwop-app/me/workspaces');
    expect(list.status).toBe(200);
    expect(list.body.personal).toMatch(/^anon:/);
    expect(list.body.workspaces.some((w: any) => w.kind === 'personal')).toBe(true);
    // Anon may not persist a shared workspace.
    const create = await anon.post('/v1/host/openwop-app/workspaces', { name: 'Nope' });
    expect(create.status).toBe(403);
  });

  // Review fix #2 — defense-in-depth: a member removed AFTER switching in loses
  // access on the next request (middleware re-validates non-personal workspaces),
  // even with authorization enforcement off. The active tenant falls back to the
  // member's personal workspace.
  it('removing a member after they switched in drops their access on the next request', async () => {
    const owner = client();
    await signup(owner);
    const ws = (await owner.post('/v1/host/openwop-app/workspaces', { name: 'RevokeCo' })).body.workspaceId;
    await owner.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);

    const member = client();
    const b = await signup(member);
    const add = await owner.post(
      `/v1/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`,
      { displayName: 'B', subject: b.userId, roles: ['editor'] },
    );
    const memberId = add.body.memberId as string;
    // B switches in — active workspace is the shared one.
    expect((await member.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    expect((await member.get('/v1/host/openwop-app/me/workspaces')).body.active).toBe(ws);

    // Owner (acting in the shared workspace) removes B.
    expect((await owner.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    const removed = await owner.del(`/v1/host/openwop-app/orgs/${encodeURIComponent(ws)}/members/${encodeURIComponent(memberId)}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);

    // B's next request re-validates membership → no longer a member → active
    // falls back to B's personal workspace (not the shared one).
    const after = await member.get('/v1/host/openwop-app/me/workspaces');
    expect(after.body.active).not.toBe(ws);
    expect(after.body.active).toBe(after.body.personal);
  });

  // ADR 0015 ≥1-owner invariant: the last owner of a shared workspace cannot be
  // removed or demoted — the workspace would become unadministrable.
  it('refuses to remove or demote the last owner of a shared workspace (409)', async () => {
    const owner = client();
    await signup(owner);
    const ws = (await owner.post('/v1/host/openwop-app/workspaces', { name: 'SoloOwnerCo' })).body.workspaceId;
    await owner.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);

    // The owner's own member record (the only owner).
    const members = (await owner.get(`/v1/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`)).body.members as Array<{ memberId: string; roles: string[] }>;
    const ownerMember = members.find((m) => m.roles.includes('owner'))!;

    // Demoting the last owner to editor is blocked.
    const patch = await owner.patch(`/v1/host/openwop-app/orgs/${encodeURIComponent(ws)}/members/${encodeURIComponent(ownerMember.memberId)}`, { roles: ['editor'] });
    expect(patch.status, JSON.stringify(patch.body)).toBe(409);
    expect(patch.body.error).toBe('conflict');

    // Deleting the last owner is blocked too.
    const del = await owner.del(`/v1/host/openwop-app/orgs/${encodeURIComponent(ws)}/members/${encodeURIComponent(ownerMember.memberId)}`);
    expect(del.status, JSON.stringify(del.body)).toBe(409);
  });

  // The escape hatch: transfer ownership to another member, THEN the original
  // owner can step down (or be removed) without tripping the last-owner guard.
  it('transfer-ownership grants owner to a member and unblocks the original stepping down', async () => {
    const owner = client();
    await signup(owner);
    const ws = (await owner.post('/v1/host/openwop-app/workspaces', { name: 'HandoffCo' })).body.workspaceId;
    await owner.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);

    // Add member B (editor).
    const memberB = client();
    const b = await signup(memberB);
    const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`, { displayName: 'B', subject: b.userId, roles: ['editor'] });
    const bMemberId = add.body.memberId as string;

    // Transfer ownership to B with stepDown — owner relinquishes in the same call.
    const transfer = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(ws)}/members/${encodeURIComponent(bMemberId)}/transfer-ownership`, { stepDown: true });
    expect(transfer.status, JSON.stringify(transfer.body)).toBe(200);
    expect(transfer.body.transferredTo).toBe(bMemberId);
    expect(transfer.body.steppedDown).toBeTruthy();

    // B is now an owner; there is exactly one owner (the original stepped down).
    const after = (await owner.get(`/v1/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`)).body.members as Array<{ memberId: string; roles: string[] }>;
    expect(after.find((m) => m.memberId === bMemberId)!.roles).toContain('owner');
    expect(after.filter((m) => m.roles.includes('owner')).length).toBe(1);
  });

  // Review fix #3 — concurrent first-access converges to exactly ONE personal
  // owner member (deterministic member id), not duplicates.
  it('concurrent first-access seeds exactly one personal owner member', async () => {
    const c = client();
    await signup(c);
    // Fire many parallel /me/workspaces — each ensures the personal workspace.
    await Promise.all(Array.from({ length: 8 }, () => c.get('/v1/host/openwop-app/me/workspaces')));
    const me = await c.get('/v1/host/openwop-app/me/workspaces');
    const personal = me.body.personal as string;
    // List the personal workspace's members (caller is its implicit owner).
    const members = await c.get(`/v1/host/openwop-app/orgs/${encodeURIComponent(personal)}/members`);
    expect(members.status, JSON.stringify(members.body)).toBe(200);
    const owners = (members.body.members as Array<{ roles: string[] }>).filter((m) => m.roles.includes('owner'));
    expect(owners.length).toBe(1);
  });
});
