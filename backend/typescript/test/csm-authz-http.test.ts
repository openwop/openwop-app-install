/**
 * ADR 0582 §2/§3 — the CSM HTTP authority surface (CSM-1, CSM-2, CSM-10).
 *
 * Until 2026-08-18 `requireEnabled` (toggle + entitlement) was the ENTIRE gate
 * on all four CSM routes, and `crmRef.orgId` — body-supplied — was resolved
 * against CRM without ever asking whether the CALLER may read that org. So in a
 * shared SSO/SCIM/`ws:` workspace any member, a VIEWER included, could create,
 * rename, re-score, re-link and DELETE rows carrying ARR, renewal dates and
 * owner attribution; and any of them could probe "does company X exist in org
 * Y" (201 vs 404) for every org in the tenant and persist a readable link into
 * an org they have no scope in.
 *
 * WHY NOTHING CAUGHT IT. Every request in `csm-feature.test.ts` authenticates
 * with ONE operator bearer (`dev-token`), which carries `tenants: ['*']` — the
 * wildcard escape hatch every scope gate in this host honours. A wildcard
 * principal cannot witness a scope gate: it is admitted by construction whether
 * the gate exists or not. There was no test with a real user principal at all,
 * so there was nothing that COULD go red.
 *
 * THE FIXTURE (the ADR 0554 §P3 recipe, production path). Sign in to the
 * personal tenant exactly as OIDC leaves you, register membership under the
 * resulting HOME `userId`, then `/workspaces/:id/switch`. Two properties make
 * this the honest fixture rather than the derive-the-subject shortcut:
 *   1. `sharedWorkspace` semantics — the caller's ACTIVE tenant is somebody
 *      else's workspace, so `isOwnPersonalWorkspace` is FALSE and
 *      `requireTenantScope` actually consults membership instead of
 *      short-circuiting on the implicit-personal-owner branch (the GC-1 seam
 *      that made refusals unprovable);
 *   2. CSM stacks TWO gates that key identity DIFFERENTLY —
 *      `requireTenantScope` on `callerSubject(req)` (`req.userId`) and
 *      `requireOrgScope` on `resolveCallerUser(req).userId` (the canonical HOME
 *      user). Under the switch path the two agree (they are the same row), so a
 *      403 from the org gate is the ORG gate's and a 403 from the tenant gate is
 *      the TENANT gate's. Under the derive shortcut they disagree and every
 *      crmRef leg would 403 for the wrong reason — green, and meaningless.
 *
 * WHAT EACH LEG DISCRIMINATES (all of these PASSED before the fix — that is the
 * point):
 *   viewer   → GET 200 (read is granted, so a 403 everywhere is not the fix)
 *              and POST/PATCH/DELETE EXACTLY 403;
 *   editor   → all four admitted (the gate is not simply closed);
 *   outsider → fail-closed (no membership ⇒ no scopes);
 *   crmRef   → an editor with full tenant-write but NO scope in the target org
 *              gets 403 on both POST and PATCH, and the account is NOT created —
 *              while the org's own member gets 201. The refusal must not be a
 *              404, which is what the missing-company answer is: a 403 here says
 *              "you may not ask", never "it is not there".
 *
 * SABOTAGE-WITNESSED (grade-tests w7): removing `requireTenantScope`, or relaxing
 * any write route to `workspace:read`, reds the viewer case; removing the org gate
 * (`requireOrgScope` / either `authorizeCrmRefOrg` call) reds the CSM-2 legs; running
 * the org gate on a `crmRef: null` clear reds the clear case; a DELETE that answers
 * 204 without deleting reds the editor case.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { createWorkspace, createMember, createOrg } from '../src/host/accessControlService.js';
import { enableTenantOverride } from '../src/host/featureToggles/service.js';
import { __resetCsmStore } from '../src/features/csm/accountsService.js';

let server: Server;
let BASE = '';
let WS = '';
const CSM = '/host/openwop-app/csm/accounts';

interface Res<T> { status: number; body: T }
interface CrmRefBody { orgId: string; companyId: string }
interface AccountBody { accountId: string; name: string; crmRef?: CrmRefBody }
interface AccountList { accounts: AccountBody[] }

async function call<T = unknown>(cookie: string, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  return { status: res.status, body: parsed as T };
}

/**
 * The PRODUCTION identity path — personal sign-in, membership under the HOME
 * userId, then switch into the shared workspace. See the header for why the
 * derive-the-subject shortcut would make the crmRef legs vacuous.
 */
