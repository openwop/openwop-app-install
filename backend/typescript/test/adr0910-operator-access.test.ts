/**
 * ADR 0910 P1 — just-in-time `kicktodo-operator` activation, over HTTP against the
 * real app (createApp + the real auth middleware + a synthetic OIDC issuer, the
 * `mfa-session-claim` harness), plus the use-time, self-approval and Factory-ref
 * legs at the service layer.
 *
 * Witnessed (sabotage, each turns a leg red):
 *  - D1: the role's scopes widened, or the role admitted as a built-in id;
 *  - G1 eligibility read from `isSuperadmin`/the active tenant; G3 `mfaVerified`
 *    check dropped; G4 recent-auth check dropped (or read from the cookie);
 *    G6 the `createdBy === 'system'` / declared-target check dropped; G7 clamping
 *    instead of refusing;
 *  - D4: expiry compared only by a sweep (the expired-row leg), the eligibility
 *    re-read dropped (the de-list leg), the root-membership leg dropped;
 *  - D5: self-approval granted to any manage holder;
 *  - D8: the Factory picking the first provider key over its dedicated ref.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { _resetOidcVerifier } from '../src/middleware/auth.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { BUILT_IN_ROLE_IDS, deleteMember, isBuiltInRoleId, listMembers, scopesForRoles } from '../src/host/accessControlService.js';
import { hasKicktodoManageAuthority } from '../src/features/featureRoute.js';
import { KICKTODO_OPERATOR_ROLE, operatorActivations } from '../src/host/operatorActivationLedger.js';
import { operatorSelfApprovalActivation } from '../src/host/operatorAccess.js';
import { factoryCredentialRef, pickFactoryCredentialRef } from '../src/features/kicktodo-creator/agentTools.js';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const WS = 'host-kicktodo';
const AUD = 'openwop-test-aud';
let BASE = '';
let server: http.Server;
let issuerServer: http.Server;
let issuer = '';
let privateKey: KeyObject;

function mint(sub: string, opts: { mfa?: boolean; authTime?: number } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' };
  const payload = {
    iss: issuer, aud: AUD, sub, iat: now, exp: now + 300,
    ...(opts.authTime !== undefined ? { auth_time: opts.authTime } : {}),
    ...(opts.mfa ? { firebase: { sign_in_second_factor: 'totp' } } : {}),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(createSign('sha256').update(signingInput).sign(privateKey))}`;
}
/** The personal tenant the allowlist names, and the member subject (`userId`). */
function personOf(sub: string): { personal: string; subject: string } {
  const personal = `user:${createHash('sha256').update(`${issuer}:${sub}`).digest('hex').slice(0, 32)}`;
  return { personal, subject: userIdFor(personal, `oidc:${sub}`) };
}

interface Res { status: number; body: { activation?: { activationId: string; activatedAt: string; expiresAt: string }; activations?: unknown[]; details?: { code?: string } } }
/** One cookie jar per OIDC subject, bound once (the operator must be a BOUND person:
 *  the cookie carries `userId`, which is what G2 reads). The bearer rides every call
 *  so `auth_time` / the second-factor claim are fresh per request. */
const jars = new Map<string, string>();
function subOf(token: string): string {
  return (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sub: string }).sub;
}
async function raw(method: string, path: string, token: string | undefined, body: unknown, jarKey?: string): Promise<Res> {
  const cookie = jarKey ? jars.get(jarKey) : undefined;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', connection: 'close', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  for (const sc of typeof h.getSetCookie === 'function' ? h.getSetCookie() : []) {
    const m = /(__session=[^;]+)/.exec(sc);
    if (m && jarKey) jars.set(jarKey, m[1]!);
  }
  return { status: res.status, body: res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Res['body']) };
}
async function call(method: string, path: string, token?: string, body?: unknown): Promise<Res> {
  if (!token) return raw(method, path, undefined, body);
  const sub = subOf(token);
  if (!jars.has(sub)) {
    const bound = await raw('POST', '/host/openwop-app/users/auth/oidc/bind', token, undefined, sub);
    if (bound.status >= 300) throw new Error(`bind failed for ${sub}: ${bound.status}`);
  }
  return raw(method, path, token, body, sub);
}
const PATH = `/host/openwop-app/workspaces/${encodeURIComponent(WS)}/operator-access`;
const fresh = () => Math.floor(Date.now() / 1000) - 30;
const GOOD = { justification: 'A-08 first catalog / D-23' };

