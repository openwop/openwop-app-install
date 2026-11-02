/**
 * ADR 0910 D12 / P5 — a live operator removes one PARTICIPANT from the declared
 * default workspace, and the removal HOLDS (ADR 0684 §7): over HTTP against the
 * real app (the `adr0910-operator-access` harness: createApp, the real auth
 * middleware, a synthetic OIDC issuer), so the participants are joined by the
 * real sign-in auto-join and re-sign in through it.
 *
 * Witnessed (sabotage, each turns a leg red; recorded in the PR):
 *  - the live-activation check dropped (no-activation and expired legs);
 *  - the self / superadmin / participant-only refusals dropped;
 *  - the `claimJoin` before removal dropped (the hand-added participant re-joins);
 *  - the route's G3 MFA check dropped;
 *  - the audit row's activation id dropped.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const audits = vi.hoisted(() => [] as Array<{ tenant: string; kind: string; payload: Record<string, unknown> }>);
vi.mock('../src/host/auditChainService.js', async (orig) => {
  const real = await orig<typeof import('../src/host/auditChainService.js')>();
  return {
    ...real,
    appendAudit: async (tenant: string, kind: string, payload: Record<string, unknown>) => {
      audits.push({ tenant, kind, payload });
      return real.appendAudit(tenant, kind, payload);
    },
  };
});

import { createApp } from '../src/index.js';
import { _resetOidcVerifier } from '../src/middleware/auth.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { createMember, listMembers, updateMember } from '../src/host/accessControlService.js';
import { operatorActivations } from '../src/host/operatorActivationLedger.js';
import { autoJoinDefaultWorkspaces, hasJoined } from '../src/host/workspaceJoinLedger.js';

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

interface Res { status: number; body: { activation?: { activationId: string; activatedAt: string; expiresAt: string }; removal?: { memberId: string; displayName: string; removed: boolean }; details?: { code?: string; count?: number } } }
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
  process.env.OPENWOP_SUPERADMIN_TENANTS = [personOf('op-1').personal, personOf('op-2').personal].join(',');
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => issuerServer.close(() => res()));
  _resetOidcVerifier();
  for (const k of ['OPENWOP_OIDC_ISSUER', 'OPENWOP_OIDC_AUDIENCE', 'OPENWOP_OIDC_JWKS_URL', 'OPENWOP_SUPERADMIN_TENANTS']) delete process.env[k];
});

const REMOVE = `/host/openwop-app/workspaces/${encodeURIComponent(WS)}/participant-removals`;
const REASON = 'Spam reported in three circles';
const op = () => mint('op-1', { mfa: true, authTime: fresh() });
const rootRow = async (subject: string) => (await listMembers(WS, WS)).find((m) => m.subject === subject);

/** Sign a participant in (the real bind, which runs the auto-join). */
async function signIn(sub: string): Promise<string> {
  const r = await raw('POST', '/host/openwop-app/users/auth/oidc/bind', mint(sub), undefined, sub);
  expect(r.status).toBeLessThan(300);
  return personOf(sub).subject;
}

beforeEach(() => { audits.length = 0; });

