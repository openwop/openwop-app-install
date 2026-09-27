/**
 * ADR 0508 — org-scoped features must work inside a REAL shared workspace.
 *
 * UN-SKIPPED by ADR 0508 Phase 2 — this was the acceptance criterion and it now
 * passes. It was committed SKIPPED alongside the finding rather than left in the ADR
 * as prose, deliberately: the previous root cause on this surface (GC-1 / ADR 0506)
 * sat correctly diagnosed in a test docblock while the tracker carried a WRONG
 * diagnosis, because nobody filed it. An executable reproduction cannot drift from
 * the code the way a paragraph can.
 *
 * Assertions here are deliberately about STATUS **and CONTENT**. Status alone was
 * what let the candidate two-line fix look correct while filing rows under the wrong
 * tenant: the response was a cheerful 201. The round-trip and cross-workspace cases
 * below assert what actually landed and where.
 *
 * `requireOrgScope` (`features/featureRoute.ts:185`) predates ADR 0015. It compared
 * the org's tenant against `user.tenantId` — the caller's HOME tenant — while
 * `POST /orgs` files orgs under `tenantOf(req)`, the ACTIVE one
 * (`routes/accessControl.ts:321`). `resolveCallerUser` returns the canonical
 * home-tenant user whenever `req.personalTenant` is `user:`-prefixed
 * (`features/users/usersGuards.ts:85-93`), which it always is for a real signed-in
 * user — including one who has switched into a shared workspace. So the two never
 * matched and EVERY org-scoped feature route 404'd for EVERY member of a shared
 * workspace, the owner included.
 *
 * Nothing caught it because no test could model a real shared workspace: every
 * route test used the auth seam with a non-`ws:` tenantId, and until #2728 the seam
 * collapsed `personalTenant` onto the active tenant, so `resolveCallerUser` took its
 * `if (req.userId)` branch and the two tenants coincidentally agreed. The tests that
 * DO use real `ws:` workspaces only hit `/orgs/:id/members`, guarded by
 * `routes/accessControl.ts:132` — a different code path.
 *
 * These cases therefore use ONLY the production path — sign in, create a real `ws:`
 * workspace, switch into it — and assert BOTH directions. The refusal cases are the
 * point: a guard widened without observing what it still refuses is exactly the
 * shape of gap that produced this defect.
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
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  // The de-facto-owner bypass in `resolveEffectiveAccess` (accessControlService.ts:1102)
  // hands OWNER scopes to any subject with no member row. It is demo-only and alarmed
  // (LEAK-9), but it would make the refusal cases below pass vacuously — as owners.
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'forms', 'documents']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
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
    for (const sc of setCookies) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

let n = 0;
const ORG_SCOPED = (orgId: string): string =>
  `/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms`;

/** Sign in the production way — no `tenantId` override, so the caller lands in their
 *  own `user:` personal tenant exactly as Firebase OIDC would leave them. */
async function signIn(c: ReturnType<typeof client>): Promise<void> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `os-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

/** A REAL `ws:` shared workspace, created + owned + switched into through the routes.
 *  The switch is what makes active !== personal, which is the whole point. */
async function sharedWorkspace(c: ReturnType<typeof client>): Promise<string> {
  const ws = await c.post('/v1/host/openwop-app/workspaces', { name: `WS ${n++}` });
  expect(ws.status, JSON.stringify(ws.body)).toBe(201);
  expect(ws.body.workspaceId, 'must be a real shared workspace, not a personal tenant').toMatch(/^ws:/);
  const sw = await c.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws.body.workspaceId)}/switch`);
  expect(sw.status, JSON.stringify(sw.body)).toBe(200);
  expect(sw.body.active).toBe(ws.body.workspaceId);
  return ws.body.workspaceId;
}

async function createOrg(c: ReturnType<typeof client>): Promise<string> {
  const org = await c.post('/v1/host/openwop-app/orgs', { name: `Org ${n++}` });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.org?.orgId ?? org.body.orgId;
  expect(orgId, 'org creation must yield an id').toBeTruthy();
  return orgId;
}