beforeAll(async () => {
  const { publicKey, privateKey: priv } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = priv;
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-kid-1', alg: 'RS256', use: 'sig' }] };
  const issuerApp = express();
  issuerApp.get('/.well-known/jwks.json', (_req, res) => res.json(jwks));
  issuerServer = await new Promise<http.Server>((r) => { const s = issuerApp.listen(0, '127.0.0.1', () => r(s)); });
  issuer = `http://127.0.0.1:${(issuerServer.address() as { port: number }).port}`;
  process.env.OPENWOP_OIDC_ISSUER = issuer;
  process.env.OPENWOP_OIDC_AUDIENCE = AUD;
  process.env.OPENWOP_OIDC_JWKS_URL = `${issuer}/.well-known/jwks.json`;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  _resetOidcVerifier();
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('kicktodo-core');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  process.env.OPENWOP_SUPERADMIN_TENANTS = [personOf('op-1').personal, personOf('op-2').personal, personOf('op-3').personal].join(',');
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => issuerServer.close(() => res()));
  _resetOidcVerifier();
  for (const k of ['OPENWOP_OIDC_ISSUER', 'OPENWOP_OIDC_AUDIENCE', 'OPENWOP_OIDC_JWKS_URL', 'OPENWOP_SUPERADMIN_TENANTS']) delete process.env[k];
});

describe('D1 — the activation-only role', () => {
  it('grants exactly KickTodo manage + BYOK manage, and is never a roster role', () => {
    expect(new Set(KICKTODO_OPERATOR_ROLE.scopes)).toEqual(new Set(['host:kicktodo:manage', 'host:byok:manage']));
    expect(KICKTODO_OPERATOR_ROLE.scopes).toHaveLength(2);
    expect(isBuiltInRoleId('kicktodo-operator')).toBe(false);
    expect(BUILT_IN_ROLE_IDS).not.toContain('kicktodo-operator');
    expect(scopesForRoles(['kicktodo-operator'])).toEqual([]); // a member row naming it grants nothing
  });
});

describe('D3 — activation guards (HTTP)', () => {
  it('G1: a person not on the allowlist is refused', async () => {
    const r = await call('POST', PATH, mint('stranger', { mfa: true, authTime: fresh() }), GOOD);
    expect(r.status).toBe(403);
    expect(r.body.details?.code).toBe('not_eligible');
  });

  it('G3: no second factor → mfa_required', async () => {
    const r = await call('POST', PATH, mint('op-1', { authTime: fresh() }), GOOD);
    expect(r.status).toBe(403);
    expect(r.body.details?.code).toBe('mfa_required');
  });

  it('G4: an ID token signed in 16 minutes ago → reauth_required', async () => {
    const r = await call('POST', PATH, mint('op-1', { mfa: true, authTime: Math.floor(Date.now() / 1000) - 16 * 60 }), GOOD);
    expect(r.status).toBe(403);
    expect(r.body.details?.code).toBe('reauth_required');
  });

  it('G5 / G7: a short justification and an over-long window are 400s, never clamped', async () => {
    expect((await call('POST', PATH, mint('op-1', { mfa: true, authTime: fresh() }), { justification: '123456789' })).status).toBe(400);
    expect((await call('POST', PATH, mint('op-1', { mfa: true, authTime: fresh() }), { ...GOOD, durationMinutes: 481 })).status).toBe(400);
  });

  it('G6: a workspace that is not a system-owned declared default is a uniform 404', async () => {
    const t = mint('op-1', { mfa: true, authTime: fresh() });
    expect((await call('POST', '/host/openwop-app/workspaces/nope/operator-access', t, GOOD)).status).toBe(404);
    expect((await call('POST', `/host/openwop-app/workspaces/${encodeURIComponent('ws:00000000-0000-4000-8000-000000000000')}/operator-access`, t, GOOD)).status).toBe(404);
  });

  it('activates for 8 h by default, joins the operator as a viewer, grants manage, and refuses a second live activation', async () => {
    const { subject } = personOf('op-1');
    expect(await hasKicktodoManageAuthority(WS, subject)).toBe(false);
    const r = await call('POST', PATH, mint('op-1', { mfa: true, authTime: fresh() }), GOOD);
    expect(r.status).toBe(201);
    const a = r.body.activation!;
    expect(Date.parse(a.expiresAt) - Date.parse(a.activatedAt)).toBe(480 * 60_000);
    const root = (await listMembers(WS, WS)).find((m) => m.subject === subject);
    expect(root?.roles).toEqual(['viewer']); // the participant floor — no role edit
    expect(await hasKicktodoManageAuthority(WS, subject)).toBe(true);
    const again = await call('POST', PATH, mint('op-1', { mfa: true, authTime: fresh() }), GOOD);
    expect(again.status).toBe(409);
    expect(again.body.details?.code).toBe('already_active');
  });

  it('revocation ends authority at the next resolution', async () => {
    const { subject } = personOf('op-1');
    expect((await call('DELETE', PATH, mint('op-1', { mfa: true, authTime: fresh() }))).status).toBe(204);
    expect(await hasKicktodoManageAuthority(WS, subject)).toBe(false);
  });
});

