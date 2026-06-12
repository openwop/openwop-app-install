/**
 * RBAC Phase 3 — protocol-surface authorization enforcement (RFC 0049, ADR 0006).
 *
 * ROUTE-level harness: boots the real app and drives the honesty gate over HTTP.
 * This is the safety net that makes `capabilities.authorization` an HONEST claim
 * — it proves, non-vacuously, that the advertisement is on IFF the host actually
 * fail-closes on RFC 0049 scopes (both the `/authorization/decide` seam AND the
 * protocol runs surface), and OFF (with the seam 404ing) otherwise.
 *
 * `isAuthorizationEnforced()` reads `OPENWOP_AUTHORIZATION_ENFORCEMENT` at
 * request time, so one booted app exercises both postures by toggling the env
 * around the request — exactly how a deployer flips the capability.
 *
 * Mirrors the openwop conformance leg `authorization-fail-closed.test.ts`
 * (which soft-skips on 404): here the seam is wired, so the deny runs for real.
 *
 * @see src/host/protocolAuthorization.ts
 * @see docs/adr/0006-rbac.md (Phase 3)
 * @see RFCS/0049 §C (fail-closed MUST), spec/v1/host-sample-test-seams.md
 */

import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const PORT = 18653;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(PORT, res);
  });
  const def = getToggleDefault('users');
  if (def) await saveConfig({ ...def, status: 'on' }, 'test');
});
afterAll(async () => {
  delete process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT;
  await new Promise<void>((res) => server.close(() => res()));
});
// Never leak the flag into another test in this file's describe ordering.
afterEach(() => {
  delete process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT;
});

interface Res<T = any> {
  status: number;
  body: T;
}
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> } {
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
// ADR 0026: real sign-in is Firebase OIDC; tests mint an authenticated user via
// the env-gated auth test seam.
async function signup(c: ReturnType<typeof client>): Promise<{ userId: string; email: string }> {
  const r = await c.post('/v1/host/sample/test/login', { email: uniqEmail('u') });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

const ENFORCE = (): void => { process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT = 'true'; };

describe('RBAC Phase 3 — enforcement OFF (default, back-compat)', () => {
  it('discovery advertises authorization.supported:false (unhonored ⇒ not advertised)', async () => {
    const d = (await client().get('/.well-known/openwop')).body;
    expect(d.capabilities.authorization).toEqual({ supported: false });
  });

  it('the decision seam 404s — the conformance probe soft-skips', async () => {
    const r = await client().post('/v1/host/sample/authorization/decide', {
      principal: 'conformance-unseeded-principal',
      action: 'runs:cancel',
      resource: 'run-conformance-probe',
    });
    expect(r.status).toBe(404);
  });

  it('GET /v1/runs is unaffected for a signed-in non-member (requireProtocolScope is a no-op)', async () => {
    const c = client();
    await signup(c); // signed in, but a member of nothing
    const r = await c.get('/v1/runs');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.runs)).toBe(true);
  });
});

