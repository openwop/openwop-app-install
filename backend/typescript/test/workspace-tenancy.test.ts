/**
 * ADR 0015 — workspace-as-tenant (B2B tenancy), route-level harness.
 *
 * Proves the multi-member workspace lifecycle over HTTP against the real app:
 *   - a signed-in user has a personal workspace (active by default);
 *   - they can create a SHARED workspace (becoming its owner) and switch into it;
 *   - the active workspace is the session tenant (switch re-binds it);
 *   - a second user invited as a member can switch in; a non-member cannot
 *     (membership-gated, fail-closed) — the RFC 0048 §D isolation boundary;
 *   - a member removed after switching in falls back to their personal workspace;
 *   - the ≥1-owner invariant, and transfer-ownership as its escape hatch.
 * (CORRECTED wave 64: this header also claimed "data created in a shared workspace is
 * scoped to it" — no case here asserts that; the claim is removed, not tested.)
 *
 * Sabotage-witnessed (wave 64, probes 8fw5g1-wt-*): the switch membership gate, the
 * anonymous-create refusal, both last-owner guards, and the HTTP middleware's
 * per-request membership re-check (wt-revalidate-mw). The SECOND copy of that re-check
 * (`resolveLiveCookieSession`, middleware/auth.ts) serves the collab WebSocket lane,
 * which no case here reaches — its witness is adr0833-collab-live-session.test.ts
 * ("a member REMOVED from the workspace is refused (403)", wt-revalidate-resolver-r2).
 * The concurrency case is NOT a forced race (parallel GETs need not interleave); the
 * guard it relies on is the deterministic owner-member id.
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
import { getSetCookies } from './headerCookies.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const def = getToggleDefault('users');
  if (def) await saveConfig({ ...def, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

/** Response bodies, typed at the call site (narrow local views of the route payloads). */
interface WorkspaceEntry { workspaceId: string; kind: 'personal' | 'shared'; active: boolean; roles: string[] }
interface WorkspacesBody { workspaces: WorkspaceEntry[]; active: string; personal: string }
interface CreatedBody { workspaceId: string; roles: string[] }
interface MemberRow { memberId: string; roles: string[] }
interface ErrorBody { error?: string; message?: string; details?: Record<string, unknown> }

interface Res<T> { status: number; body: T }
interface Client {
  get: <T>(p: string) => Promise<Res<T>>;
  post: <T>(p: string, b?: unknown) => Promise<Res<T>>;
  patch: <T>(p: string, b?: unknown) => Promise<Res<T>>;
  del: <T>(p: string) => Promise<Res<T>>;
}
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const sc of getSetCookies(res.headers)) {
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1]!;
    }
    // The one typed boundary: each call site names the body shape it reads.
    const out = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
