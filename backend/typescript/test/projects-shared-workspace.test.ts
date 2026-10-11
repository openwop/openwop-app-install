/**
 * PRJC-5 — the ADR 0508 acceptance criterion, applied to PROJECTS.
 *
 * WHY A NEW FILE. Every projects test logs in with an explicit `org:`-string
 * tenant through the auth seam, so HOME == ACTIVE *by construction* and the
 * harness is structurally incapable of observing a HOME-vs-ACTIVE tenant
 * defect (the class that was live on CRM's 95 sites and on the twin). This
 * suite goes through the PRODUCTION path only — sign in with no tenant
 * override (personal `user:` tenant, as Firebase OIDC leaves it), create a
 * real `ws:` shared workspace, switch into it, invite a second human by email,
 * accept the invite. No `createMember` back door, so `personalTenant` is
 * genuinely distinct from the active tenant.
 *
 * BOTH POLARITIES, CONTENT AS WELL AS STATUS: a cheerful 201 filed under the
 * author's home tenant is exactly what a status-only test cannot distinguish.
 * Covers: create (filed under the WORKSPACE), list (member B sees A's project),
 * write (B's patch lands in the shared partition), private-visibility withheld
 * from a non-member viewer, private-membership read regained (membership never
 * granting write), and the outsider / cross-workspace refusals. A refused
 * write is asserted on the stored row too, not only on its status.
 *
 * Sabotage-witnessed (grade-tests w13): routing `tenantOf` through
 * `req.personalTenant` (the HOME-vs-ACTIVE defect) reds cases 1–3; dropping the
 * `visibility === 'org'` guard, matching the single-prefixed member ref, or
 * granting `write` to a private member each reds case 3.
 * HONEST CEILING — case 4 is a DOUBLE guard: the tenant partition
 * (`getProject`'s tenant check) and org membership (`resolveEffectiveAccess`:
 * no member row ⇒ zero scopes outside demo mode) each refuse the outsider on
 * their own, so breaking either alone stays green (probe `sw-getproject-tenant`).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE = '';
let server: http.Server;
let n = 0;

interface Res<T> { status: number; body: T }
/** The response fields this file reads — decoded ONCE at the JSON boundary. */
interface ProjectBody { id: string; tenantId: string; orgId: string; name: string; canWrite?: boolean }
interface ProjectList { projects: ProjectBody[] }
interface LoginBody { user: { userId: string } }
interface WorkspaceBody { workspaceId: string }
interface InviteBody { token?: string }

function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    for (const sc of setCookies) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]!; }
    const decoded: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: decoded as T };
  };
  return {
    get: <T = unknown>(p: string) => call<T>('GET', p),
    post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b),
    patch: <T = unknown>(p: string, b?: unknown) => call<T>('PATCH', p, b),
    del: <T = unknown>(p: string) => call<T>('DELETE', p),
  };
}
type Client = ReturnType<typeof client>;

/** Sign in the production way — no `tenantId` override, so the caller lands in
 *  their own `user:` personal tenant exactly as Firebase OIDC would leave them.
 *  Returns the caller's `User.userId` (the subject member rows key on). */
async function signIn(c: Client, email: string): Promise<string> {
  const r = await c.post<LoginBody>('/host/openwop-app/test/login', { email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId;
}

/** A REAL `ws:` shared workspace, created + owned + switched into through the
 *  routes. The switch is what makes active !== personal — the whole point. */
async function sharedWorkspace(c: Client): Promise<string> {
  const ws = await c.post<WorkspaceBody>('/host/openwop-app/workspaces', { name: `Proj WS ${n++}` });
  expect(ws.status, JSON.stringify(ws.body)).toBe(201);
  expect(ws.body.workspaceId, 'must be a real shared workspace, not a personal tenant').toMatch(/^ws:/);
  const sw = await c.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws.body.workspaceId)}/switch`);
  expect(sw.status, JSON.stringify(sw.body)).toBe(200);
  return ws.body.workspaceId;
}

/** Invite a second human into the workspace ROOT org (`orgId === tenantId`) and
 *  have them accept — the real two-member path. Returns the joiner's userId. */
async function joinAsMember(owner: Client, ws: string, joiner: Client, email: string, role: string): Promise<string> {
  const invite = await owner.post<InviteBody>(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/invites`, { email, role });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  expect(invite.body.token, 'the dev/test invite path must expose the token').toBeTruthy();

  const userId = await signIn(joiner, email);
  const accepted = await joiner.post('/host/openwop-app/orgs/invitations/accept', { token: invite.body.token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  const sw = await joiner.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
  expect(sw.status, JSON.stringify(sw.body)).toBe(200);
  return userId;
}

const P = '/host/openwop-app/projects';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  // The de-facto-owner bypass in `resolveEffectiveAccess` hands OWNER scopes to any
  // subject with no member row — it would make the refusal cases pass vacuously.
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'orgs']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
});