describe('RBAC Phase 3 — enforcement ON (capability honored)', () => {
  it('discovery advertises supported:true + failClosed:true + the role catalog', async () => {
    ENFORCE();
    const d = (await client().get('/.well-known/openwop')).body;
    const authz = d.capabilities.authorization;
    expect(authz.supported).toBe(true);
    expect(authz.failClosed).toBe(true); // RFC 0049 §C — MUST be exactly true when present
    const owner = authz.roles.find((r: { role: string }) => r.role === 'owner');
    expect(owner.scopes).toContain('host:org:manage');
    const viewer = authz.roles.find((r: { role: string }) => r.role === 'viewer');
    expect(viewer.scopes).toContain('runs:read');
    expect(viewer.scopes).not.toContain('runs:create'); // viewer can't create — proves the catalog is real
  });

  it('decision seam: an absent/unseeded principal MUST deny (fail-closed, RFC 0049 §C)', async () => {
    ENFORCE();
    const r = await client().post('/v1/host/sample/authorization/decide', {
      principal: 'conformance-unseeded-principal',
      action: 'runs:cancel',
      resource: 'run-conformance-probe',
    });
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(false); // the host MUST NOT default-allow
    // The seam returns ONLY { allowed } — it must NOT echo scopes/basis (the
    // enumeration surface closed in the code-review follow-up).
    expect(r.body.scopes).toBeUndefined();
    expect(r.body.basis).toBeUndefined();
  });

  it('decision seam: a seeded owner IS allowed (non-vacuous — allow AND deny both real)', async () => {
    ENFORCE();
    const owner = client();
    const me = await signup(owner);
    // Creating an org seeds an explicit owner member bound to me.userId (Phase 1).
    const org = await owner.post('/v1/host/sample/orgs', { name: 'Acme' });
    expect(org.status).toBe(201);
    // Decide from the owner's own client so tenantOf(req) matches the member's tenant.
    const allow = await owner.post('/v1/host/sample/authorization/decide', { principal: me.userId, action: 'runs:create', resource: 'r' });
    expect(allow.body.allowed).toBe(true);
    // Same tenant, a principal that isn't a member ⇒ deny (fail-closed).
    const deny = await owner.post('/v1/host/sample/authorization/decide', { principal: 'not-a-member', action: 'runs:create', resource: 'r' });
    expect(deny.body.allowed).toBe(false);
  });

  // ADR 0015: a signed-in user OWNS their personal workspace (implicit owner — a
  // single-principal scope), so protocol-surface fail-closed is enforced for
  // SHARED workspaces: by ROLE within, and by the MEMBERSHIP boundary at switch.
  // (The decision-seam fail-closed above remains the RFC 0049 §C oracle, unchanged.)
  it('protocol surface (shared workspace): owner allowed (200), zero-scope member denied (403)', async () => {
    const owner = client();
    await signup(owner);
    const ws = (await owner.post('/v1/host/sample/workspaces', { name: 'TeamCo' })).body;
    expect(ws.workspaceId).toMatch(/^ws:/);
    // Owner switches into the shared workspace to administer + act in it.
    const sw = await owner.post(`/v1/host/sample/workspaces/${encodeURIComponent(ws.workspaceId)}/switch`);
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    // Seed a ZERO-scope member bound to a stranger's subject.
    const stranger = client();
    const sUser = await signup(stranger);
    const add = await owner.post(
      `/v1/host/sample/orgs/${encodeURIComponent(ws.workspaceId)}/members`,
      { displayName: 'S', subject: sUser.userId, roles: [] },
    );
    expect(add.status, JSON.stringify(add.body)).toBe(201);

    ENFORCE();
    // Owner (role owner) acting IN the shared workspace — allowed.
    const ok = await owner.get('/v1/runs');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // The zero-scope member switches in, then is fail-closed denied.
    expect((await stranger.post(`/v1/host/sample/workspaces/${encodeURIComponent(ws.workspaceId)}/switch`)).status).toBe(200);
    const forbidden = await stranger.get('/v1/runs');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error ?? forbidden.body.code).toBe('forbidden');
  });

  it('switch is membership-gated: a non-member cannot enter a shared workspace (403)', async () => {
    const owner = client();
    await signup(owner);
    const ws = (await owner.post('/v1/host/sample/workspaces', { name: 'PrivateCo' })).body;
    const outsider = client();
    await signup(outsider);
    const denied = await outsider.post(`/v1/host/sample/workspaces/${encodeURIComponent(ws.workspaceId)}/switch`);
    expect(denied.status).toBe(403);
    expect(denied.body.error ?? denied.body.code).toBe('forbidden');
  });

  it('scopes are the UNION across a subject\'s org memberships, not first-match', async () => {
    ENFORCE();
    // One owner, one tenant, two orgs. A subject is VIEWER in org-A (no
    // runs:create) and EDITOR in org-B (has runs:create). The protocol surface
    // is org-agnostic, so the subject must resolve to the UNION — runs:create
    // granted via the editor membership regardless of store iteration order.
    const owner = client();
    await signup(owner);
    const orgA = (await owner.post('/v1/host/sample/orgs', { name: 'OrgA' })).body;
    const orgB = (await owner.post('/v1/host/sample/orgs', { name: 'OrgB' })).body;
    const subject = 'multi-org-subject';
    const mA = await owner.post(`/v1/host/sample/orgs/${encodeURIComponent(orgA.orgId)}/members`, { displayName: 'Multi', subject, roles: ['viewer'] });
    expect(mA.status, JSON.stringify(mA.body)).toBe(201);
    const mB = await owner.post(`/v1/host/sample/orgs/${encodeURIComponent(orgB.orgId)}/members`, { displayName: 'Multi', subject, roles: ['editor'] });
    expect(mB.status, JSON.stringify(mB.body)).toBe(201);

    const create = await owner.post('/v1/host/sample/authorization/decide', { principal: subject, action: 'runs:create', resource: 'r' });
    expect(create.body.allowed, 'union must grant runs:create from the editor-in-B membership').toBe(true);
    const read = await owner.post('/v1/host/sample/authorization/decide', { principal: subject, action: 'runs:read', resource: 'r' });
    expect(read.body.allowed).toBe(true);
    // A scope NEITHER membership grants is still denied (the union isn't a blanket allow).
    const manage = await owner.post('/v1/host/sample/authorization/decide', { principal: subject, action: 'host:org:manage', resource: 'r' });
    expect(manage.body.allowed).toBe(false);
  });

  it('every gated run route denies a zero-scope member of a shared workspace: bulk-cancel, events/poll, debug-bundle', async () => {
    const owner = client();
    await signup(owner);
    const ws = (await owner.post('/v1/host/sample/workspaces', { name: 'GateCo' })).body;
    expect((await owner.post(`/v1/host/sample/workspaces/${encodeURIComponent(ws.workspaceId)}/switch`)).status).toBe(200);
    const member = client();
    const mUser = await signup(member);
    expect((await owner.post(
      `/v1/host/sample/orgs/${encodeURIComponent(ws.workspaceId)}/members`,
      { displayName: 'M', subject: mUser.userId, roles: [] },
    )).status).toBe(201);
    expect((await member.post(`/v1/host/sample/workspaces/${encodeURIComponent(ws.workspaceId)}/switch`)).status).toBe(200);

    ENFORCE();
    // Scope check runs BEFORE the run lookup, so a zero-scope member is 403'd even
    // for a non-existent run (no existence leak) — proves the gate, not the 404.
    const bulk = await member.post('/v1/runs:bulk-cancel', { runIds: ['no-such-run'] });
    expect(bulk.status, JSON.stringify(bulk.body)).toBe(403);
    const poll = await member.get('/v1/runs/no-such-run/events/poll');
    expect(poll.status).toBe(403);
    const debug = await member.get('/v1/runs/no-such-run/debug-bundle');
    expect(debug.status).toBe(403);
  });

  // The wildcard-bearer escape hatch: the trusted operator key (OPENWOP_API_KEYS /
  // conformance harness) is full-access on the protocol surface even with
  // enforcement ON — so a host can enable enforcement AND still serve bearer
  // integrations. Without it, every API-key caller (no accessControl membership)
  // would 403, and enforcement could never be turned on for the demo.
  it('wildcard bearer (operator API key) is full-access on the protocol surface under enforcement', async () => {
    process.env.OPENWOP_API_KEY = 'test-operator-escape-hatch-key';
    ENFORCE();
    try {
      const r = await fetch(`${BASE}/v1/runs`, { headers: { authorization: 'Bearer test-operator-escape-hatch-key' } });
      expect(r.status).toBe(200);
    } finally {
      delete process.env.OPENWOP_API_KEY;
    }
  });
});