describe('D12 — refused before anything changes', () => {
  it('G1 / G3: not a listed superadmin, or no second factor', async () => {
    const p = await signIn('p-guard');
    const row = (await rootRow(p))!;
    const stranger = await call('POST', REMOVE, mint('stranger', { mfa: true, authTime: fresh() }), { member: row.memberId, reason: REASON });
    expect(stranger.body.details?.code).toBe('not_eligible');
    const noMfa = await call('POST', REMOVE, mint('op-1', { authTime: fresh() }), { member: row.memberId, reason: REASON });
    expect(noMfa.body.details?.code).toBe('mfa_required');
    expect(await rootRow(p)).toBeDefined();
  });

  it('no live activation → operator_activation_required, and an expired one too', async () => {
    const p = await signIn('p-noact');
    const row = (await rootRow(p))!;
    const before = await call('POST', REMOVE, op(), { member: row.memberId, reason: REASON });
    expect(before.status).toBe(403);
    expect(before.body.details?.code).toBe('operator_activation_required');

    expect((await call('POST', PATH, op(), GOOD)).status).toBe(201);
    const key = `${WS}::${personOf('op-1').subject}`;
    const live = (await operatorActivations.get(key))!;
    await operatorActivations.put({ ...live, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const expired = await call('POST', REMOVE, op(), { member: row.memberId, reason: REASON });
    expect(expired.body.details?.code).toBe('operator_activation_required');
    expect(await rootRow(p)).toBeDefined();
    await operatorActivations.put(live); // restore the live activation for the legs below
  });

  it('self, another superadmin, an owner and an editor are refused; a short reason is a 400', async () => {
    const self = personOf('op-1').subject;
    const other = await signIn('op-2');
    const owner = await signIn('p-owner');
    const editor = await signIn('p-editor');
    await updateMember((await rootRow(owner))!.memberId, { roles: ['owner'] });
    await updateMember((await rootRow(editor))!.memberId, { roles: ['viewer', 'editor'] });

    const code = async (subject: string, reason = REASON) =>
      (await call('POST', REMOVE, op(), { member: (await rootRow(subject))!.memberId, reason })).body.details?.code;
    expect(await code(self)).toBe('cannot_remove_self');
    expect(await code(other)).toBe('cannot_remove_superadmin');
    expect(await code(owner)).toBe('not_a_participant');
    expect(await code(editor)).toBe('not_a_participant');
    const short = await call('POST', REMOVE, op(), { member: (await rootRow(editor))!.memberId, reason: 'too short' });
    expect(short.status).toBe(400);
    for (const s of [self, other, owner, editor]) expect(await rootRow(s)).toBeDefined();
    expect(audits.filter((a) => a.kind === 'security.operator-participant-removed')).toEqual([]);
  });

  it('a name matching two people is ambiguous and removes nobody', async () => {
    await createMember({ tenantId: WS, orgId: WS, displayName: 'Sam Same', subject: 'user:same-1' });
    await createMember({ tenantId: WS, orgId: WS, displayName: 'sam same', subject: 'user:same-2' });
    const r = await call('POST', REMOVE, op(), { member: 'Sam Same', reason: REASON });
    expect(r.status).toBe(409);
    expect(r.body.details).toMatchObject({ code: 'ambiguous', count: 2 });
    expect(await rootRow('user:same-1')).toBeDefined();
  });
});

describe('D12 — removal holds (the ADR 0684 §7 ban path)', () => {
  it('a dry run names the person and changes nothing', async () => {
    const p = await signIn('p-dry');
    const row = (await rootRow(p))!;
    const r = await call('POST', REMOVE, op(), { member: row.memberId, reason: REASON, dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body.removal).toEqual({ memberId: row.memberId, displayName: row.displayName, removed: false });
    expect(await rootRow(p)).toBeDefined();
    expect(audits).toEqual([]);
  });

  it('removes an auto-joined participant, audits with the activation id, and a re-sign-in does not re-join', async () => {
    const p = await signIn('p-banned');
    const row = (await rootRow(p))!;
    const r = await call('POST', REMOVE, op(), { member: row.memberId, reason: REASON });
    expect(r.status).toBe(200);
    expect(r.body.removal?.removed).toBe(true);
    expect(await rootRow(p)).toBeUndefined();

    const activationId = (await operatorActivations.get(`${WS}::${personOf('op-1').subject}`))!.activationId;
    expect(audits.filter((a) => a.kind === 'security.operator-participant-removed')).toEqual([{
      tenant: WS, kind: 'security.operator-participant-removed',
      payload: { activationId, by: personOf('op-1').subject, memberId: row.memberId, memberSubject: p, reason: REASON },
    }]);

    jars.delete('p-banned');
    await signIn('p-banned'); // the real bind runs the auto-join again
    expect(await rootRow(p)).toBeUndefined();
  });

  it('a participant added by hand (no join record) gets one, so auto-join does not re-add them', async () => {
    const subject = userIdFor(personOf('p-manual').personal, 'oidc:p-manual');
    await createMember({ tenantId: WS, orgId: WS, displayName: 'Manual Person', subject });
    expect(await hasJoined(subject, WS)).toBe(false);
    const r = await call('POST', REMOVE, op(), { member: 'manual person', reason: REASON });
    expect(r.body.removal?.removed).toBe(true);
    expect(await hasJoined(subject, WS)).toBe(true);
    expect(await autoJoinDefaultWorkspaces(subject, 'Manual Person', personOf('p-manual').personal)).toBe(0);
    expect(await rootRow(subject)).toBeUndefined();
  });
});