// ADR 0026: real sign-in is Firebase OIDC; tests mint an authenticated user via
// the env-gated auth test seam.
async function signup(c: Client): Promise<{ userId: string }> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `ws-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const myWorkspaces = (c: Client) => c.get<WorkspacesBody>('/host/openwop-app/me/workspaces');
const wsPath = (ws: string) => `/host/openwop-app/workspaces/${encodeURIComponent(ws)}`;
const orgMembers = (ws: string) => `/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`;
async function sharedWorkspace(owner: Client, name: string): Promise<string> {
  const created = await owner.post<CreatedBody>('/host/openwop-app/workspaces', { name });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await owner.post(`${wsPath(created.body.workspaceId)}/switch`)).status).toBe(200);
  return created.body.workspaceId;
}

describe('ADR 0015 — workspace-as-tenant', () => {
  it('a signed-in user has a personal workspace, active by default', async () => {
    const c = client();
    await signup(c);
    const r = await myWorkspaces(c);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const personal = r.body.workspaces.find((w) => w.kind === 'personal');
    expect(personal).toBeTruthy();
    expect(personal!.active).toBe(true);
    expect(personal!.roles).toContain('owner');
    expect(r.body.active).toBe(r.body.personal);
  });

  it('create a shared workspace → owner → switch makes it the active tenant', async () => {
    const c = client();
    await signup(c);
    const created = await c.post<CreatedBody>('/host/openwop-app/workspaces', { name: 'Acme Corp' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.workspaceId).toMatch(/^ws:/);
    expect(created.body.roles).toContain('owner');

    // It appears in the list as a shared workspace (not yet active).
    const before = await myWorkspaces(c);
    const sharedBefore = before.body.workspaces.find((w) => w.workspaceId === created.body.workspaceId);
    expect(sharedBefore?.kind).toBe('shared');
    expect(sharedBefore?.active).toBe(false);

    // Switch re-binds the active workspace.
    const sw = await c.post<{ active: string }>(`${wsPath(created.body.workspaceId)}/switch`);
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    expect(sw.body.active).toBe(created.body.workspaceId);

    const after = await myWorkspaces(c);
    expect(after.body.active).toBe(created.body.workspaceId);
    expect(after.body.workspaces.find((w) => w.workspaceId === created.body.workspaceId)?.active).toBe(true);
  });

  it('a member invited into a shared workspace can switch in; a non-member cannot', async () => {
    const owner = client();
    await signup(owner);
    const ws = await sharedWorkspace(owner, 'TeamWS');

    // Owner adds member B (editor) bound to B's subject.
    const memberC = client();
    const b = await signup(memberC);
    const add = await owner.post(orgMembers(ws), { displayName: 'B', subject: b.userId, roles: ['editor'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);

    // B can switch into the shared workspace and sees it in their list.
    const bSwitch = await memberC.post(`${wsPath(ws)}/switch`);
    expect(bSwitch.status, JSON.stringify(bSwitch.body)).toBe(200);
    const bShared = (await myWorkspaces(memberC)).body.workspaces.find((w) => w.workspaceId === ws);
    expect(bShared).toBeTruthy();
    expect(bShared!.roles).toContain('editor');

    // A non-member cannot switch in (membership-gated, fail-closed) — the gate's own
    // refusal, and the outsider stays in their personal workspace.
    const outsider = client();
    await signup(outsider);
    const denied = await outsider.post<ErrorBody>(`${wsPath(ws)}/switch`);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: 'forbidden', message: 'You are not a member of that workspace.' });
    const outsiderView = await myWorkspaces(outsider);
    expect(outsiderView.body.active).toBe(outsiderView.body.personal);
  });

  it('anonymous sessions get an ephemeral personal sandbox and cannot create shared workspaces', async () => {
    const anon = client();
    // First call mints an anon session; /me/workspaces returns a synthetic personal entry.
    const list = await myWorkspaces(anon);
    expect(list.status).toBe(200);
    expect(list.body.personal).toMatch(/^anon:/);
    expect(list.body.workspaces.some((w) => w.kind === 'personal')).toBe(true);
    // Anon may not persist a shared workspace.
    const create = await anon.post<ErrorBody>('/host/openwop-app/workspaces', { name: 'Nope' });
    expect(create.status).toBe(403);
    expect(create.body).toMatchObject({ error: 'forbidden', message: 'Sign in to create a shared workspace (anonymous sessions are ephemeral).' });
  });

  // Review fix #2 — defense-in-depth: a member removed AFTER switching in loses
  // access on the next request (middleware re-validates non-personal workspaces),
  // even with authorization enforcement off. The active tenant falls back to the
  // member's personal workspace.
  it('removing a member after they switched in drops their access on the next request', async () => {
    const owner = client();
    await signup(owner);
    const ws = await sharedWorkspace(owner, 'RevokeCo');

    const member = client();
    const b = await signup(member);
    const add = await owner.post<{ memberId: string }>(orgMembers(ws), { displayName: 'B', subject: b.userId, roles: ['editor'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    const memberId = add.body.memberId;
    // B switches in — active workspace is the shared one.
    expect((await member.post(`${wsPath(ws)}/switch`)).status).toBe(200);
    expect((await myWorkspaces(member)).body.active).toBe(ws);

    // Owner (acting in the shared workspace) removes B.
    expect((await owner.post(`${wsPath(ws)}/switch`)).status).toBe(200);
    const removed = await owner.del(`${orgMembers(ws)}/${encodeURIComponent(memberId)}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);

    // B's next request re-validates membership → no longer a member → active
    // falls back to B's personal workspace (not the shared one).
    const after = await myWorkspaces(member);
    expect(after.body.active).not.toBe(ws);
    expect(after.body.active).toBe(after.body.personal);
  });

  // ADR 0015 ≥1-owner invariant: the last owner of a shared workspace cannot be
  // removed or demoted — the workspace would become unadministrable.
  it('refuses to remove or demote the last owner of a shared workspace (409)', async () => {
    const owner = client();
    await signup(owner);
    const ws = await sharedWorkspace(owner, 'SoloOwnerCo');

    // The owner's own member record (the only owner).
    const members = (await owner.get<{ members: MemberRow[] }>(orgMembers(ws))).body.members;
    const ownerMember = members.find((m) => m.roles.includes('owner'))!;
    const LAST_OWNER = { error: 'conflict', details: { reason: 'last_owner' } };

    // Demoting the last owner to editor is blocked.
    const patch = await owner.patch<ErrorBody>(`${orgMembers(ws)}/${encodeURIComponent(ownerMember.memberId)}`, { roles: ['editor'] });
    expect(patch.status, JSON.stringify(patch.body)).toBe(409);
    expect(patch.body).toMatchObject(LAST_OWNER);

    // Deleting the last owner is blocked too.
    const del = await owner.del<ErrorBody>(`${orgMembers(ws)}/${encodeURIComponent(ownerMember.memberId)}`);
    expect(del.status, JSON.stringify(del.body)).toBe(409);
    expect(del.body).toMatchObject(LAST_OWNER);
    // …and the owner is still the owner.
    const still = (await owner.get<{ members: MemberRow[] }>(orgMembers(ws))).body.members;
    expect(still.find((m) => m.memberId === ownerMember.memberId)?.roles).toContain('owner');
  });

  // The escape hatch: transfer ownership to another member, THEN the original
  // owner can step down (or be removed) without tripping the last-owner guard.
  it('transfer-ownership grants owner to a member and unblocks the original stepping down', async () => {
    const owner = client();
    await signup(owner);
    const ws = await sharedWorkspace(owner, 'HandoffCo');

    // Add member B (editor).
    const memberB = client();
    const b = await signup(memberB);
    const add = await owner.post<{ memberId: string }>(orgMembers(ws), { displayName: 'B', subject: b.userId, roles: ['editor'] });
    const bMemberId = add.body.memberId;

    // Transfer ownership to B with stepDown — owner relinquishes in the same call.
    const transfer = await owner.post<{ transferredTo: string; steppedDown: unknown }>(`${orgMembers(ws)}/${encodeURIComponent(bMemberId)}/transfer-ownership`, { stepDown: true });
    expect(transfer.status, JSON.stringify(transfer.body)).toBe(200);
    expect(transfer.body.transferredTo).toBe(bMemberId);
    expect(transfer.body.steppedDown).toBeTruthy();

    // B is now an owner; there is exactly one owner (the original stepped down).
    const after = (await owner.get<{ members: MemberRow[] }>(orgMembers(ws))).body.members;
    expect(after.find((m) => m.memberId === bMemberId)!.roles).toContain('owner');
    expect(after.filter((m) => m.roles.includes('owner')).length).toBe(1);
  });

  // Review fix #3 — concurrent first-access converges to exactly ONE personal
  // owner member (deterministic member id), not duplicates. Not a forced race:
  // the parallel GETs need not interleave; the deterministic id is the guard.
  it('concurrent first-access seeds exactly one personal owner member', async () => {
    const c = client();
    await signup(c);
    // Fire many parallel /me/workspaces — each ensures the personal workspace.
    await Promise.all(Array.from({ length: 8 }, () => myWorkspaces(c)));
    const personal = (await myWorkspaces(c)).body.personal;
    // List the personal workspace's members (caller is its implicit owner).
    const members = await c.get<{ members: MemberRow[] }>(orgMembers(personal));
    expect(members.status, JSON.stringify(members.body)).toBe(200);
    expect(members.body.members.filter((m) => m.roles.includes('owner')).length).toBe(1);
  });
});
