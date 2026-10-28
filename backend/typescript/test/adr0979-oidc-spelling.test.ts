/**
 * ADR 0979 H2 — which spelling of a person the ledger (and #4543's run reader,
 * which shares `runPayloadAccess`) matches, MEASURED through the real auth
 * middleware with a synthetic OIDC issuer (the `agents-write-authority` harness).
 *
 * The pre-code review asked for "both spellings". This file is why it was not
 * built: after an OIDC bind the subject's requests present `user:<id>`, so an
 * UNBOUND reader of a canonical-stamped run cannot arise. What IS real is the
 * reverse, pinned here as RESIDUE (AKM2-R1): a run stamped `oidc:<sub>` before
 * the bind is no longer its creator's afterwards, in a shared workspace, while an
 * admin still reads it. When AKM2-R1 is decided, this leg flips on purpose.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import express from 'express';
import { createApp } from '../src/index.js';
import { _resetOidcVerifier } from '../src/middleware/auth.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

let BASE: string;
const AUD = 'openwop-test-aud';
let server: http.Server;
let issuerServer: http.Server;
let issuer: string;
let privateKey: KeyObject;

function mint(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' };
  const payload = { iss: issuer, aud: AUD, sub, iat: now, exp: now + 300 };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createSign('sha256').update(signingInput).sign(privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

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
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  _resetOidcVerifier();
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const def = getToggleDefault('users');
  if (def) await saveConfig({ ...def, status: 'on' }, 'test');
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => issuerServer.close(() => res()));
  _resetOidcVerifier();
  for (const k of ['OPENWOP_OIDC_ISSUER', 'OPENWOP_OIDC_AUDIENCE', 'OPENWOP_OIDC_JWKS_URL']) delete process.env[k];
});

interface Res<T = Record<string, unknown>> { status: number; body: T }
function client(token: string) {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    for (const sc of typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : []) {
      if (/^__session=;/.test(sc)) { cookie = ''; continue; }
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1]!;
    }
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T };
  };
  return { get: <T = Record<string, unknown>>(p: string) => call<T>('GET', p), post: <T = Record<string, unknown>>(p: string, b?: unknown) => call<T>('POST', p, b) };
}
const H = '/host/openwop-app';

interface MemList { entries: Array<{ id: string }>; visibility?: string }

describe('ADR 0979 H2 — the spelling the ledger matches, measured', () => {
  it('pre-bind: the creator sees their summary; post-bind: the RESIDUE (AKM2-R1) — not theirs, still the admin\'s', async () => {
    const stamp = Date.now();
    const ownerSub = `row56-owner-${stamp}`;
    const memberSub = `row56-member-${stamp}`;
    // An unbound owner creates the workspace (its owner row is `oidc:<sub>`).
    const owner = client(mint(ownerSub));
    expect((await owner.get(`${H}/me/workspaces`)).status).toBe(200);
    const ws = String((await owner.post<{ workspaceId?: string }>(`${H}/workspaces`, { name: `Row56 ${stamp}` })).body.workspaceId ?? '');
    expect(ws).not.toBe('');
    expect((await owner.post(`${H}/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    const add = await owner.post(`${H}/orgs/${encodeURIComponent(ws)}/members`, { displayName: 'member', subject: `oidc:${memberSub}`, roles: ['editor'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);

    // The member, UNBOUND, runs a workflow: stamped `oidc:<sub>`.
    const member = client(mint(memberSub));
    expect((await member.get(`${H}/me/workspaces`)).status).toBe(200);
    expect((await member.post(`${H}/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    const run = await member.post<{ runId: string }>('/runs', { workflowId: 'openwop-app.uppercase', inputs: { text: 'row56 two lanes' } });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    for (let i = 0; i < 100; i++) {
      const st = await member.get<{ status?: string }>(`/runs/${encodeURIComponent(run.body.runId)}`);
      if (st.body?.status === 'completed' || st.body?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const raw = run.body.runId.slice(run.body.runId.lastIndexOf('/') + 1);
    const tag = `?tag=${encodeURIComponent(`run-id:${raw}`)}`;
    const before = await member.get<MemList>(`${H}/memory${tag}`);
    expect(before.body.visibility, 'a restricted reader, so the spelling decides').toBe('own-runs');
    expect(before.body.entries.map((e) => e.id), 'the creator matches on the lane that created it').toEqual([`runsummary:${raw}`]);

    // The member BINDS. From now on this subject's requests present the
    // canonical `user:<id>` (`middleware/auth.ts` resolves `boundUserId`), so the
    // state "both spellings" would serve — an UNBOUND reader of a canonical-stamped
    // run — cannot arise.
    expect((await member.post(`${H}/users/auth/oidc/bind`)).status).toBe(200);
    expect((await member.post(`${H}/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    const after = await member.get<MemList>(`${H}/memory${tag}`);
    expect(after.body.visibility).toBe('own-runs');
    expect(after.body.entries, 'RESIDUE AKM2-R1: a pre-bind run is not matched after the bind').toEqual([]);

    // Fail-closed, not lost: the workspace admin still reads it.
    const adminView = await owner.get<MemList>(`${H}/memory${tag}`);
    expect(adminView.body.visibility).toBe('all');
    expect(adminView.body.entries.map((e) => e.id)).toEqual([`runsummary:${raw}`]);
  });
});
