/**
 * WF-TWIN-9 / GEN-TWIN-2 — the witness the whole twin surface never had.
 *
 * WHY A NEW FILE. `test/twin-route.test.ts` mints every caller with an explicit
 * `org:tw-…` tenantId through the auth seam, so `resolveCallerUser` takes its
 * `if (req.userId)` branch and HOME == ACTIVE *coincidentally*. That harness is
 * STRUCTURALLY incapable of observing the defect: the two tenants it compares are
 * the same value. `routes/authTestSeam.ts:85-117` documents that collapse — and
 * documents the `sharedWorkspace: true` escape from it — and no twin test used it.
 *
 * NON-VACUITY. Everything below goes through the PRODUCTION path: sign in with no
 * tenant override, create a real `ws:` workspace, switch into it, invite a second
 * human by email, accept. No `createMember` back door and no `sharedWorkspace`
 * seam flag, so `personalTenant` is genuinely distinct from the active tenant and
 * the GC-1 collapsed-personalTenant trap cannot make anything here vacuous.
 *
 * WITNESSED RED FIRST (2026-08-20, before the fixes in ADR 0589):
 *   - "the linked member can actually consent"     → 404 `grantRecall failed`
 *     from `twinService.ts:111-114`  (WF-TWIN-1 / TWIN-2 / TWIN-UX-2)
 *   - "a granted twin recalls the owner's corpus"  → resolver `undefined`
 *   - "a DSAR reaches the subject's personal data" → the note SURVIVED a 204
 *     (WF-TWIN-3)
 * A test born green here would be vacuous; these were not.
 *
 * @see docs/adr/0589-twin-tenancy-and-recall-audience.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { resolveBorrowedRecall } from '../src/features/twin/borrowedRecall.js';
import { getUser } from '../src/features/users/usersService.js';
import { listSubjectNotes } from '../src/host/subjectMemory.js';
import { grantTwin } from '../src/host/twinService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';

let BASE = '';
let server: http.Server;
let n = 0;

interface Res<T = Record<string, any>> { status: number; body: T }

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res<any>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    for (const sc of setCookies) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    put: (p: string, b?: unknown) => call('PUT', p, b),
    del: (p: string) => call('DELETE', p),
  };
}
type Client = ReturnType<typeof client>;

async function signIn(c: Client, email: string): Promise<string> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId as string;
}

/** A REAL `ws:` shared workspace, created + owned + switched into through the
 *  routes. The switch is what makes active !== personal. */
async function sharedWorkspace(c: Client): Promise<string> {
  const ws = await c.post('/v1/host/openwop-app/workspaces', { name: `Twin WS ${n++}` });
  expect(ws.status, JSON.stringify(ws.body)).toBe(201);
  expect(ws.body.workspaceId, 'must be a real shared workspace, not a personal tenant').toMatch(/^ws:/);
  const sw = await c.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws.body.workspaceId)}/switch`);
  expect(sw.status, JSON.stringify(sw.body)).toBe(200);
  return ws.body.workspaceId as string;
}

async function joinAsMember(owner: Client, ws: string, joiner: Client, email: string, role: string): Promise<string> {
  const invite = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(ws)}/invites`, { email, role });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  const userId = await signIn(joiner, email);
  const accepted = await joiner.post('/v1/host/openwop-app/orgs/invitations/accept', { token: invite.body.token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  const sw = await joiner.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
  expect(sw.status, JSON.stringify(sw.body)).toBe(200);
  return userId;
}

const twin = (id: string): string => `/v1/host/openwop-app/agents/${encodeURIComponent(id)}/twin`;
const GRANTS = '/v1/host/openwop-app/profiles/me/twin-grants';
const MEM = '/v1/host/openwop-app/profiles/me/memory';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  // The de-facto-owner bypass in `resolveEffectiveAccess` hands OWNER scopes to
  // any subject with no member row — it would make refusal cases vacuous.
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'orgs', 'consent', 'twin-recall']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
});