const userIdOf = new Map<string, string>();
async function member(subject: string, roles: string[]): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, displayName: subject }), // NO tenantId: personal tenant, as OIDC leaves you
  });
  expect(res.status, 'test seam must mint a personal session').toBeLessThan(300);
  const personalCookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const { user } = (await res.json()) as { user: { userId: string } };
  userIdOf.set(subject, user.userId);
  await createMember({ orgId: WS, tenantId: WS, displayName: subject, subject: user.userId, roles });
  const sw = await fetch(`${BASE}/host/openwop-app/workspaces/${encodeURIComponent(WS)}/switch`, {
    method: 'POST', headers: { cookie: personalCookie },
  });
  expect(sw.status, `switch into WS must succeed: ${await sw.clone().text()}`).toBe(200);
  return (sw.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

/** A caller with NO membership in WS at all — signs in, switches nowhere. */
async function outsiderSession(subject: string): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, tenantId: WS, displayName: subject, sharedWorkspace: true }),
  });
  expect(res.status).toBeLessThan(300);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

let viewer = '';
let editor = '';
let outsider = '';
/** The org `linker` owns and `editor` has no membership in. */
let foreignOrgId = '';
let foreignCompanyId = '';
let linker = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  // The de-facto-owner bypass in `resolveEffectiveAccess` hands OWNER scopes to
  // any subject with no member row. It is demo-only, but it would make every
  // refusal below pass vacuously — as an owner.
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  await __resetCsmStore();

  const ws = await createWorkspace({ name: 'CSM authz workspace', ownerSubject: 'oidc:csmauthz-owner' });
  WS = ws.orgId ?? ws.tenantId;
  // The TOGGLE gate runs before the scope gate and 404s when off — without this
  // every 403 assertion below would instead read 404 and prove nothing.
  await enableTenantOverride('csm', WS, 'csm-authz-test');
  await enableTenantOverride('crm', WS, 'csm-authz-test');
  await enableTenantOverride('users', WS, 'csm-authz-test');

  viewer = await member('oidc:csmauthz-viewer', ['viewer']);
  editor = await member('oidc:csmauthz-editor', ['editor']);
  linker = await member('oidc:csmauthz-linker', ['editor']);
  outsider = await outsiderSession('oidc:csmauthz-outsider');

  // `linker` creates an org (becoming its owner) with one company. `editor` has
  // tenant-wide write but NO membership in this org — the CSM-2 subject.
  // ADR 0815 D1a — a workspace EDITOR may not create a sub-org over HTTP any more
  // (that was the sub-org door); the org is minted directly with `linker` as its
  // owner, the shape an owner's `POST /orgs` produces. This suite is about CSM.
  const linkerId = userIdOf.get('oidc:csmauthz-linker')!;
  foreignOrgId = (await createOrg({ tenantId: WS, createdBy: linkerId, name: 'Foreign Org', ownerSubject: linkerId })).orgId;
  const company = await call<{ companyId: string }>(linker, 'POST', `/host/openwop-app/crm/orgs/${encodeURIComponent(foreignOrgId)}/companies`, { name: 'Foreign Co' });
  expect(company.status, JSON.stringify(company.body)).toBe(201);
  foreignCompanyId = company.body.companyId;
});

afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('CSM-1 — RBAC on all four routes (requireTenantScope)', () => {
  it('an EDITOR is admitted on every route (the gate is not simply closed)', async () => {
    const created = await call<AccountBody>(editor, 'POST', CSM, { name: 'Editor Co', healthScore: 40 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.accountId;
    const listed = await call<AccountList>(editor, 'GET', CSM);
    expect(listed.status).toBe(200);
    expect(listed.body.accounts.map((a) => a.accountId)).toContain(id);
    const patched = await call<AccountBody>(editor, 'PATCH', `${CSM}/${encodeURIComponent(id)}`, { name: 'Renamed' });
    expect(patched.status).toBe(200);
    expect(patched.body.name, 'the admitted PATCH must actually apply').toBe('Renamed');
    expect((await call(editor, 'DELETE', `${CSM}/${encodeURIComponent(id)}`)).status).toBe(204);
    // An admitted DELETE must actually delete — a 204 over a surviving row is not admission.
    const after = await call<AccountList>(editor, 'GET', CSM);
    expect(after.body.accounts.map((a) => a.accountId)).not.toContain(id);
  });

  it('a VIEWER can READ but is refused 403 on create, patch and delete', async () => {
    // A row to aim the write legs at — created by someone who may.
    const seed = await call<AccountBody>(editor, 'POST', CSM, { name: 'Viewer Target', healthScore: 55 });
    expect(seed.status, JSON.stringify(seed.body)).toBe(201);
    const id = seed.body.accountId;

    // Read is GRANTED — `workspace:read` is a viewer scope. A blanket 403 would
    // not be the fix, so this leg is what stops the gate being over-tight.
    const list = await call<AccountList>(viewer, 'GET', CSM);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.accounts.some((a) => a.accountId === id)).toBe(true);

    // ...and every WRITE is refused. Before ADR 0582 all three were 201/200/204.
    expect((await call(viewer, 'POST', CSM, { name: 'Viewer Made This' })).status).toBe(403);
    expect((await call(viewer, 'PATCH', `${CSM}/${encodeURIComponent(id)}`, { name: 'Viewer Renamed' })).status).toBe(403);
    expect((await call(viewer, 'DELETE', `${CSM}/${encodeURIComponent(id)}`)).status).toBe(403);

    // The refusals were REFUSALS, not 403s over an already-applied write.
    const after = await call<AccountList>(editor, 'GET', CSM);
    const row = after.body.accounts.find((a) => a.accountId === id);
    expect(row, 'the delete must not have landed').toBeTruthy();
    expect(row!.name).toBe('Viewer Target');
  });

  // MEASURED, and stated because a green leg that cannot go red is worse than
  // no leg: this one does NOT discriminate the fix. With `requireTenantScope`
  // removed it still passes, because `middleware/auth.ts` bounces a non-member
  // out of the shared workspace to their personal tenant, where the `csm`
  // toggle is off and the route 404s. It is here for the fail-closed property
  // (no path admits a non-member), not as a witness for CSM-1 — the viewer
  // block above is that witness.
  it('a caller with NO membership in the workspace is refused fail-closed', async () => {
    // A refusal, not a crash: 403 (scope gate) or 404 (bounced to a tenant
    // where CSM is off). A 500 is not "fail-closed", it is broken.
    const list = await call(outsider, 'GET', CSM);
    expect([403, 404]).toContain(list.status);
    const created = await call(outsider, 'POST', CSM, { name: 'Outsider Co' });
    expect([403, 404]).toContain(created.status);
    // ...and the refused create left nothing behind in the workspace.
    const book = await call<AccountList>(editor, 'GET', CSM);
    expect(book.body.accounts.map((a) => a.name)).not.toContain('Outsider Co');
  });
});

describe('CSM-2 — a body-supplied crmRef.orgId is authorized against the caller', () => {
  it('the org OWNER can link (the control — the gate admits a real grant)', async () => {
    const created = await call<AccountBody>(linker, 'POST', CSM, {
      name: 'Linked By Owner',
      crmRef: { orgId: foreignOrgId, companyId: foreignCompanyId },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.crmRef).toEqual({ orgId: foreignOrgId, companyId: foreignCompanyId });
  });

  it('a tenant-write caller with NO scope in the target org gets 403 — not the 201/404 existence oracle', async () => {
    const created = await call(editor, 'POST', CSM, {
      name: 'Should Not Link',
      crmRef: { orgId: foreignOrgId, companyId: foreignCompanyId },
    });
    // Pre-fix this was 201 for a real company and 404 for an invented one — a
    // usable oracle over every org in the tenant. Both must now be 403: the
    // answer may not depend on whether the company exists.
    expect(created.status, JSON.stringify(created.body)).toBe(403);
    const invented = await call(editor, 'POST', CSM, {
      name: 'Should Not Link Either',
      crmRef: { orgId: foreignOrgId, companyId: 'cmp:does-not-exist' },
    });
    expect(invented.status, 'the refusal must not distinguish existing from absent').toBe(403);

    // And nothing was persisted by either attempt.
    const list = await call<AccountList>(editor, 'GET', CSM);
    const names = list.body.accounts.map((a) => a.name);
    expect(names).not.toContain('Should Not Link');
    expect(names).not.toContain('Should Not Link Either');
  });

  it('the PATCH re-link lane is gated the same way (a re-link is the same authority decision)', async () => {
    const own = await call<AccountBody>(editor, 'POST', CSM, { name: 'Unlinked Co' });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const id = own.body.accountId;
    const patched = await call(editor, 'PATCH', `${CSM}/${encodeURIComponent(id)}`, {
      crmRef: { orgId: foreignOrgId, companyId: foreignCompanyId },
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(403);
    const list = await call<AccountList>(editor, 'GET', CSM);
    const row = list.body.accounts.find((a) => a.accountId === id);
    expect(row?.crmRef, 'the refused link must not have landed').toBeUndefined();
  });

  it('clearing a link (crmRef: null) touches no org and stays available', async () => {
    const created = await call<AccountBody>(linker, 'POST', CSM, {
      name: 'Linked Then Cleared',
      crmRef: { orgId: foreignOrgId, companyId: foreignCompanyId },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const cleared = await call<AccountBody>(linker, 'PATCH', `${CSM}/${encodeURIComponent(created.body.accountId)}`, { crmRef: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.crmRef).toBeUndefined();
  });
});
