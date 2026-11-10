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
 * Sabotage-witnessed (w77), each reds at least one case: removing the census call
 * from the membership gate, or making it before the enforcement check; recording
 * under an evaluation profile; dropping the sampling window, never letting it
 * expire, or leaving the scope out of its key; recording an allowed decision;
 * removing the second-factor census from `isSuperadmin`, or any of its three
 * exemptions; serving the report route without `requireSuperadmin`.
 *
 * NOT witnessed: `isSuperadmin`'s `!superadminMfaRequired()` term, an equivalent
 * mutant, because with the requirement on a caller lacking the factor has already
 * been refused above it. And the census's personal-workspace skip. Removing it stays green because every caller that
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
  shouldSampleMembership,
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
  vi.stubEnv('OPENWOP_ALLOW_INMEMORY_SURFACES', ''); // a shell value would join the exact `hatches` list
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const def = getToggleDefault('users');
  expect(def).toBeDefined();
  await saveConfig({ ...def!, status: 'on' }, 'test');
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

interface Res<T> { status: number; body: T }
/** The error envelope (`middleware/errorEnvelope.ts`). */
interface Refusal { error: string; message: string }
interface Client {
  get: <T = unknown>(p: string) => Promise<Res<T>>;
  post: <T = unknown>(p: string, b?: unknown) => Promise<Res<T>>;
  patch: <T = unknown>(p: string, b?: unknown) => Promise<Res<T>>;
}
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
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
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b), patch: <T>(p: string, b?: unknown) => call<T>('PATCH', p, b) };
}

let n = 0;
async function signup(c: Client): Promise<{ userId: string }> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `census-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

/** An owner and a ZERO-scope member, both switched into one shared workspace. */
async function sharedWorkspaceWithZeroScopeMember(): Promise<{
  owner: Client; member: Client; memberId: string; workspaceId: string;
}> {
  const owner = client();
  await signup(owner);
  const ws = (await owner.post<{ workspaceId: string }>('/host/openwop-app/workspaces', { name: `CensusCo-${n++}` })).body;
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

    // The window itself, on the clock: it reopens at exactly 10 minutes, and each
    // part of the key is its own question.
    const start = Date.UTC(2026, 9, 26, 12);
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    try {
      expect(shouldSampleMembership('t1', 'user:s', 'runs:read')).toBe(true);
      expect(shouldSampleMembership('t1', 'user:s', 'runs:write')).toBe(true);
      expect(shouldSampleMembership('t1', 'user:s', 'runs:read')).toBe(false);
      vi.setSystemTime(start + 599_999);
      expect(shouldSampleMembership('t1', 'user:s', 'runs:read')).toBe(false);
      vi.setSystemTime(start + 600_000);
      expect(shouldSampleMembership('t1', 'user:s', 'runs:read')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
    const refused = await member.get<Refusal>('/runs');
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'forbidden', message: 'Missing required scope: runs:read' });
    // The fix the census points at: give the member a role that carries the scope.
    const members = await owner.get<{ members: Array<{ memberId: string; subject: string }> }>(`/host/openwop-app/orgs/${encodeURIComponent(workspaceId)}/members`);
    const row = members.body.members.find((m) => m.subject === memberId);
    expect(row, JSON.stringify(members.body)).toBeDefined();
    const patch = await owner.patch(`/host/openwop-app/orgs/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(row!.memberId)}`, { roles: ['viewer'] });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect((await member.get('/runs')).status).toBe(200);
  });

  it('records nothing once enforcement is on: the rule itself refuses', async () => {
    const { member } = await sharedWorkspaceWithZeroScopeMember();
    vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'auth');
    vi.stubEnv('OPENWOP_AUTHORIZATION_ENFORCEMENT', 'true');
    const refused = await member.get<Refusal>('/runs');
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'forbidden', message: 'Missing required scope: runs:read' });
    expect((await census()).membership.wouldDeny.entries).toEqual([]);
  });
});

describe('ADR 0981 P2 — the census route is superadmin-only and names hatches only there', () => {
  it('refuses a non-superadmin, and serves a superadmin the report with hatch names', async () => {
    const outsider = client();
    await signup(outsider);
    vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'auth');
    const refused = await outsider.get<Refusal>('/host/openwop-app/operations/profile-census');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('forbidden');
    expect(refused.body.message).toMatch(/requires a superadmin principal/);

    const admin = client();
    const adminUser = await signup(admin);
    const personal = (await admin.get<{ personal: string }>('/host/openwop-app/me/workspaces')).body.personal;
    vi.stubEnv('OPENWOP_SUPERADMIN_TENANTS', personal);
    vi.stubEnv('OPENWOP_ALLOW_EPHEMERAL_STORAGE', 'true');
    const r = await admin.get<ProfileCensusReport>('/host/openwop-app/operations/profile-census');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.profile).toBe('strict');
    expect(r.body.hatches).toEqual(['OPENWOP_ALLOW_EPHEMERAL_STORAGE']);
    expect(r.body.window.scope).toBe('this-instance');
    // The admin is a person session with no second factor: the MFA census saw them.
    expect(r.body.superadminMfa.required).toBe(false);
    // The outsider was never a superadmin, so the admin is the only entry.
    expect(r.body.superadminMfa.withoutFactor.principals).toBe(1);
    expect(r.body.superadminMfa.withoutFactor.entries.map((e) => e.subject)).toEqual([adminUser.userId]);
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
    // Each is granted, so none of them passes by being refused before the census.
    expect(isSuperadmin(req({ kind: 'subject', mfa: true }))).toBe(true);
    expect(isSuperadmin(req({ kind: 'subject', principalId: 'breakglass:abc' }))).toBe(true);
    expect(isSuperadmin(req({ kind: 'api-key', principalId: 'apikey:k1' }))).toBe(true);
    vi.stubEnv('OPENWOP_DEPLOY_POSTURE', 'cookie-per-visitor');
    expect(isSuperadmin(req({ kind: 'subject' }))).toBe(true);
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
