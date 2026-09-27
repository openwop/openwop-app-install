/**
 * USERS-4 — a NON-VACUOUS route test for the `host:members:manage` gates on the
 * users feature's admin routes (create / patch / lifecycle / delete), plus the
 * USERS-5 audit-chain rows the lifecycle routes now append.
 *
 * NON-VACUOUS means the collapsed-`personalTenant` seam trap (GC-1 / finding
 * USERS-4 itself) is avoided: callers sign in with `sharedWorkspace: true`, so
 * `isOwnPersonalWorkspace` is FALSE and `requireTenantScope` actually consults
 * membership instead of short-circuiting as an implicit owner. Membership is
 * provisioned BEFORE login under the derivable `userIdFor(WS, principal)`
 * subject (the kicktodo-authz-http precedent). Both polarities are asserted:
 * an ADMIN member is allowed, an EDITOR member (a real co-tenant WITHOUT the
 * manage scope) is refused 403, and a NON-member is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { createWorkspace, createMember, ensurePersonalWorkspace } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { listChain } from '../src/host/auditChainService.js';

let server: Server;
let BASE = '';
const USERS = '/v1/host/openwop-app/users/users';

let WS = '';
const ADMIN = 'oidc:um-admin';
const EDITOR = 'oidc:um-editor';
const OUTSIDER = 'oidc:um-outsider';

/** Log in through the test seam and return the session cookie.
 *  `sharedWorkspace: true` is the load-bearing bit — without it the seam
 *  collapses personal onto active and the scope gate short-circuits before it
 *  ever consults membership (the exact vacuity this test exists to avoid).
 *  The USERS-19 block below passes `sharedWorkspace: false` ON PURPOSE: the
 *  collapsed `personalTenant === tenantId` cookie is byte-for-byte the shape the
 *  SAML ACS mints (`routes/authSamlSso.ts`, `personalTenant: s.tenantId`). */
async function login(subject: string, tenantId: string, sharedWorkspace = true): Promise<string> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, tenantId, displayName: subject, sharedWorkspace }),
  });
  expect(res.status, 'test seam must mint a session').toBeLessThan(300);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

const call = async (cookie: string, method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

beforeAll(async () => {
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_DEMO_MODE; // the de-facto-owner bypass would make refusals vacuous
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    // H41: bind loopback v4 EXPLICITLY — see check-test-ports.mjs. The wildcard
    // form lets a resident 127.0.0.1 listener answer this test's fetch.
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });

  const ws = await createWorkspace({ name: 'USERS-4 workspace', ownerSubject: 'oidc:um-owner' });
  WS = ws.orgId ?? ws.tenantId;

  // Membership keyed on each caller's FUTURE `userId`, provisioned before the
  // session exists (userIdFor is a pure hash of the two values we control).
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Admin', subject: userIdFor(WS, ADMIN), roles: ['admin'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: userIdFor(WS, EDITOR), roles: ['editor'] });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
});

describe('USERS-8 — the read routes refuse anonymous sessions (revert-visible)', () => {
  it('GET /users/users and GET /users/users/:id → 401 sign_in_required with no session', async () => {
    // No cookie at all: the middleware mints an anon session (`anon:` tenant),
    // which `requireSignedIn` refuses. Assert 401 SPECIFICALLY — reverting the
    // guard yields 200 (list) / 404 (unknown id), both visibly different.
    const list = await fetch(`${BASE}${USERS}`);
    expect(list.status).toBe(401);
    expect(((await list.json()) as { error?: string }).error).toBe('sign_in_required');

    const one = await fetch(`${BASE}${USERS}/user%3Adoes-not-matter`);
    expect(one.status).toBe(401);
    expect(((await one.json()) as { error?: string }).error).toBe('sign_in_required');
  });
});

