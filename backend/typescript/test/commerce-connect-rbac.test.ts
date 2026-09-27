/**
 * MPL-2 — RBAC on the 12 tenant-facing commerce-connect routes.
 *
 * COUNT CORRECTED (review fold-in): this said 11, and `DELETE …/listings/:packName`
 * — added two commits later, gated by the same `authorizeTenant` — was never
 * exercised. The authority for the number is the call sites, not this prose:
 *   grep -c 'await authorizeTenant(req' \
 *     backend/typescript/src/features/commerce-connect/routes.ts   → 12
 *
 * Until 2026-08-19 this grep returned NOTHING:
 *
 *   grep -n 'authorizeOrgScope\|requireTenantScope\|workspace:write\|resolveCallerUser' \
 *     backend/typescript/src/features/commerce-connect/routes.ts
 *
 * `requireFeatureEnabled` checks the toggle and the ADR 0419 bundle entitlement,
 * never a role. So in a shared `ws:`/SSO workspace ANY member — a **viewer** —
 * could `PUT …/listings/:packName` to set the workspace's price, lane and
 * **external payout URL** (an arbitrary https destination the operator card then
 * attributes to the whole workspace, not to the submitter), and could start money
 * movement with `POST …/purchase/checkout`. Money redirection by the
 * lowest-privileged role.
 *
 * WHY NOTHING CAUGHT IT. Every pre-existing commerce-connect HTTP suite either
 * authenticates with the `dev-token` bearer (`tenants: ['*']` — the wildcard
 * escape hatch every scope gate honours, so it cannot witness a gate) or logs in
 * with a plain `test/login`, which lands the caller in their OWN personal tenant
 * where `isOwnPersonalWorkspace` short-circuits `requireTenantScope` by design.
 * Neither fixture can go red on a missing role check.
 *
 * REACHABILITY PER LANE — the point of this file. A branch assumed unreachable is
 * how this class survives, so every lane gets its own assertion:
 *   OWNER    → admitted on read AND write (a gate that blocks the owner is a wall);
 *   ADMIN    → admitted on read AND write;
 *   EDITOR   → admitted on read AND write (write is editor+, not admin-only);
 *   VIEWER   → read 200, and EXACTLY 403 on all five writes — the defect;
 *   OUTSIDER → fail-closed on reads too (no membership ⇒ zero scopes);
 *   NOBODY   → a MEMBER holding no roles: survives the ADR 0015 tenancy re-check,
 *              then resolves to zero scopes. Added in the review fold-in because
 *              it is the only lane whose refusal is attributable to the SCOPE
 *              gate on a READ — see its describe block for why OUTSIDER is not;
 *   ANON     → NOT refused here. An `anon:<sid>` caller acts inside their own
 *              personal workspace, so the implicit-owner short-circuit admits
 *              them by design. That is precisely why MPL-1's GEN-CC-1 fold guard
 *              is a SEPARATE predicate and not a role check — pinned in
 *              `commerce-connect-anon-fold-guard.test.ts`. Asserted here so the
 *              branch is measured, not assumed away.
 *   SYSTEM   → the wildcard operator principal is still admitted (operator
 *              tooling and the conformance harness must keep working).
 *
 * The fixture is the ADR 0554 §P3 production path (personal sign-in → membership
 * under the HOME `userId` → `/workspaces/:id/switch`), because the derive-the-
 * subject shortcut leaves `isOwnPersonalWorkspace` true and every 403 below
 * would be unfalsifiable.
 *
 * SABOTAGE PROBE, RE-RUN at the review fold-in (not asserted): replacing the body
 * of `authorizeTenant`'s `await requireTenantScope(req, scope)` with a comment
 * reddens EXACTLY four cases — **4 failed / 11 passed**, measured, not recalled:
 *   • a viewer is refused EXACTLY 403 on all five writes
 *   • the refused listing write left NO row behind
 *   • NOBODY: every read refuses with forbidden_scope / workspace:read
 *   • NOBODY: every write refuses with forbidden_scope / workspace:write
 *
 * It was 2 failed / 11 passed before the NOBODY lane existed, and the two cases
 * it gained are the ones that matter: **nothing in this file discriminated the
 * READ gate at all** until then. The viewer holds `workspace:read`, so every
 * viewer read assertion passes whether or not the read gate exists.
 *
 * WHAT THIS PROBE STILL DOES NOT DISCRIMINATE, stated so a later reader does not
 * over-read the green: the OUTSIDER cases. A non-member is bounced by the ADR
 * 0015 re-check to a tenant where the toggle is off, so those refusals measure
 * the TOGGLE, not the scope gate — which is exactly the hole the NOBODY lane was
 * added to fill, rather than by widening OUTSIDER's expectation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { enableTenantOverride } from '../src/host/featureToggles/service.js';
import { __resetCommerceConnect } from '../src/features/commerce-connect/stores.js';

let server: Server;
let BASE = '';
let WS = '';
const B = '/v1/host/openwop-app/commerce-connect';

interface Res<T = any> { status: number; body: T }

async function call<T = any>(auth: Record<string, string>, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T };
}

const cookie = (c: string): Record<string, string> => ({ cookie: c });

/** Personal sign-in → membership under the HOME userId → switch into WS. */
async function member(subject: string, roles: string[]): Promise<string> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, displayName: subject }),
  });
  expect(res.status).toBeLessThan(300);
  const personal = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const { user } = (await res.json()) as { user: { userId: string } };
  await createMember({ orgId: WS, tenantId: WS, displayName: subject, subject: user.userId, roles });
  const sw = await fetch(`${BASE}/v1/host/openwop-app/workspaces/${encodeURIComponent(WS)}/switch`, {
    method: 'POST', headers: { cookie: personal },
  });
  expect(sw.status, `switch into WS must succeed: ${await sw.clone().text()}`).toBe(200);
  return (sw.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

/** Signed in, active in WS, but holding NO member row there. */
async function outsiderSession(subject: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, tenantId: WS, displayName: subject, sharedWorkspace: true }),
  });
  expect(res.status).toBeLessThan(300);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

