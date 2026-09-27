/**
 * CRM-1 — the ADR 0508 acceptance criterion, applied to CRM.
 *
 * WHY A NEW FILE. `test/orgscope-shared-workspace.test.ts` proves the property for
 * `forms` and `documents` only, and `test/crm-org-route.test.ts` mints its callers
 * with an explicit `org:test-…` tenantId through the auth seam — so
 * `resolveCallerUser` takes its `if (req.userId)` branch and HOME == ACTIVE
 * *coincidentally*. That harness is STRUCTURALLY incapable of observing this defect:
 * the two tenants it compares are the same value. CRM had zero shared-`ws:`
 * coverage while carrying 95 live re-derivations.
 *
 * WHAT WAS BROKEN. `authorizeOrgScope` authorizes against the ACTIVE workspace
 * tenant and returns it; CRM's `interface Ctx` dropped that field, so all 30
 * handlers read `ctx.user.tenantId` — the caller's HOME tenant. Inside a shared
 * `ws:` workspace the gate passes (the org lives in `ws:xyz` and the caller holds
 * scope there) and the handler then reads and writes the caller's own PRIVATE
 * partition. Every member therefore got an invisible personal copy of the org's
 * CRM, and every create filed a row tagged HOME carrying an `orgId` owned by a
 * different tenant.
 *
 * NON-VACUITY. Everything below goes through the PRODUCTION path only — sign in,
 * create a real `ws:` workspace, switch into it, invite a second human by email,
 * accept the invite. No `createMember` back door and no `sharedWorkspace` seam
 * flag, so `personalTenant` is genuinely distinct from the active tenant and the
 * collapsed-`personalTenant` trap (GC-1) cannot make a gate vacuous here.
 *
 * BOTH POLARITIES. The A-writes/B-reads case is what fails before the fix; the
 * outsider and cross-workspace cases prove the widened path still refuses.
 * Assertions are on CONTENT as well as status — a status-only test calls a cheerful
 * 201 filed under the wrong tenant a pass, which is precisely how the original
 * ADR 0508 defect survived its first candidate fix.
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
  };
}
type Client = ReturnType<typeof client>;

/** Sign in the production way — no `tenantId` override, so the caller lands in
 *  their own `user:` personal tenant exactly as Firebase OIDC would leave them. */
async function signIn(c: Client, email: string): Promise<void> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

/** A REAL `ws:` shared workspace, created + owned + switched into through the
 *  routes. The switch is what makes active !== personal, which is the whole point. */
async function sharedWorkspace(c: Client): Promise<string> {
  const ws = await c.post('/v1/host/openwop-app/workspaces', { name: `CRM WS ${n++}` });
  expect(ws.status, JSON.stringify(ws.body)).toBe(201);
  expect(ws.body.workspaceId, 'must be a real shared workspace, not a personal tenant').toMatch(/^ws:/);
  const sw = await c.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws.body.workspaceId)}/switch`);
  expect(sw.status, JSON.stringify(sw.body)).toBe(200);
  return ws.body.workspaceId as string;
}

/** Invite a second human into the workspace ROOT org and have them accept — the
 *  real two-member path. The workspace root IS an org (`orgId === tenantId`), which
 *  is what makes one org-scoped route observe the ACTIVE/HOME split directly. */
async function joinAsMember(owner: Client, ws: string, joiner: Client, email: string, role: string): Promise<void> {
  const invite = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(ws)}/invites`, { email, role });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  expect(invite.body.token, 'the dev/test invite path must expose the token').toBeTruthy();

  await signIn(joiner, email);
  const accepted = await joiner.post('/v1/host/openwop-app/orgs/invitations/accept', { token: invite.body.token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  const sw = await joiner.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
  expect(sw.status, JSON.stringify(sw.body)).toBe(200);
}

const companies = (orgId: string): string =>
  `/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/companies`;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  // The de-facto-owner bypass in `resolveEffectiveAccess` hands OWNER scopes to any
  // subject with no member row — it would make the refusal cases pass vacuously.
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  // H41: bind loopback v4 EXPLICITLY — a resident 127.0.0.1 listener would
  // otherwise answer this test's fetch through the wildcard form.
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'orgs', 'crm']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
});

