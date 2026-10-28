/**
 * ADR 0892 Phase B D1/D9 — the bundle enable/disable store routes over HTTP.
 *
 * Authority is witnessed with REAL user principals on the production identity
 * path (the `csm-authz-http.test.ts` fixture: personal sign-in, membership under
 * the HOME userId, then `/workspaces/:id/switch`), never the wildcard operator
 * bearer, which every scope gate admits by construction. `OPENWOP_DEMO_MODE` is
 * unset so the de-facto-owner bypass cannot make a refusal pass vacuously.
 *
 * (TST-BPC) Red when (each sabotage-witnessed, wave 65): `canManageBundles` answers
 * `true` ⇒ the viewer/editor case and the editor `canManageBundles: false` read; the
 * write takes its tenant from the body ⇒ "a workspace admin enables it for THAT…";
 * the entitlement refusal is not a 402 ⇒ "402 bundle_not_entitled…".
 *
 * DOUBLE GUARD (recorded): a caller with no membership in WS is held twice — the
 * ADR 0015 re-check in `middleware/auth.ts` bounces their session to their own
 * personal tenant, and `canManageBundles` (`features/marketplace/routes.ts`) would
 * refuse a non-member in WS anyway. Breaking either alone leaves WS untouched, so that
 * case is not keyed to a single-guard probe; the `canManageBundles` half is witnessed
 * by the viewer/editor case.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { createMember, createWorkspace } from '../src/host/accessControlService.js';
import { __clearToggleStore, resolveToggle, saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { bundleClosure } from '../src/host/featureBundleActivation.js';

let server: Server;
let BASE = '';
let WS = '';
const P = '/host/openwop-app/marketplace/feature-bundles';

interface Res<T> { status: number; body: T }
async function call<T = Record<string, unknown>>(cookie: string, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
}

async function personal(subject: string): Promise<{ cookie: string; userId: string; tenantId: string }> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, displayName: subject }),
  });
  expect(res.status).toBeLessThan(300);
  const { user } = (await res.json()) as { user: { userId: string; tenantId: string } };
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '', userId: user.userId, tenantId: user.tenantId };
}
async function member(subject: string, roles: string[]): Promise<string> {
  const p = await personal(subject);
  await createMember({ orgId: WS, tenantId: WS, displayName: subject, subject: p.userId, roles });
  const sw = await fetch(`${BASE}/host/openwop-app/workspaces/${encodeURIComponent(WS)}/switch`, { method: 'POST', headers: { cookie: p.cookie } });
  expect(sw.status, await sw.clone().text()).toBe(200);
  return (sw.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}
async function outsider(subject: string): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, tenantId: WS, displayName: subject, sharedWorkspace: true }),
  });
  expect(res.status).toBeLessThan(300);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}
async function setGlobal(id: string, status: 'on' | 'off', extra: { killed?: boolean } = {}): Promise<void> {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status, ...extra }, 'test');
}
const onIn = async (id: string, tenantId: string): Promise<boolean> => Boolean((await resolveToggle(id, { tenantId }))?.enabled);

let viewer = '';
let editor = '';
let admin = '';
let stranger = '';
let solo: { cookie: string; userId: string; tenantId: string };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const ws = await createWorkspace({ name: 'Bundle authz workspace', ownerSubject: 'oidc:bundle-owner' });
  WS = ws.orgId ?? ws.tenantId;
  viewer = await member('oidc:bundle-viewer', ['viewer']);
  editor = await member('oidc:bundle-editor', ['editor']);
  admin = await member('oidc:bundle-admin', ['admin']);
  stranger = await outsider('oidc:bundle-stranger');
  solo = await personal('oidc:bundle-solo');
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
  delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(async () => {
  delete process.env.OPENWOP_BILLING_PLAN_FEATURES;
  await __clearToggleStore();
  for (const id of ['users', 'marketplace', 'billing']) await setGlobal(id, 'on');
  for (const id of new Set([...bundleClosure('commerce'), ...bundleClosure('crm')])) await setGlobal(id, 'off');
});

describe('authority (D1)', () => {
  it('a viewer and an editor are refused 403, and nothing is written', async () => {
    for (const c of [viewer, editor]) {
      const r = await call(c, 'POST', `${P}/crm/enable`);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('forbidden_scope');
    }
    expect(await onIn('crm', WS)).toBe(false);
  });

  it('a workspace admin enables it for THAT workspace only; a body tenantId is ignored', async () => {
    const r = await call<{ status: string; enabled: string[] }>(admin, 'POST', `${P}/crm/enable`, { tenantId: solo.tenantId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('enabled');
    expect(r.body.enabled).toContain('crm');
    expect(await onIn('crm', WS)).toBe(true);
    expect(await onIn('crm', solo.tenantId)).toBe(false);
  });

  it('the owner of a personal workspace may enable it there', async () => {
    const r = await call(solo.cookie, 'POST', `${P}/crm/enable`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await onIn('crm', solo.tenantId)).toBe(true);
  });

  it('a caller with no membership in a workspace cannot turn a bundle on there', async () => {
    // The ADR 0015 re-check bounces a non-member to their OWN personal tenant
    // (authTestSeam.ts note), so the request acts there or is refused. Either
    // way the workspace they do not belong to is untouched, which is the claim
    // (a recorded double guard: see the header).
    await call(stranger, 'POST', `${P}/crm/enable`);
    expect(await onIn('crm', WS)).toBe(false);
  });

  it('an anonymous caller is refused', async () => {
    const r = await call('', 'POST', `${P}/crm/enable`);
    expect([r.status, r.body['error']]).toEqual([401, 'sign_in_required']);
  });
});

describe('refusal shapes (D2/D3/D5, 404)', () => {
  it('402 bundle_not_entitled names the missing features and the bundles that sell them', async () => {
    process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'] });
    const r = await call<{ error: string; details: { reason: string; missing: string[]; bundles: string[] } }>(admin, 'POST', `${P}/commerce/enable`);
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('bundle_not_entitled');
    expect(r.body.details.reason).toBe('bundle_not_entitled');
    expect(r.body.details.missing).toEqual(expect.arrayContaining(['commerce', 'crm']));
    expect(r.body.details.bundles).toEqual(expect.arrayContaining(['commerce', 'crm']));
  });

  it('409 feature_killed names the killed ids', async () => {
    await setGlobal('crm', 'off', { killed: true });
    const r = await call<{ error: string; details: { ids: string[] } }>(admin, 'POST', `${P}/commerce/enable`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('feature_killed');
    expect(r.body.details.ids).toEqual(['crm']);
  });

  it('409 disable_blocked names the dependents still on here', async () => {
    expect((await call(admin, 'POST', `${P}/commerce/enable`)).status).toBe(200);
    const r = await call<{ error: string; details: { dependents: string[] } }>(admin, 'POST', `${P}/crm/disable`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('disable_blocked');
    expect(r.body.details.dependents).toContain('commerce');
  });

  it('disable succeeds when nothing outside the bundle needs it', async () => {
    await call(admin, 'POST', `${P}/crm/enable`);
    const r = await call<{ status: string; disabled: string[] }>(admin, 'POST', `${P}/crm/disable`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('available');
    expect(r.body.disabled).toContain('crm');
    expect(await onIn('crm', WS)).toBe(false);
  });

  it('an unknown bundle is 404', async () => {
    const r = await call<{ error: string }>(admin, 'POST', `${P}/no-such-bundle/enable`);
    expect([r.status, r.body.error]).toEqual([404, 'not_found']);
  });
});

describe('catalog read carries the workspace state (D9)', () => {
  type Catalog = { activation?: Record<string, { status: string }>; viewer: { canManageBundles: boolean } };
  it('admin sees canManageBundles + per-bundle status; an editor sees the state but may not manage', async () => {
    await call(admin, 'POST', `${P}/crm/enable`);
    const a = await call<Catalog>(admin, 'GET', P);
    expect(a.status).toBe(200);
    expect(a.body.viewer.canManageBundles).toBe(true);
    expect(a.body.activation?.crm?.status).toBe('enabled');
    expect(a.body.activation?.commerce?.status).toBe('available');
    const e = await call<Catalog>(editor, 'GET', P);
    expect(e.body.viewer.canManageBundles).toBe(false);
    expect(e.body.activation?.crm?.status).toBe('enabled');
  });

  it('a bundle the plan does not cover reads locked', async () => {
    process.env.OPENWOP_BILLING_PLAN_FEATURES = JSON.stringify({ free: ['billing'] });
    const a = await call<Catalog>(admin, 'GET', P);
    expect(a.body.activation?.crm?.status).toBe('locked');
  });
});