let owner = '';
let admin = '';
let editor = '';
let viewer = '';
let outsider = '';
let nobody = '';

/** The five tenant-facing WRITES — every one of them moves, redirects, or
 *  destroys a money-bearing claim. `DELETE …/listings/:packName` was gated from
 *  the start but ABSENT from this array until the review fold-in: it releases the
 *  seller's claim on a pack name so that another workspace can take it
 *  immediately, which is precisely the kind of write a viewer must not reach. */
const WRITES: Array<[string, string, unknown]> = [
  ['POST', `${B}/seller/onboard`, {}],
  ['POST', `${B}/seller/sync`, {}],
  ['POST', `${B}/purchase/checkout`, { packName: 'vendor.rbac.nodes' }],
  ['PUT', `${B}/listings/vendor.rbac.nodes`, { lane: 'external-link', externalPaymentUrl: 'https://attacker.example/pay' }],
  ['DELETE', `${B}/listings/vendor.rbac.nodes`, undefined],
];

/** The seven tenant-facing READS. */
const READS: string[] = [
  `${B}/seller`, `${B}/listings`, `${B}/orders`, `${B}/orders/cco_nope`,
  `${B}/payouts`, `${B}/seller/stats`, `${B}/seller/listings`,
];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  // The demo-mode de-facto-owner bypass hands OWNER scopes to any subject with no
  // member row — it would make every refusal below pass vacuously, as an owner.
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  await __resetCommerceConnect();

  const ws = await createWorkspace({ name: 'CC RBAC workspace', ownerSubject: 'oidc:ccrbac-founder' });
  WS = ws.orgId ?? ws.tenantId;
  // The TOGGLE gate runs BEFORE the scope gate and 404s when off — without this
  // every 403 assertion below would read 404 instead and prove nothing.
  await enableTenantOverride('commerce-connect', WS, 'cc-rbac-test');
  await enableTenantOverride('users', WS, 'cc-rbac-test');

  owner = await member('oidc:ccrbac-owner', ['owner']);
  admin = await member('oidc:ccrbac-admin', ['admin']);
  editor = await member('oidc:ccrbac-editor', ['editor']);
  viewer = await member('oidc:ccrbac-viewer', ['viewer']);
  outsider = await outsiderSession('oidc:ccrbac-outsider');
  // A member row with NO roles. `scopesForRoles([])` is the empty set
  // (`accessControlService.ts:279` — unknown/absent roles grant nothing), so this
  // caller SURVIVES the ADR 0015 tenancy re-check (they are a member of WS, so
  // they are not bounced to their personal tenant) and then resolves to zero
  // scopes. That combination is what the OUTSIDER lane could not produce.
  nobody = await member('oidc:ccrbac-nobody', []);
});

afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('MPL-2 — the VIEWER lane (the defect)', () => {
  it('a viewer may READ every tenant-facing route', async () => {
    for (const path of READS) {
      const res = await call(cookie(viewer), 'GET', path);
      // 404 is legitimate on `/orders/:orderId` for an order that does not exist;
      // what must NEVER appear is 401/403 — a viewer holds `workspace:read`.
      expect([401, 403], `${path} must stay readable for a viewer`).not.toContain(res.status);
    }
  });

  it('a viewer is refused EXACTLY 403 on all five writes — including the payout-URL write and the name-releasing DELETE', async () => {
    // EVERY write is attempted before ANY assertion. A `for` loop that throws on
    // the first case would leave the later writes un-issued, which silently makes
    // the "no row behind" case below vacuous under exactly the sabotage this file
    // is meant to detect (measured: the listing PUT never fired).
    const results = await Promise.all(WRITES.map(async ([method, path, body]) =>
      [method, path, await call(cookie(viewer), method, path, body)] as const));
    for (const [method, path, res] of results) {
      expect(res.status, `${method} ${path} must be 403 for a viewer, got ${res.status} ${JSON.stringify(res.body)}`).toBe(403);
      // The 403 must come from the SCOPE gate, not from some downstream domain
      // refusal that happens to share the status — otherwise removing the gate
      // could leave this green.
      expect(res.body?.error, `${method} ${path} error code`).toBe('forbidden_scope');
      expect(res.body?.details?.requiredScope).toBe('workspace:write');
    }
  });

  it('the refused listing write left NO row behind — the refusal is before the effect', async () => {
    // A 403 that still wrote the row would be worse than no gate: the operator
    // queue would carry a listing whose submitter was never authorized.
    const own = await call(cookie(editor), 'GET', `${B}/seller/listings`);
    expect(own.status).toBe(200);
    expect((own.body.listings as Array<{ packName: string }>).some((l) => l.packName === 'vendor.rbac.nodes')).toBe(false);
  });
});

describe('MPL-2 — the gate is not simply closed', () => {
  for (const [label, who] of [['OWNER', () => owner], ['ADMIN', () => admin], ['EDITOR', () => editor]] as const) {
    it(`an ${label} is admitted on the listing write (not 401/403)`, async () => {
      const res = await call(cookie(who()), 'PUT', `${B}/listings/vendor.rbac-${label.toLowerCase()}.nodes`, {
        lane: 'external-link', externalPaymentUrl: 'https://seller.example/pay',
      });
      expect([401, 403], `${label} must reach the handler; got ${res.status} ${JSON.stringify(res.body)}`).not.toContain(res.status);
      expect(res.status).toBe(200);
    });

    it(`an ${label} is admitted on the reads`, async () => {
      for (const path of READS) {
        const res = await call(cookie(who()), 'GET', path);
        expect([401, 403], `${label} ${path}`).not.toContain(res.status);
      }
    });
  }
});

describe('MPL-2 — the OUTSIDER lane fails closed', () => {
  it('a signed-in non-member of the workspace is refused on reads AND writes', async () => {
    // MEASURED, not assumed: the ADR 0015 re-check in the auth middleware bounces
    // a non-member out of `WS` and back to their OWN personal tenant, where the
    // `commerce-connect` toggle is off — so the refusal arrives as the toggle
    // 404 rather than the scope 403. Both are refusals and both are fail-closed;
    // asserting only 403 here would have been a false expectation. What must
    // never appear is a 2xx.
    for (const path of READS) {
      const res = await call(cookie(outsider), 'GET', path);
      expect([401, 403, 404], `${path} must refuse a non-member, got ${res.status}`).toContain(res.status);
    }
    for (const [method, path, body] of WRITES) {
      const res = await call(cookie(outsider), method, path, body);
      expect([401, 403, 404], `${method} ${path} must refuse a non-member, got ${res.status}`).toContain(res.status);
    }
  });

  it('the outsider never reaches a 2xx on any of the twelve routes', async () => {
    for (const path of READS) expect((await call(cookie(outsider), 'GET', path)).status).toBeGreaterThanOrEqual(400);
    for (const [method, path, body] of WRITES) expect((await call(cookie(outsider), method, path, body)).status).toBeGreaterThanOrEqual(400);
  });
});