describe('ADR 0508 — org-scoped features inside a real shared workspace', () => {
  it('the workspace OWNER reaches an org they created there — 200, not merely not-404', async () => {
    const c = client();
    await signIn(c);
    await sharedWorkspace(c);
    const orgId = await createOrg(c);

    const res = await c.get(ORG_SCOPED(orgId));
    // 200 specifically. `not.toBe(404)` would also accept a 403, which is a DIFFERENT
    // wrong answer — it would mean the tenant was fixed but the subject still missed
    // the membership row, and the bug would read as fixed while access stayed denied.
    expect(
      res.status,
      `the owner must reach their own org in their own workspace; got ${res.status} ${JSON.stringify(res.body)}`,
    ).toBe(200);
  });

  it('a NON-MEMBER is refused — the widened guard still fences outsiders', async () => {
    const owner = client();
    await signIn(owner);
    await sharedWorkspace(owner);
    const orgId = await createOrg(owner);

    // A different human who was never invited. They stay in their own personal tenant.
    const outsider = client();
    await signIn(outsider);

    const res = await outsider.get(ORG_SCOPED(orgId));
    // 404, not 403: no-existence-leak is the intended semantic for an org outside the
    // tenant the caller is acting in.
    expect(
      res.status,
      `an outsider must not reach another workspace's org; got ${res.status} ${JSON.stringify(res.body)}`,
    ).toBe(404);
  });

  it('a member of workspace A cannot reach an org in workspace B — cross-workspace isolation', async () => {
    const a = client();
    await signIn(a);
    await sharedWorkspace(a);
    const orgInA = await createOrg(a);

    // Same pattern, entirely separate workspace — and B is ACTIVE in their own, so this
    // pins that the guard follows the ACTIVE tenant rather than being satisfied by the
    // caller merely holding membership somewhere.
    const b = client();
    await signIn(b);
    await sharedWorkspace(b);

    const res = await b.get(ORG_SCOPED(orgInA));
    expect(
      res.status,
      `workspace B must not reach workspace A's org; got ${res.status} ${JSON.stringify(res.body)}`,
    ).toBe(404);
  });

  it('a row WRITTEN in a shared workspace is stored under the WORKSPACE, not the caller home tenant', async () => {
    // THE assertion that would have caught the candidate two-line fix. That fix
    // returned a cheerful 201 while filing the row under the caller's PERSONAL
    // tenant — a status-only test calls that a pass. Assert where the data landed.
    const c = client();
    await signIn(c);
    const ws = await sharedWorkspace(c);
    const orgId = await createOrg(c);

    const created = await c.post(ORG_SCOPED(orgId), { title: 'Round trip', fields: [] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const row = created.body.form ?? created.body;
    expect(
      row.tenantId,
      `the row must be filed under the WORKSPACE (${ws}); got ${row.tenantId}`,
    ).toBe(ws);

    // And it must be readable back through the same org-scoped route — write and
    // read agreeing on the tenant is the property, not either one alone.
    const list = await c.get(ORG_SCOPED(orgId));
    expect(list.status).toBe(200);
    const ids = (list.body.forms ?? []).map((f: { formId: string }) => f.formId);
    expect(ids, 'the row written here must be readable here').toContain(row.formId);
  });

  it('a row in workspace A is ABSENT from workspace B — isolation asserted on CONTENT', async () => {
    const a = client();
    await signIn(a);
    await sharedWorkspace(a);
    const orgInA = await createOrg(a);
    const madeInA = await a.post(ORG_SCOPED(orgInA), { title: 'Secret A', fields: [] });
    expect(madeInA.status, JSON.stringify(madeInA.body)).toBe(201);

    // A second workspace owned by a different human, with its own org.
    const b = client();
    await signIn(b);
    await sharedWorkspace(b);
    const orgInB = await createOrg(b);

    const listB = await b.get(ORG_SCOPED(orgInB));
    expect(listB.status).toBe(200);
    const titles = (listB.body.forms ?? []).map((f: { title: string }) => f.title);
    expect(titles, "workspace B must not see workspace A's rows").not.toContain('Secret A');
  });

  it('the SECOND, hand-rolled copy of the guard also resolves in a shared workspace', async () => {
    // GC-8 — `documents` `/locate/:documentId` cannot call the shared guard (it
    // RESOLVES the org from the document instead of reading `req.params.orgId`), so
    // it duplicates the logic and carried the same defect. Phase 2 flipped it, but
    // NOTHING covered it: reverting that one line was measured to leave both the
    // ratchet and this suite fully green. Behaviour is asserted here; the ratchet
    // catches the source shape. Neither alone was sufficient.
    const c = client();
    await signIn(c);
    await sharedWorkspace(c);
    const orgId = await createOrg(c);

    const doc = await c.post(`/v1/host/openwop-app/documents/orgs/${encodeURIComponent(orgId)}/documents`, {
      title: 'Locate me', kind: 'doc', format: 'markdown',
    });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);
    const documentId = doc.body.documentId ?? doc.body.document?.documentId;
    expect(documentId, 'document creation must yield an id').toBeTruthy();

    const located = await c.get(`/v1/host/openwop-app/documents/locate/${encodeURIComponent(documentId)}`);
    expect(
      located.status,
      `a document created in this workspace must be locatable from it; got ${located.status} ${JSON.stringify(located.body)}`,
    ).toBe(200);
    expect(located.body.orgId, 'and it must resolve to the org it was created in').toBe(orgId);
  });

  it('the PERSONAL tenant is unchanged — active === personal still works', async () => {
    // The regression direction: before ADR 0508 this was the only case that worked,
    // because home and active coincided. It must keep working.
    const c = client();
    await signIn(c);
    const orgId = await createOrg(c);

    const res = await c.get(ORG_SCOPED(orgId));
    expect(
      res.status,
      `a personal-tenant org must still resolve; got ${res.status} ${JSON.stringify(res.body)}`,
    ).toBe(200);
  });
});