describe('USERS-4 — host:members:manage gates over HTTP, in a REAL shared workspace', () => {
  it('precondition: the workspace session is REAL — an EDITOR member reads the list (200), so refusals below are scope, not tenancy', async () => {
    const cookie = await login(EDITOR, WS);
    const res = await call(cookie, 'GET', USERS);
    // A 404 here would mean the caller was bounced to their personal tenant —
    // every 403 below would then be proving the wrong thing.
    expect(res.status).toBe(200);
  });

  it('an ADMIN member may create a durable user (allowed-with)', async () => {
    const cookie = await login(ADMIN, WS);
    const res = await call(cookie, 'POST', USERS, { principalId: 'oidc:um-target-created' });
    expect(res.status, await res.text().catch(() => '')).toBe(201);
  });

  it('an EDITOR member is REFUSED user creation — 403 from the scope gate itself', async () => {
    const cookie = await login(EDITOR, WS);
    const res = await call(cookie, 'POST', USERS, { principalId: 'oidc:um-nope' });
    expect(res.status).toBe(403);
  });

  it('an EDITOR member is REFUSED lifecycle + patch + delete on another user', async () => {
    const admin = await login(ADMIN, WS);
    const created = await call(admin, 'POST', USERS, { principalId: 'oidc:um-target-2' });
    expect(created.status).toBe(201);
    const { userId } = (await created.json()) as { userId: string };

    const editor = await login(EDITOR, WS);
    expect((await call(editor, 'POST', `${USERS}/${encodeURIComponent(userId)}/disable`)).status).toBe(403);
    expect((await call(editor, 'PATCH', `${USERS}/${encodeURIComponent(userId)}`, { displayName: 'x' })).status).toBe(403);
    expect((await call(editor, 'DELETE', `${USERS}/${encodeURIComponent(userId)}`)).status).toBe(403);
  });

  it('a NON-member never reaches the WORKSPACE — bounced to their personal tenant, where WS rows are invisible', async () => {
    // Per the seam's own NOTE (authTestSeam.ts): a non-member under
    // `sharedWorkspace: true` is bounced to their personal tenant by the
    // ADR 0015 re-check BEFORE the route runs. The users routes have no feature
    // gate to 404 there, and a personal-tenant OWNER may legitimately create
    // users in their OWN tenant — so the refusal is TENANCY, not status: assert
    // where the write landed and that the workspace's rows stay invisible.
    const cookie = await login(OUTSIDER, WS);

    // A create "succeeds" — in the OUTSIDER's personal tenant, never in WS.
    const res = await call(cookie, 'POST', USERS, { principalId: 'oidc:um-outsider-mint' });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { tenantId: string };
    expect(created.tenantId).not.toBe(WS);

    // The WS admin's list must NOT contain the outsider's row…
    const admin = await login(ADMIN, WS);
    const list = (await (await call(admin, 'GET', USERS)).json()) as { users: Array<{ principalId: string }> };
    expect(list.users.some((u) => u.principalId === 'oidc:um-outsider-mint')).toBe(false);

    // …and a WS user is unreachable to the outsider (404 — tenant isolation).
    const target = await call(admin, 'POST', USERS, { principalId: 'oidc:um-target-3' });
    expect(target.status).toBe(201);
    const { userId } = (await target.json()) as { userId: string };
    expect((await call(cookie, 'POST', `${USERS}/${encodeURIComponent(userId)}/disable`)).status).toBe(404);
    expect((await call(cookie, 'GET', `${USERS}/${encodeURIComponent(userId)}`)).status).toBe(404);
  });

  it('USERS-5: admin disable/enable/delete each append an audit-chain row (ids only)', async () => {
    const admin = await login(ADMIN, WS);
    const created = await call(admin, 'POST', USERS, { principalId: 'oidc:um-audited' });
    expect(created.status).toBe(201);
    const { userId } = (await created.json()) as { userId: string };

    expect((await call(admin, 'POST', `${USERS}/${encodeURIComponent(userId)}/disable`)).status).toBe(200);
    expect((await call(admin, 'POST', `${USERS}/${encodeURIComponent(userId)}/enable`)).status).toBe(200);
    expect((await call(admin, 'DELETE', `${USERS}/${encodeURIComponent(userId)}`)).status).toBe(204);

    const chain = await listChain(WS);
    const kinds = chain.map((e) => e.kind);
    expect(kinds).toContain('users.lifecycle.disable');
    expect(kinds).toContain('users.lifecycle.enable');
    expect(kinds).toContain('users.lifecycle.delete');
    const disable = chain.find((e) => e.kind === 'users.lifecycle.disable')!;
    expect(disable.payload.userId).toBe(userId);
    expect(disable.payload.status).toBe('disabled');
    // F5: the actor is the OPAQUE bound id, never a principalId (a SAML email
    // NameID would be PII on the exportable chain).
    expect(disable.payload.actor).toMatch(/^user:/);
    // Ids only — the audit row must never carry PII (email / display name).
    expect(disable.payload).not.toHaveProperty('email');
    expect(disable.payload).not.toHaveProperty('displayName');
  });
});

/**
 * USERS-19 (Blocker, ADR 0617 D2 / ADR 0621) — the SAML implicit-owner bypass.
 * The SAML ACS mints `personalTenant: OPENWOP_SAML_TENANT` — ONE host-global,
 * multi-human tenant (`default` is a shape a deployment can pick). Because
 * `personalTenant === tenantId`, `isOwnPersonalWorkspace` was TRUE for every
 * plain SAML member and `requireTenantScope` returned before consulting
 * membership: any SAML member could create / PATCH / disable / delete any user.
 *
 * The cookie shape is reproduced through the test seam WITHOUT `sharedWorkspace`
 * (the collapsed idiom = the SAML mint's shape); the workspace is founded by a
 * DIFFERENT owner first so the seam does not seed the caller an owner row — the
 * caller's ONLY route to authority is the implicit-owner short-circuit, which
 * USERS-19 closes for non-`user:`/`anon:` tenants. Revert-visible: with the
 * shape guard removed, every 403 below becomes 201/200.
 */