/** Owner + a member + a roster agent, all inside ONE real shared workspace. */
async function wsFixture(): Promise<{ owner: Client; member: Client; memberId: string; memberHome: string; ws: string; rosterId: string }> {
  const owner = client();
  await signIn(owner, `tw-ws-owner-${n++}@acme.test`);
  const ws = await sharedWorkspace(owner);
  const member = client();
  const memberId = await joinAsMember(owner, ws, member, `tw-ws-member-${n++}@acme.test`, 'editor');
  const memberHome = (await getUser(memberId))!.tenantId;
  expect(memberHome, 'the fixture is worthless unless HOME really differs from ACTIVE').not.toBe(ws);
  const r = await owner.post('/v1/host/openwop-app/roster', { persona: 'Aide', agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { owner, member, memberId, memberHome, ws, rosterId: r.body.rosterId };
}

describe('WF-TWIN-1 — the consent grant is issuable inside a shared workspace', () => {
  it('the linked member can actually consent, and the grant is filed under the WORKSPACE', async () => {
    const { owner, member, memberId, ws, rosterId } = await wsFixture();

    const link = await owner.put(twin(rosterId), { userId: memberId });
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    expect(link.body.link.userId).toBe(memberId);

    // THE assertion. Before ADR 0589 this was a 404 from `twinService.ts:111-114`
    // — for an agent whose link the panel is rendering "Twin of you" for, right
    // above the button.
    const g = await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] });
    expect(g.status, `the linked member must be able to consent; got ${JSON.stringify(g.body)}`).toBe(201);
    // Status alone is not enough — a 201 filed under the wrong tenant is the
    // ADR 0508 first-candidate-fix failure mode.
    expect(g.body.grant.tenantId, `the grant must be filed under the workspace (${ws})`).toBe(ws);

    // And it is readable back by the grantor, and visible on the agent link.
    expect((await member.get(GRANTS)).body.grants.length).toBe(1);
    expect((await owner.get(twin(rosterId))).body.grant.scopes).toEqual(['memory']);
  });

  it('a NON-linked member still cannot consent (the widening did not open a door)', async () => {
    const { owner, member, memberId, rosterId } = await wsFixture();
    await owner.put(twin(rosterId), { userId: memberId });
    // The workspace OWNER is not the linked person — same fail-closed 404 as before.
    expect((await owner.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(404);
    expect(member).toBeDefined();
  });

  // TWIN-5 — moved here from `twin-route.test.ts`, where the GC-1 personalTenant
  // collapse makes every caller read as the workspace owner and the refusal is
  // therefore unreachable. In a REAL `ws:` workspace a viewer genuinely lacks
  // `workspace:write`, so this is the first place the admin-link gate is
  // falsifiable. It is also the operator-principal ALLOW witness's counterpart:
  // the canonical helper the local copy was replaced with has a wildcard exit the
  // local one lacked (`featureRoute.ts:262`).
  it('a VIEWER member cannot link an agent to anyone (403)', async () => {
    const owner = client();
    await signIn(owner, `tw-ws-owner-${n++}@acme.test`);
    const ws = await sharedWorkspace(owner);
    const viewer = client();
    const viewerId = await joinAsMember(owner, ws, viewer, `tw-ws-viewer-${n++}@acme.test`, 'viewer');
    const r = await owner.post('/v1/host/openwop-app/roster', { persona: 'Aide', agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
    expect(r.status).toBe(201);
    const res = await viewer.put(twin(r.body.rosterId), { userId: viewerId });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });
});

describe('WF-TWIN-4 — a granted twin recalls the OWNER\'s corpus, which lives in their home tenant', () => {
  it('the resolver composes the member\'s personal memory even though it is home-tenant scoped', async () => {
    const { owner, member, memberId, ws, rosterId } = await wsFixture();
    await member.post(MEM, { content: 'I always cc finance on vendor contracts.' });
    await owner.put(twin(rosterId), { userId: memberId });
    expect((await member.post(GRANTS, { agentId: rosterId, scopes: ['memory'] })).status).toBe(201);

    const retrieve = await resolveBorrowedRecall(ws, rosterId, { callerUserId: memberId });
    expect(retrieve, 'the gate must open in a shared workspace').toBeDefined();
    const chunks = await retrieve!.retrieve('vendor contract finance');
    // Before ADR 0589 §D1b this was ZERO chunks with no error and no degradation
    // notice — the fabrication shape: an empty corpus reported as success.
    expect(chunks.map((c) => c.content).join(' ')).toContain('cc finance on vendor contracts');
  });

  // MEDIUM-4 probe — the `?? tenantId` fallback D1b shipped with. When the
  // owner's `getUser` row cannot be resolved, the resolver used to silently read
  // the DISPATCH tenant's (empty) corpus: a defined retriever returning [] with
  // no error — empty-as-success, the exact shape D1b exists to kill. It must
  // instead DENY (`closed('owner-unresolvable')` → undefined). The link+grant are
  // minted for a GHOST user through the service layer (the PUT route does not
  // validate that `userId` names a real user — TWIN-UX-3 records that), which is
  // precisely how a link to a since-deleted or never-real user occurs.
  // What this does NOT discriminate: it cannot tell `closed('owner-unresolvable')`
  // from any other closed() reason — only that the gate no longer OPENS over an
  // unresolvable owner (pre-fix it opened; sabotage-checked by restoring `?? ws`).
  it('an unresolvable owner DENIES instead of silently reading the dispatch tenant', async () => {
    const { owner, ws, rosterId } = await wsFixture();
    const ghost = `user:ghost-${Date.now()}-${n++}`;
    expect((await getUser(ghost)), 'the probe is vacuous unless the owner is truly unresolvable').toBeNull();
    expect((await owner.put(twin(rosterId), { userId: ghost })).status).toBe(200);
    await grantTwin(hostExtStorage(), ws, rosterId, ghost, ['memory']);
    const retrieve = await resolveBorrowedRecall(ws, rosterId, { callerUserId: ghost });
    expect(retrieve, 'a grant whose owner cannot be resolved must fail CLOSED, not read the dispatch tenant').toBeUndefined();
  });
});

describe('WF-TWIN-3 — a DSAR from a shared workspace reaches the subject\'s personal data', () => {
  // CORRECTION to the tracker (measured 2026-08-20). `WF-TWIN-3` names TWO doors
  // onto the fan-out — `features/users/routes.ts:269` and
  // `features/consent/consentService.ts:585`. The FIRST one is not reachable in a
  // shared workspace at all: `DELETE /users/users/:id` guards on
  // `existing.tenantId !== tenantOf(req)` (`features/users/routes.ts:239`), and a
  // member's `User.tenantId` is their HOME tenant, so it 404s "User not found."
  // before any erasure runs. That is the same HOME-vs-ACTIVE family in the `users`
  // feature, out of scope here, and arguably the correct refusal (a workspace
  // admin deleting a person's GLOBAL identity is a bigger act than a DSAR).
  // The reachable door — and the one the governance chain writes from — is
  // consent's `DELETE /consent/orgs/:orgId/subjects/:subjectKey`.
  it('a WORKSPACE-scoped erasure does NOT silently claim it erased the home-tenant corpus', async () => {
    const { owner, member, memberId, memberHome, ws } = await wsFixture();
    await member.post(MEM, { content: 'My home address is 12 Elm Street.' });
    // Precondition — the note really is in the HOME partition, not the workspace.
    expect((await listSubjectNotes(memberHome, { kind: 'user', id: memberId })).length).toBe(1);

    const del = await owner.del(
      `/v1/host/openwop-app/consent/orgs/${encodeURIComponent(ws)}/subjects/${encodeURIComponent(memberId)}`,
    );
    expect(del.status, JSON.stringify(del.body)).toBe(200);

    // The note SURVIVES, and that is CORRECT — see the ADR 0589 correction: a
    // workspace admin must not be able to destroy a person's personal-tenant data
    // in every OTHER workspace they belong to by naming their user id.
    expect((await listSubjectNotes(memberHome, { kind: 'user', id: memberId })).length).toBe(1);

    // THE assertion, and the whole of what WF-TWIN-3 is really about: the fan-out
    // reached NOTHING and must say so. Before ADR 0589 this wrote
    // `outcome:'allow', reason:'erasure_complete'` into the tamper-evident
    // governance chain over data it never touched.
    expect(del.body.erasure.failed).toBe(0);
    expect(del.body.erasure.foundNothing, 'a zero-row fan-out must be distinguishable from a completed one').toBe(true);
  });

  it('an erasure issued in the subject\'s OWN tenant does erase their personal memory', async () => {
    // The complementary polarity — and a defect of its own, independent of
    // tenancy: `eraseSubjectMemory` derived the memory scope from
    // `subjectKeyForms(subjectKey).raw`, which STRIPS `user:`, while the writer
    // scopes by the full `User.userId` (itself `user:<hash>`). The two prefixes
    // never overlapped, so personal memory was erased by NO ONE, anywhere.
    const c = client();
    const userId = await signIn(c, `tw-self-${n++}@acme.test`);
    const home = (await getUser(userId))!.tenantId;
    await c.post(MEM, { content: 'Sensitive personal note.' });
    expect((await listSubjectNotes(home, { kind: 'user', id: userId })).length).toBe(1);

    const del = await c.del(
      `/v1/host/openwop-app/consent/orgs/${encodeURIComponent(home)}/subjects/${encodeURIComponent(userId)}`,
    );
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(await listSubjectNotes(home, { kind: 'user', id: userId })).toEqual([]);
    expect(del.body.erasure.rowsTouched).toBeGreaterThan(0);
    expect(del.body.erasure.foundNothing).toBe(false);
  });

  it('a fan-out that reaches NOTHING is not recorded as erasure_complete', async () => {
    const { owner, ws } = await wsFixture();
    const del = await owner.del(
      `/v1/host/openwop-app/consent/orgs/${encodeURIComponent(ws)}/subjects/${encodeURIComponent('user:nobody-at-all')}`,
    );
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    // Nothing FAILED — so the request is still `allow`/`ok`. But nothing was
    // found either, and `erasure_complete` is a claim the fan-out cannot support.
    expect(del.body.erasure.failed).toBe(0);
    expect(del.body.erasure.foundNothing, 'a zero-row fan-out must be distinguishable from a completed one').toBe(true);
  });
});