describe('PRJC-5 — projects act in the tenant the gate authorized (shared `ws:` workspace)', () => {
  it('a project created inside a shared workspace is filed under the WORKSPACE, not the author\'s home tenant', async () => {
    const a = client();
    await signIn(a, `proj-a-${n++}@acme.test`);
    const ws = await sharedWorkspace(a);

    const created = await a.post<ProjectBody>(P, { orgId: ws, name: 'Shared-WS project' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // THE assertion — a status-only test cannot tell a home-tenant filing apart.
    expect(
      created.body.tenantId,
      `the project must be filed under the workspace (${ws}); got ${created.body.tenantId}`,
    ).toBe(ws);
    expect(created.body.orgId).toBe(ws);
  });

  it('member B SEES the project A created, and B\'s WRITE lands in the same partition A reads', async () => {
    const a = client();
    await signIn(a, `proj-owner-${n++}@acme.test`);
    const ws = await sharedWorkspace(a);
    const b = client();
    await joinAsMember(a, ws, b, `proj-b-${n++}@acme.test`, 'editor');

    const created = await a.post<ProjectBody>(P, { orgId: ws, name: 'Visible To B' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id;

    // B reads the shared partition, not a private empty copy.
    const list = await b.get<ProjectList>(P);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(
      (list.body.projects ?? []).map((p) => p.id),
      "member B must see the org's projects, not a private copy",
    ).toContain(id);
    expect((await b.get(`${P}/${id}`)).status).toBe(200);

    // B (editor ⇒ workspace:write in the ws root org) writes; A sees the write.
    const patched = await b.patch<ProjectBody>(`${P}/${id}`, { name: 'Renamed By B' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.tenantId, "B's write must land in the workspace").toBe(ws);
    expect((await a.get<ProjectBody>(`${P}/${id}`)).body.name).toBe('Renamed By B');
  });

  it('private visibility: withheld from a non-member VIEWER; membership restores READ but never WRITE', async () => {
    const a = client();
    await signIn(a, `proj-owner2-${n++}@acme.test`);
    const ws = await sharedWorkspace(a);
    const viewer = client();
    const viewerId = await joinAsMember(a, ws, viewer, `proj-viewer-${n++}@acme.test`, 'viewer');

    const created = await a.post<ProjectBody>(P, { orgId: ws, name: 'Private Room' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id;
    expect((await a.patch(`${P}/${id}/visibility`, { visibility: 'private' })).status).toBe(200);

    // The non-member viewer: dropped from the list, uniform 404 on the GET.
    expect((await viewer.get<ProjectList>(P)).body.projects.map((p) => p.id)).not.toContain(id);
    expect((await viewer.get(`${P}/${id}`)).status).toBe(404);

    // Membership (the user: ref addProjectMember stores — the DOUBLE-prefixed
    // production shape) restores READ...
    expect((await a.post(`${P}/${id}/members`, { ref: `user:${viewerId}`, role: 'observer' })).status).toBe(201);
    const got = await viewer.get<ProjectBody>(`${P}/${id}`);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body.canWrite).toBe(false);
    expect((await viewer.get<ProjectList>(P)).body.projects.map((p) => p.id)).toContain(id);
    // ...but NEVER write (membership is descriptive, write stays org-authority).
    expect((await viewer.patch(`${P}/${id}`, { name: 'Nope' })).status).toBe(403);
    expect((await a.get<ProjectBody>(`${P}/${id}`)).body.name, 'the refused write must not land').toBe('Private Room');
  });

  it('an OUTSIDER is refused, and a member of workspace B cannot see workspace A\'s projects', async () => {
    const a = client();
    await signIn(a, `proj-wsa-${n++}@acme.test`);
    const wsA = await sharedWorkspace(a);
    const made = await a.post<ProjectBody>(P, { orgId: wsA, name: 'Secret To WS-A' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.id;

    // A never-invited human stays in their personal tenant: uniform 404, and the
    // list shows nothing (no existence disclosure either way).
    const outsider = client();
    await signIn(outsider, `proj-outsider-${n++}@acme.test`);
    expect((await outsider.get(`${P}/${id}`)).status).toBe(404);
    expect((await outsider.get<ProjectList>(P)).body.projects.map((p) => p.name)).not.toContain('Secret To WS-A');

    // A member of a DIFFERENT workspace: same refusals, asserted on content too.
    const b = client();
    await signIn(b, `proj-wsb-${n++}@acme.test`);
    await sharedWorkspace(b);
    expect((await b.get<ProjectList>(P)).body.projects.map((p) => p.name)).not.toContain('Secret To WS-A');
    expect((await b.get(`${P}/${id}`)).status).toBe(404);
    expect((await b.patch(`${P}/${id}`, { name: 'Hijack' })).status).toBe(404);
    expect((await a.get<ProjectBody>(`${P}/${id}`)).body.name, 'the refused write must not land').toBe('Secret To WS-A');
  });
});
