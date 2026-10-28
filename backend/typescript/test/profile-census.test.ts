/**
 * ADR 0981 P2 — the strict-profile census counts who membership enforcement and
 * the superadmin second factor WOULD refuse, while each rule is off, and never
 * refuses anything itself.
 *
 * Why: under ADR 0981 the two rules become required for the strict profile, and
 * an operator must be able to see the callers a rule would deny BEFORE turning it
 * on (D4, as corrected on acceptance). Switching into a shared workspace is already
 * membership-gated, so that population is a decision, not a list at rest; the
 * census records the decision on real traffic.
 *
 * Route-level for membership (the real app, real sessions, real shared workspace).
 * Predicate-level for the second factor (the ADR 0969 test's request shape), since
 * a test session cannot carry a verified second-factor claim.
 *
 * `OPENWOP_DEPLOY_POSTURE` and `OPENWOP_AUTHORIZATION_ENFORCEMENT` are read per
 * request, so one booted app is driven through both profiles.
 *
 * Sabotage-witnessed (2026-10-26), each reds at least one case: removing the census
 * call from the membership gate; recording under an evaluation profile; dropping the
 * sampling window; removing the second-factor census from `isSuperadmin`; serving
 * the report route without `requireSuperadmin`. NOT witnessed: the census's
 * personal-workspace skip. Removing it stays green because every caller that
 * reaches the gate in its own personal workspace already has an owner member row
 * (signed-in users are provisioned; an anonymous caller is refused 401 before the
 * gate), so the decision allows them anyway. The skip mirrors enforcement's own
 * exemption rather than changing an outcome.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { isSuperadmin } from '../src/host/superadmin.js';
import {
  _resetProfileCensusForTesting,
  _settleProfileCensusForTesting,
  profileCensusReport,
  profileHatchesInEffect,
  type ProfileCensusReport,
} from '../src/host/profileCensus.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  vi.stubEnv('OPENWOP_STORAGE_DSN', 'memory://');
  vi.stubEnv('OPENWOP_SESSION_SECRET', 'test-session-secret-at-least-32-characters-long');
  vi.stubEnv('OPENWOP_TEST_AUTH_ENABLED', 'true');
  vi.stubEnv('OPENWOP_AUTH_DISABLE_COOKIES', '');
  vi.stubEnv('OPENWOP_AUTHORIZATION_ENFORCEMENT', '');
  vi.stubEnv('OPENWOP_DEPLOY_POSTURE', '');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const def = getToggleDefault('users');
  if (def) await saveConfig({ ...def, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  vi.unstubAllEnvs();
});
beforeEach(() => {
  _resetProfileCensusForTesting();
});
afterEach(() => {
  vi.stubEnv('OPENWOP_DEPLOY_POSTURE', '');
  vi.stubEnv('OPENWOP_AUTHORIZATION_ENFORCEMENT', '');
  vi.stubEnv('OPENWOP_SUPERADMIN_TENANTS', '');
  vi.stubEnv('OPENWOP_SUPERADMIN_REQUIRE_MFA', '');
  vi.stubEnv('OPENWOP_ALLOW_EPHEMERAL_STORAGE', '');
});

interface Res { status: number; body: any }
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    for (const sc of typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : []) {
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1];
    }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

let n = 0;
async function signup(c: ReturnType<typeof client>): Promise<{ userId: string }> {
  const r = await c.post('/host/openwop-app/test/login', { email: `census-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

/** An owner and a ZERO-scope member, both switched into one shared workspace. */
async function sharedWorkspaceWithZeroScopeMember(): Promise<{
  owner: ReturnType<typeof client>; member: ReturnType<typeof client>; memberId: string; workspaceId: string;
}> {
  const owner = client();
  await signup(owner);
  const ws = (await owner.post('/host/openwop-app/workspaces', { name: `CensusCo-${n++}` })).body;
  expect((await owner.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws.workspaceId)}/switch`)).status).toBe(200);
  const member = client();
  const m = await signup(member);
  const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(ws.workspaceId)}/members`, { displayName: 'Z', subject: m.userId, roles: [] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  expect((await member.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws.workspaceId)}/switch`)).status).toBe(200);
  return { owner, member, memberId: m.userId, workspaceId: ws.workspaceId };
}

async function census(): Promise<ProfileCensusReport> {
  await _settleProfileCensusForTesting();
  return profileCensusReport({ membershipEnforced: process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT === 'true', superadminMfaRequired: false });
}

describe('ADR 0981 P2 — membership census (strict profile, enforcement off)', () => {
  it('records a zero-scope member enforcement would deny, and still serves the request', async () => {
    const { member, memberId, workspaceId } = await sharedWorkspaceWithZeroScopeMember();
    vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'auth');
    const r = await member.get('/runs');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const report = await census();
    expect(report.profile).toBe('strict');
    expect(report.membership.enforced).toBe(false);
    const entry = report.membership.wouldDeny.entries.find((e) => e.subject === memberId);
    expect(entry, JSON.stringify(report.membership)).toBeDefined();
    expect(entry!.tenantId).toBe(workspaceId);
    expect(entry!.scopes).toContain('runs:read');
  });

  it('does not record a caller enforcement would allow: the owner, or anyone in their own personal workspace', async () => {
    const { owner } = await sharedWorkspaceWithZeroScopeMember();
    const solo = client();
    await signup(solo);
    vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'auth');
    expect((await owner.get('/runs')).status).toBe(200);
    expect((await solo.get('/runs')).status).toBe(200);
    const report = await census();
    expect(report.membership.wouldDeny.entries).toEqual([]);
  });

  it('asks the same (tenant, subject, scope) once per sampling window', async () => {
    const { member, memberId } = await sharedWorkspaceWithZeroScopeMember();
    vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'auth');
    await member.get('/runs');
    await member.get('/runs');
    const entry = (await census()).membership.wouldDeny.entries.find((e) => e.subject === memberId);
    expect(entry?.count).toBe(1);
  });

  it('records nothing under an evaluation profile', async () => {
    const { member } = await sharedWorkspaceWithZeroScopeMember();
    expect((await member.get('/runs')).status).toBe(200);
    const report = await census();
    expect(report.profile).toBe('evaluation');
    expect(report.membership.wouldDeny.entries).toEqual([]);
  });

  it('a principal the census reported is denied once enforcement is on, and allowed once given a role', async () => {
    const { owner, member, memberId, workspaceId } = await sharedWorkspaceWithZeroScopeMember();
    vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'auth');
    await member.get('/runs');
    expect((await census()).membership.wouldDeny.entries.map((e) => e.subject)).toContain(memberId);
    vi.stubEnv('OPENWOP_AUTHORIZATION_ENFORCEMENT', 'true');
    expect((await member.get('/runs')).status).toBe(403);
    // The fix the census points at: give the member a role that carries the scope.
    const members = await owner.get(`/host/openwop-app/orgs/${encodeURIComponent(workspaceId)}/members`);
    const row = (members.body.members ?? members.body).find((m: { subject: string }) => m.subject === memberId);
    expect(row, JSON.stringify(members.body)).toBeDefined();
    const patch = await owner.patch(`/host/openwop-app/orgs/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(row.memberId)}`, { roles: ['viewer'] });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect((await member.get('/runs')).status).toBe(200);
  });

  it('records nothing once enforcement is on: the rule itself refuses', async () => {
    const { member } = await sharedWorkspaceWithZeroScopeMember();
    vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'auth');
    vi.stubEnv('OPENWOP_AUTHORIZATION_ENFORCEMENT', 'true');
    expect((await member.get('/runs')).status).toBe(403);
    expect((await census()).membership.wouldDeny.entries).toEqual([]);
  });
});

describe('ADR 0981 P2 — the census route is superadmin-only and names hatches only there', () => {
  it('refuses a non-superadmin, and serves a superadmin the report with hatch names', async () => {
    const outsider = client();
    await signup(outsider);
    vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'auth');
    expect((await outsider.get('/host/openwop-app/operations/profile-census')).status).toBe(403);

    const admin = client();
    await signup(admin);
    const personal = (await admin.get('/host/openwop-app/me/workspaces')).body.personal as string;
    vi.stubEnv('OPENWOP_SUPERADMIN_TENANTS', personal);
    vi.stubEnv('OPENWOP_ALLOW_EPHEMERAL_STORAGE', 'true');
    const r = await admin.get('/host/openwop-app/operations/profile-census');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.profile).toBe('strict');
    expect(r.body.hatches).toEqual(['OPENWOP_ALLOW_EPHEMERAL_STORAGE']);
    expect(r.body.window.scope).toBe('this-instance');
    // The admin is a person session with no second factor: the MFA census saw them.
    expect(r.body.superadminMfa.required).toBe(false);
    // The outsider was never a superadmin, so the admin is the only entry.
    expect(r.body.superadminMfa.withoutFactor.principals).toBe(1);
  });
});

describe('ADR 0981 P3 — the census names the two new hatches', () => {
  it('lists OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION and OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA by name, exact "true" only', () => {
    expect(profileHatchesInEffect({ OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION: 'true', OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA: 'true' }))
      .toEqual(['OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION', 'OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA']);
    expect(profileHatchesInEffect({ OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION: '1', OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA: 'yes' })).toEqual([]);
  });
});

describe('ADR 0981 P2 — superadmin second-factor census (predicate level)', () => {
  const OPERATOR = 'user:census-op';
  type Kind = 'subject' | 'api-key' | 'env-key';
  const req = (opts: { kind: Kind; principalId?: string; mfa?: boolean }): Request => ({
    tenantId: OPERATOR,
    personalTenant: OPERATOR,
    mfaVerified: opts.mfa,
    principal: {
      principalId: opts.principalId ?? 'user:p1', tenants: [OPERATOR], token: '',
      auth: opts.kind === 'api-key' ? { kind: opts.kind, issuer: 'user:p1', scopes: [] } : { kind: opts.kind },
    },
  } as unknown as Request);
  const recorded = (): string[] =>
    profileCensusReport({ membershipEnforced: false, superadminMfaRequired: false }).superadminMfa.withoutFactor.entries.map((e) => e.subject);

  it('records a single-factor superadmin person under the strict profile, and still grants superadmin', () => {
    vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'auth');
    vi.stubEnv('OPENWOP_SUPERADMIN_TENANTS', OPERATOR);
    expect(isSuperadmin(req({ kind: 'subject' }))).toBe(true);
    expect(recorded()).toEqual(['user:p1']);
  });

  it('does not record a verified second factor, break-glass, a key, or an evaluation profile', () => {
    vi.stubEnv('OPENWOP_SUPERADMIN_TENANTS', OPERATOR);
    vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'auth');
    isSuperadmin(req({ kind: 'subject', mfa: true }));
    isSuperadmin(req({ kind: 'subject', principalId: 'breakglass:abc' }));
    isSuperadmin(req({ kind: 'api-key', principalId: 'apikey:k1' }));
    vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'cookie-per-visitor');
    isSuperadmin(req({ kind: 'subject' }));
    expect(recorded()).toEqual([]);
  });

  it('does not record once the requirement is on: the rule itself refuses', () => {
    vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'auth');
    vi.stubEnv('OPENWOP_SUPERADMIN_TENANTS', OPERATOR);
    vi.stubEnv('OPENWOP_SUPERADMIN_REQUIRE_MFA', 'true');
    expect(isSuperadmin(req({ kind: 'subject' }))).toBe(false);
    expect(recorded()).toEqual([]);
  });
});