describe('CRM-1 — CRM org routes act in the tenant the gate authorized', () => {
  it('a row created inside a shared workspace is filed under the WORKSPACE, not the author\'s home tenant', async () => {
    const a = client();
    await signIn(a, `crm-a-${n++}@acme.test`);
    const ws = await sharedWorkspace(a);

    const created = await a.post(companies(ws), { name: 'Acme (shared)' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    // THE assertion. Before the fix this was the author's HOME `user:<hash>` tenant
    // while the response was a cheerful 201 — a status-only test cannot tell the
    // two apart, which is exactly how ADR 0508's first candidate fix passed.
    expect(
      created.body.tenantId,
      `the company must be filed under the workspace (${ws}); got ${created.body.tenantId}`,
    ).toBe(ws);
    expect(created.body.orgId).toBe(ws);
  });

  it('member B SEES the record member A created — the shared rolodex is actually shared', async () => {
    const a = client();
    await signIn(a, `crm-owner-${n++}@acme.test`);
    const ws = await sharedWorkspace(a);
    const b = client();
    await joinAsMember(a, ws, b, `crm-b-${n++}@acme.test`, 'editor');

    const created = await a.post(companies(ws), { name: 'Shared By A' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const list = await b.get(companies(ws));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    // Before the fix B read their OWN home-tenant partition, so this list was empty
    // no matter what A had written — every member held a private invisible copy.
    expect(
      (list.body.companies ?? []).map((c: { companyId: string }) => c.companyId),
      "member B must see the org's records, not a private copy of them",
    ).toContain(created.body.companyId);
  });

  it('...and member B can WRITE into the same partition A reads', async () => {
    // The other direction. A create by B that A cannot see is the same defect
    // wearing the opposite hat, and it is a distinct code path (write, not read).
    const a = client();
    await signIn(a, `crm-owner2-${n++}@acme.test`);
    const ws = await sharedWorkspace(a);
    const b = client();
    await joinAsMember(a, ws, b, `crm-b2-${n++}@acme.test`, 'editor');

    const byB = await b.post(companies(ws), { name: 'Written By B' });
    expect(byB.status, JSON.stringify(byB.body)).toBe(201);
    expect(byB.body.tenantId, "B's write must also land in the workspace").toBe(ws);

    const seenByA = await a.get(companies(ws));
    expect(seenByA.status).toBe(200);
    expect(
      (seenByA.body.companies ?? []).map((c: { name: string }) => c.name),
      "the workspace owner must see the member's row",
    ).toContain('Written By B');
  });

  it('an OUTSIDER is refused — the widened path still fences', async () => {
    // Refusal is the half a widening most often breaks. A never-invited human stays
    // in their own personal tenant, so the org is not in the tenant they are acting
    // in: a uniform 404, no existence disclosure.
    const a = client();
    await signIn(a, `crm-owner3-${n++}@acme.test`);
    const ws = await sharedWorkspace(a);

    const outsider = client();
    await signIn(outsider, `crm-outsider-${n++}@acme.test`);
    const res = await outsider.get(companies(ws));
    expect(res.status, `an outsider must not read the org's CRM; got ${JSON.stringify(res.body)}`).toBe(404);
  });

  it("a member of workspace B cannot see workspace A's records — isolation asserted on CONTENT", async () => {
    const a = client();
    await signIn(a, `crm-wsa-${n++}@acme.test`);
    const wsA = await sharedWorkspace(a);
    const madeInA = await a.post(companies(wsA), { name: 'Secret To WS1' });
    expect(madeInA.status, JSON.stringify(madeInA.body)).toBe(201);

    const b = client();
    await signIn(b, `crm-wsb-${n++}@acme.test`);
    const wsB = await sharedWorkspace(b);

    const list = await b.get(companies(wsB));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(
      (list.body.companies ?? []).map((c: { name: string }) => c.name),
      "workspace B must not see workspace A's rows",
    ).not.toContain('Secret To WS1');

    // ...and reaching for A's org directly is a 404.
    expect((await b.get(companies(wsA))).status).toBe(404);
  });

  it('the tenant-scoped CONVERT path uses the same tenant as the contact read path', async () => {
    // `routes.ts` disagreed with itself: `GET /crm/contacts/:id` resolved against
    // `tenantOf(req)` (ACTIVE) while `POST /crm/contacts/:id/convert` passed
    // `ctx.user.tenantId` (HOME) to `convertContact` — so in a shared workspace the
    // contact you could read was the one you could not convert.
    const a = client();
    await signIn(a, `crm-conv-${n++}@acme.test`);
    const ws = await sharedWorkspace(a);

    const made = await a.post('/v1/host/openwop-app/crm/contacts', {
      name: 'Convertible Lead', email: `lead-${n++}@acme.test`,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.tenantId, 'the contact itself is written under the ACTIVE tenant').toBe(ws);

    const read = await a.get(`/v1/host/openwop-app/crm/contacts/${encodeURIComponent(made.body.contactId)}`);
    expect(read.status, 'precondition: the contact is readable in this workspace').toBe(200);

    const converted = await a.post(
      `/v1/host/openwop-app/crm/contacts/${encodeURIComponent(made.body.contactId)}/convert`,
      { orgId: ws, companyName: 'Convertible Co' },
    );
    expect(
      converted.status,
      `a contact readable here must be convertible here; got ${JSON.stringify(converted.body)}`,
    ).toBe(200);
    expect(converted.body.company.tenantId, 'and the company it mints belongs to the workspace').toBe(ws);
  });
});
