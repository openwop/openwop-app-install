/**
 * ADR 0554 P3 — the compensation recovery routes, at the HTTP BOUNDARY.
 *
 * WHY THIS FILE EXISTS BESIDE THE THREE SERVICE-LEVEL SUITES. Route-level
 * authorization, the scope LADDER as a real member of a real org resolves it,
 * cross-tenant neutralization, and the flat error envelope are only observable
 * through the boundary. A service-level suite can assert
 * `scopesForRoles('admin')` does not contain `:waive` and still ship a route
 * that never checks it — the two are different claims, and only this one says
 * the WIRE refuses.
 *
 * The load-bearing leg is `an ADMIN member is 403 on a waive and 200 on a
 * retry`. It is the only assertion in the change that proves the three scope ids
 * are a permission model rather than three strings.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
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
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({
    port: 0, storageDsn: 'memory://', serviceName: 'test',
    serviceVersion: '0.0.1', enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res();
    });
  });
  // The `operations` toggle gates the whole surface with a uniform 404, and it
  // is OFF by default. Without this every leg below passes for the WRONG reason:
  // the cross-tenant 404 legs in particular would be asserting the toggle, not
  // the RFC 0132 neutralization they are named for. Measured — the first run of
  // this file had exactly that shape.
  const d = getToggleDefault('operations');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) {
      const m = /(__session=[^;]+)/.exec(ck);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

let n = 0;
/**
 * `sharedWorkspace: true` IS LOAD-BEARING, and omitting it makes every 403 leg
 * in this file unfalsifiable.
 *
 * The auth test seam collapses `personalTenant` onto the requested `tenantId` by
 * default, which makes `isOwnPersonalWorkspace` true — and that short-circuits
 * `requireTenantScope` (among six authorization chokes). MEASURED here: the
 * first run of this file had an EDITOR passing the waive gate. `authTestSeam.ts`
 * documents this exact trap as GC-1: "an RBAC test could not deny authority the
 * seam had already granted".
 *
 * Declaring the workspace shared yields honest, membership-derived authority,
 * which is the thing these tests are about.
 */