describe('USERS-19 — a SAML-shaped session (personal === active, non-personal tenant) is NOT an implicit owner', () => {
  for (const SAML_TENANT of ['default', 'acme-corp']) {
    describe(`tenant \`${SAML_TENANT}\``, () => {
      const MEMBER = `oidc:saml-member-${SAML_TENANT}`;
      const SAML_ADMIN = `oidc:saml-admin-${SAML_TENANT}`;
      let targetId = '';

      beforeAll(async () => {
        // Found the tenant's workspace under a THIRD subject so the seam's
        // "first login founds + owns" branch never gives the member a row.
        await ensurePersonalWorkspace({ tenantId: SAML_TENANT, ownerSubject: `oidc:saml-founder-${SAML_TENANT}`, name: 'SAML tenant' });
        await createMember({ orgId: SAML_TENANT, tenantId: SAML_TENANT, displayName: 'SAML admin', subject: userIdFor(SAML_TENANT, SAML_ADMIN), roles: ['admin'] });
        const admin = await login(SAML_ADMIN, SAML_TENANT, false);
        const created = await call(admin, 'POST', USERS, { principalId: `saml:target-${SAML_TENANT}` });
        const text = await created.text();
        expect(created.status, text).toBe(201);
        targetId = (JSON.parse(text) as { userId: string }).userId;
      });

      it('precondition: the member IS seated in the tenant (list → 200), so the refusals are scope, not tenancy', async () => {
        const cookie = await login(MEMBER, SAML_TENANT, false);
        const res = await call(cookie, 'GET', USERS);
        expect(res.status).toBe(200);
        // …and the shape is the SAML one: the cookie's personal tenant IS the active tenant.
        const payload = JSON.parse(Buffer.from((cookie.split('=')[1] ?? '').split('.')[0] ?? '', 'base64url').toString('utf8')) as { tenantId: string; personalTenant?: string };
        expect(payload.tenantId).toBe(SAML_TENANT);
        expect(payload.personalTenant).toBe(SAML_TENANT);
      });

      it('a plain member with NO owner membership is REFUSED create / disable / PATCH / delete (403 forbidden_scope)', async () => {
        const cookie = await login(MEMBER, SAML_TENANT, false);
        const created = await call(cookie, 'POST', USERS, { principalId: 'saml:nope' });
        expect(created.status).toBe(403);
        expect(((await created.json()) as { error?: string }).error).toBe('forbidden_scope');
        expect((await call(cookie, 'POST', `${USERS}/${encodeURIComponent(targetId)}/disable`)).status).toBe(403);
        expect((await call(cookie, 'PATCH', `${USERS}/${encodeURIComponent(targetId)}`, { displayName: 'x' })).status).toBe(403);
        expect((await call(cookie, 'DELETE', `${USERS}/${encodeURIComponent(targetId)}`)).status).toBe(403);
      });

      it('an ADMIN member of the same tenant still passes (201 / 200) — membership, not ownership', async () => {
        const admin = await login(SAML_ADMIN, SAML_TENANT, false);
        const created = await call(admin, 'POST', USERS, { principalId: `saml:admin-made-${SAML_TENANT}` });
        expect(created.status).toBe(201);
        expect((await call(admin, 'POST', `${USERS}/${encodeURIComponent(targetId)}/disable`)).status).toBe(200);
        expect((await call(admin, 'PATCH', `${USERS}/${encodeURIComponent(targetId)}`, { displayName: 'renamed' })).status).toBe(200);
      });
    });
  }

  it('POSITIVE: a `user:` personal owner with NO membership row still passes (the short-circuit is kept for personal shapes)', async () => {
    const PERSONAL = 'user:solo-usersr19';
    // Found the personal workspace under a different subject so the seam seeds
    // NO owner row for the caller — only the implicit short-circuit can pass.
    await ensurePersonalWorkspace({ tenantId: PERSONAL, ownerSubject: 'oidc:someone-else', name: 'Personal' });
    const cookie = await login('oidc:solo-user19', PERSONAL, false);
    const created = await call(cookie, 'POST', USERS, { principalId: 'oidc:solo-made' });
    const text = await created.text();
    expect(created.status, text).toBe(201);
    const { userId } = JSON.parse(text) as { userId: string };
    expect((await call(cookie, 'PATCH', `${USERS}/${encodeURIComponent(userId)}`, { displayName: 'mine' })).status).toBe(200);
  });
});