describe('D4 — authority is decided at USE time (no sweep runs in this file)', () => {
  it('an expired row grants nothing, even though nothing cleaned it up', async () => {
    const { subject } = personOf('op-2');
    expect((await call('POST', PATH, mint('op-2', { mfa: true, authTime: fresh() }), GOOD)).status).toBe(201);
    expect(await hasKicktodoManageAuthority(WS, subject)).toBe(true);
    const row = (await operatorActivations.get(`${WS}::${subject}`))!;
    await operatorActivations.put({ ...row, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await hasKicktodoManageAuthority(WS, subject)).toBe(false);
    expect(await operatorSelfApprovalActivation(WS, subject)).toBeNull();
  });

  it('de-listing ends a live activation at once, and so does losing the root membership', async () => {
    const { subject, personal } = personOf('op-3');
    expect((await call('POST', PATH, mint('op-3', { mfa: true, authTime: fresh() }), GOOD)).status).toBe(201);
    expect(await hasKicktodoManageAuthority(WS, subject)).toBe(true);
    const saved = process.env.OPENWOP_SUPERADMIN_TENANTS!;
    process.env.OPENWOP_SUPERADMIN_TENANTS = saved.split(',').filter((t) => t !== personal).join(',');
    try {
      expect(await hasKicktodoManageAuthority(WS, subject)).toBe(false);
    } finally {
      process.env.OPENWOP_SUPERADMIN_TENANTS = saved;
    }
    expect(await hasKicktodoManageAuthority(WS, subject)).toBe(true);
    const root = (await listMembers(WS, WS)).find((m) => m.subject === subject)!;
    await deleteMember(root.memberId);
    expect(await hasKicktodoManageAuthority(WS, subject)).toBe(false);
  });
});

describe('D5 — self-approval is the live operator only', () => {
  it('the predicate names the activation for a live operator and nobody else', async () => {
    const { subject } = personOf('op-1');
    expect((await call('POST', PATH, mint('op-1', { mfa: true, authTime: fresh() }), GOOD)).status).toBe(201);
    const id = await operatorSelfApprovalActivation(WS, subject);
    expect(id).toMatch(/^opa_/);
    // Another tenant, or a subject with no activation, gets nothing.
    expect(await operatorSelfApprovalActivation('some-other-tenant', subject)).toBeNull();
    expect(await operatorSelfApprovalActivation(WS, 'user:not-an-operator')).toBeNull();
  });
});

describe('D8 — the Factory names its own key', () => {
  it('prefers kicktodo-factory:<provider> over another key for the same provider; falls back when absent', () => {
    const refs = ['anthropic', 'anthropic:chat', factoryCredentialRef('anthropic')];
    expect(pickFactoryCredentialRef('anthropic', undefined, refs)).toEqual({ ref: 'kicktodo-factory:anthropic', rung: 'explicit' });
    expect(pickFactoryCredentialRef('anthropic', undefined, ['anthropic']).ref).toBe('anthropic');
    expect(pickFactoryCredentialRef('anthropic', 'anthropic:chat', refs).ref).toBe('anthropic:chat'); // explicit wins
  });

  it('ratchet: `kicktodo-factory:` appears in source only inside kicktodo-creator', () => {
    const src = join(process.cwd(), 'src');
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && readFileSync(p, 'utf8').includes('kicktodo-factory:')) hits.push(p.slice(src.length + 1));
      }
    };
    walk(src);
    expect(hits.length).toBeGreaterThan(0);
    // Readiness only REPORTS whether the ref exists (D10); it never chooses or defaults one.
    const REPORTS_ONLY = new Set(['features/kicktodo-core/readinessService.ts']);
    expect(hits.filter((h) => !h.startsWith('features/kicktodo-creator/') && !REPORTS_ONLY.has(h))).toEqual([]);
  });
});