async function signup(c: Client, tenantId: string, shared: boolean, email: string): Promise<string> {
  const r = await c.post('/v1/host/openwop-app/test/login', {
    email, tenantId, ...(shared ? { sharedWorkspace: true } : {}),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId as string;
}

/**
 * An org founded by `founder`, plus one client per requested ROLE.
 *
 * THREE THINGS HERE ARE LOAD-BEARING, and getting any of them wrong makes every
 * 403 leg in this file unfalsifiable. All three were MEASURED, in this order,
 * against a first draft that had an EDITOR sailing through the waive gate:
 *
 *  1. Members sign up with `sharedWorkspace: true`. By default the auth test
 *     seam collapses `personalTenant` onto the requested `tenantId`, which makes
 *     `isOwnPersonalWorkspace` true and short-circuits `requireTenantScope`
 *     (among six authorization chokes). `authTestSeam.ts` documents this as
 *     GC-1: "an RBAC test could not deny authority the seam had already
 *     granted".
 *  2. They are added to the WORKSPACE-ROOT org (`orgId === tenantId`), not to a
 *     freshly created one. `isWorkspaceMember` matches on
 *     `m.orgId === workspaceId`, so membership in any other org leaves the
 *     caller a non-member and `middleware/auth.ts` bounces their session back to
 *     their personal tenant — where they resolve `basis: 'none'` and the route
 *     404s before authority is ever consulted.
 *  3. They RE-LOGIN with the same email afterwards. Membership is evaluated at
 *     session MINT, so the first session predates the member row.
 *
 * The founder signs up WITHOUT `sharedWorkspace`, so the tenant is their home
 * and the run they create lands in it. Every authority assertion below is made
 * against a MEMBER, never the founder: a founder passes via the
 * personal-workspace short-circuit, so a leg asserted on them would measure the
 * seam rather than the scope.
 *
 * > This recipe also closes the HTTP half of GC-1, which
 * > `test/kicktodo-authz-scope.test.ts` still records as OPEN ("the `test/login`
 * > seam cannot mint that today"). That header predates the `sharedWorkspace`
 * > flag and is now stale — the session model did not need to change.
 */
async function orgWith(roles: readonly string[]): Promise<{
  founder: Client; members: Record<string, Client>; runId: string; tenantId: string;
}> {
  const tenantId = `org:cmp-${Date.now()}-${n++}`;
  const founder = client();
  await signup(founder, tenantId, false, `cmp-f-${Date.now()}-${n++}@acme.test`);

  // The workspace-root org the seam founded. NOT a new one — see (2) above.
  const orgs = await founder.get('/v1/host/openwop-app/orgs');
  expect(orgs.status, JSON.stringify(orgs.body)).toBe(200);
  const wsOrgId = (orgs.body.orgs as Array<{ orgId: string }>)
    .find((o) => o.orgId === tenantId)?.orgId;
  expect(wsOrgId, `no workspace-root org for ${tenantId}`).toBeTruthy();

  const members: Record<string, Client> = {};
  for (const role of roles) {
    const c = client();
    const email = `cmp-${role}-${Date.now()}-${n++}@acme.test`;
    const uid = await signup(c, tenantId, true, email);
    const add = await founder.post(
      `/v1/host/openwop-app/orgs/${encodeURIComponent(wsOrgId!)}/members`,
      { displayName: role, subject: uid, roles: [role] },
    );
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    // Re-mint: membership is resolved at session mint — see (3) above.
    await signup(c, tenantId, true, email);
    members[role] = c;
  }

  // A real run in this tenant, so the routes reach their authorization checks
  // rather than short-circuiting on a missing run.
  const workflowId = `cmp.route.${n++}`;
  await founder.post('/v1/host/openwop-app/workflows', {
    workflowId,
    nodes: [{ nodeId: 'noop', typeId: 'core.echo', config: {} }],
    edges: [],
  });
  const create = await founder.post('/v1/runs', { workflowId });
  expect(create.status, JSON.stringify(create.body)).toBe(201);

  return { founder, members, runId: create.body.runId as string, tenantId };
}

const readPath = (runId: string) =>
  `/v1/host/openwop-app/operations/runs/${encodeURIComponent(runId)}/compensation`;
const actionPath = (runId: string) => `${readPath(runId)}/actions`;

describe('ADR 0554 P3 — the scope ladder AT THE WIRE', () => {
  /**
   * THE LEG THIS FILE EXISTS FOR. A service-level assertion that
   * `scopesForRoles('admin')` lacks `:waive` says nothing about whether the
   * ROUTE checks it. This says the wire refuses.
   */
  it('an ADMIN member is 403 on a WAIVE and NOT 403 on a retry', async () => {
    const { members, runId } = await orgWith(['admin']);
    const admin = members['admin']!;

    const waive = await admin.post(actionPath(runId), {
      obligationId: 'cmp_whatever', action: 'skip',
      expectedState: 'requested', reason: 'a reason',
    });
    expect(waive.status, JSON.stringify(waive.body)).toBe(403);
    expect(waive.body.error).toBe('forbidden_scope');
    expect(waive.body.details?.requiredScope).toBe('host:compensation:waive');

    // The retry gets PAST authorization. It then 404s on the made-up obligation
    // id, which is the point: the refusal above was the SCOPE, not the id.
    const retry = await admin.post(actionPath(runId), {
      obligationId: 'cmp_whatever', action: 'retry', expectedState: 'requested',
    });
    expect(retry.status).not.toBe(403);
  });

  it('an OWNER member is NOT 403 on a waive — the upper rung actually grants it', async () => {
    // A MEMBER holding the `owner` role, so the pass is membership-derived. The
    // founder would pass via the personal-workspace short-circuit and prove
    // nothing about the scope.
    const { members, runId } = await orgWith(['owner']);
    const waive = await members['owner']!.post(actionPath(runId), {
      obligationId: 'cmp_whatever', action: 'skip',
      expectedState: 'requested', reason: 'a reason',
    });
    expect(waive.status, JSON.stringify(waive.body)).not.toBe(403);
  });

  it('an EDITOR member is 403 on every recovery action AND on the read', async () => {
    const { members, runId } = await orgWith(['editor']);
    const editor = members['editor']!;

    for (const action of ['start', 'retry', 'skip', 'terminate', 'substitute']) {
      const r = await editor.post(actionPath(runId), {
        obligationId: 'cmp_x', action, expectedState: 'requested', reason: 'r',
      });
      expect(r.status, `${action}: ${JSON.stringify(r.body)}`).toBe(403);
    }
    expect((await editor.get(readPath(runId))).status).toBe(403);
  });

  it('substitute is gated on the WAIVE scope at the wire, not the retry scope', async () => {
    const { members, runId } = await orgWith(['admin']);
    const r = await members['admin']!.post(actionPath(runId), {
      obligationId: 'cmp_x', action: 'substitute',
      expectedState: 'requested', reason: 'r', nodeTypeId: 'core.echo',
    });
    expect(r.status).toBe(403);
    expect(r.body.details?.requiredScope).toBe('host:compensation:waive');
  });
});

describe('ADR 0554 P3 — tenant isolation', () => {
  /**
   * RFC 0132 §A.2 — a run in ANOTHER tenant and a run that does not exist must
   * answer identically. A 403 would confirm the run id is real, which is the one
   * fact being withheld.
   */
  it('answers 404 (never 403) for a run in another tenant, same as for a fiction', async () => {
    const a = await orgWith([]);
    const b = await orgWith([]);

    const foreign = await b.founder.get(readPath(a.runId));
    const fiction = await b.founder.get(readPath('run-does-not-exist'));

    expect(foreign.status).toBe(404);
    expect(fiction.status).toBe(404);
    // Indistinguishable, which is the whole requirement.
    expect(foreign.body.error).toBe(fiction.body.error);
    expect(foreign.body.message).toBe(fiction.body.message);
  });

  it('answers 404 for a cross-tenant ACTION too', async () => {
    const a = await orgWith([]);
    const b = await orgWith([]);
    const r = await b.founder.post(actionPath(a.runId), {
      obligationId: 'cmp_x', action: 'skip', expectedState: 'requested', reason: 'r',
    });
    expect(r.status).toBe(404);
  });

  it('an unauthenticated caller reaches neither route', async () => {
    const { runId } = await orgWith([]);
    const anon = client();  // no login
    expect((await anon.get(readPath(runId))).status).toBeGreaterThanOrEqual(400);
    expect((await anon.post(actionPath(runId), {
      obligationId: 'cmp_x', action: 'skip', expectedState: 'requested', reason: 'r',
    })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('ADR 0554 P3 — the flat S22 envelope on refusals', () => {
  it('rejects an unknown action with a flat envelope, before any authority check', async () => {
    const { founder, runId } = await orgWith([]);
    const r = await founder.post(actionPath(runId), {
      obligationId: 'cmp_x', action: 'delete-everything', expectedState: 'requested',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
    // `retriable` lives under `details` — a top-level one reads as `undefined`
    // to every peer that follows `rest-endpoints.md`.
    expect(r.body.details?.retriable).toBe(false);
    expect(r.body).not.toHaveProperty('retriable');
  });

  it('rejects a missing expectedState — without it a lost race is undetectable', async () => {
    const { founder, runId } = await orgWith([]);
    const r = await founder.post(actionPath(runId), { obligationId: 'cmp_x', action: 'retry' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
    expect(r.body.message).toMatch(/expectedState/);
  });

  it('rejects a waive with no reason at the wire, not only in the service', async () => {
    const { founder, runId } = await orgWith([]);
    const r = await founder.post(actionPath(runId), {
      obligationId: 'cmp_x', action: 'skip', expectedState: 'requested',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
  });
});

describe('ADR 0554 P3 — the operations toggle gates the whole surface', () => {
  /**
   * ADDED AFTER A SABOTAGE STAYED GREEN. Removing `requireFeatureEnabled` from
   * both routes broke nothing, because every other test in this file turns the
   * toggle ON in `beforeAll` — so the file asserted the gate's absence as
   * readily as its presence. A gate no test can fail is not a gate.
   *
   * Toggling OFF and back ON inside one test keeps the rest of the file's
   * assumption intact.
   */
  it('answers a uniform 404 on both routes while the toggle is OFF', async () => {
    const { founder, runId } = await orgWith([]);
    const d = getToggleDefault('operations');
    expect(d, 'the operations toggle must exist for this leg to mean anything').toBeTruthy();

    await saveConfig({ ...d!, status: 'off' }, 'test');
    try {
      const read = await founder.get(readPath(runId));
      expect(read.status, JSON.stringify(read.body)).toBe(404);
      const act = await founder.post(actionPath(runId), {
        obligationId: 'cmp_x', action: 'retry', expectedState: 'requested',
      });
      expect(act.status, JSON.stringify(act.body)).toBe(404);
    } finally {
      await saveConfig({ ...d!, status: 'on' }, 'test');
    }

    // ...and back on, so the 404 above was the TOGGLE and not a broken fixture.
    expect((await founder.get(readPath(runId))).status).toBe(200);
  });
});

describe('ADR 0554 P3 — the read model', () => {
  it('returns an EMPTY obligation list plus the chain verdict for a run that owed nothing', async () => {
    const { founder, runId } = await orgWith([]);
    const r = await founder.get(readPath(runId));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.runId).toBe(runId);
    expect(r.body.obligations).toEqual([]);
    // `none` is a real answer, not an absence — and the panel needs it to tell
    // "owed nothing" from "the read failed".
    expect(r.body.compensationStatus).toBe('none');
    expect(r.body.auditChain.ok).toBe(true);
  });
});