/**
 * The lane that makes the READ gate falsifiable (review fold-in).
 *
 * The OUTSIDER lane above cannot do this and the file said so: a non-member is
 * bounced by the ADR 0015 re-check into a tenant where the toggle is OFF, so its
 * refusal arrives as a 404 and `expect([401,403,404])` cannot tell a toggle 404
 * from a scope 403. A member row with NO roles survives that re-check — the
 * caller stays in WS, where the toggle is ON — and then resolves to zero scopes.
 * So every refusal here is attributable to the SCOPE gate and nothing else.
 *
 * ASSERTING THE ERROR CODE, NOT THE STATUS, IS WHAT MAKES IT NON-VACUOUS: 403 is
 * a status a dozen downstream domain refusals also return, and `forbidden_scope`
 * + `details.requiredScope` are emitted at exactly one place
 * (`accessControlService.ts:490`). This is also the ONLY case in the file that
 * discriminates the READ gate — the viewer holds `workspace:read`, so every
 * other read assertion passes whether or not the read gate exists.
 */
describe('MPL-2 — a MEMBER with no roles is refused by the SCOPE gate on reads AND writes', () => {
  it('every read refuses with forbidden_scope / workspace:read', async () => {
    for (const path of READS) {
      const res = await call(cookie(nobody), 'GET', path);
      expect(res.status, `${path} got ${res.status} ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body?.error, `${path} error code`).toBe('forbidden_scope');
      expect(res.body?.details?.requiredScope, `${path} requiredScope`).toBe('workspace:read');
    }
  });

  it('every write refuses with forbidden_scope / workspace:write', async () => {
    // Issue all of them before asserting — the `for`-loop-throws-first hazard the
    // viewer case documents applies identically here.
    const results = await Promise.all(WRITES.map(async ([method, path, body]) =>
      [method, path, await call(cookie(nobody), method, path, body)] as const));
    for (const [method, path, res] of results) {
      expect(res.status, `${method} ${path} got ${res.status} ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body?.error, `${method} ${path} error code`).toBe('forbidden_scope');
      expect(res.body?.details?.requiredScope, `${method} ${path} requiredScope`).toBe('workspace:write');
    }
  });
});

describe('MPL-2 — the SYSTEM lane still works (the wildcard escape hatch)', () => {
  it('the wildcard operator principal reaches the seller read', async () => {
    // `requireTenantScope` short-circuits `tenants: ['*']` on purpose: operator
    // tooling and the conformance harness would otherwise 403 on every route.
    const res = await call({ authorization: 'Bearer dev-token' }, 'GET', `${B}/seller`);
    expect([401, 403], `wildcard principal must not be fenced out; got ${res.status}`).not.toContain(res.status);
  });
});

describe('MPL-2 — the ANON lane is NOT closed by RBAC (measured, not assumed)', () => {
  it('an anon session passes the role gate via the implicit personal-owner branch', async () => {
    // This is the honest statement of what RBAC does and does not do here. An
    // `anon:<sid>` caller's ACTIVE tenant IS their personal workspace, so
    // `isOwnPersonalWorkspace` short-circuits before any scope is resolved.
    // Closing the anon lane is MPL-1's fold guard, a different predicate at a
    // different layer — see `commerce-connect-anon-fold-guard.test.ts`.
    const { isOwnPersonalWorkspace } = await import('../src/host/requestSubject.js');
    const anonReq = { tenantId: 'anon:sid-1', personalTenant: 'anon:sid-1' } as unknown as Parameters<typeof isOwnPersonalWorkspace>[0];
    expect(isOwnPersonalWorkspace(anonReq)).toBe(true);
  });
});
