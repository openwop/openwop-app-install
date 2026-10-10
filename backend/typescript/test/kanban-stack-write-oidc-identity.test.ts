/**
 * ADR 0774 D5 — the kanban write gate reads a person by their CANONICAL identity.
 *
 * Two spellings of one human are in play: an unbound OIDC bearer presents the
 * legacy `oidc:<sub>` principal, while memberships key on the canonical
 * `user:<userId>` (ADR 0003). A gate that compared the raw principal against
 * the member table would refuse a real editor who arrives on the legacy
 * spelling (the class of the Google-connections 403), and a gate that trusted
 * the tenant's SHAPE would admit a guest. These drive the real auth middleware
 * with a synthetic OIDC issuer and unbound bearers (principal `oidc:<sub>`):
 *   - the owner of a personal workspace (member keyed `user:<id>`) is admitted;
 *   - the owner of a shared workspace an unbound caller created (member keyed
 *     `oidc:<sub>` — MEASURED) is admitted: a canonical-only check refused it;
 *   - a viewer keyed `oidc:<sub>` is refused;
 *   - an editor keyed by canonical id is admitted once bound.
 * So the gate judges a person by the UNION of both spellings.
 *
 * @see docs/adr/0774-kanban-stack-claim-integrity.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync, createHash, type KeyObject } from 'node:crypto';
import express from 'express';
import { createApp } from '../src/index.js';
import { _resetOidcVerifier } from '../src/middleware/auth.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { listMembers } from '../src/host/accessControlService.js';

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

/** Reproduce middleware/auth.ts `tenantIdFromOidc`. */
function personalTenantOfSub(sub: string): string {
  return `user:${createHash('sha256').update(`${issuer}:${sub}`).digest('hex').slice(0, 32)}`;
}

beforeAll(async () => {
  const { publicKey, privateKey: priv } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = priv;
  const pubJwk = publicKey.export({ format: 'jwk' });
  const jwks = { keys: [{ ...pubJwk, kid: 'test-kid-1', alg: 'RS256', use: 'sig' }] };
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

interface Res<T = any> { status: number; body: T }
/** A bearer-carrying client with a cookie jar (the SPA shape: bearer + __session). */
function client(token: string): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    for (const sc of setCookies) {
      // ADR 0621 — honour a cookie CLEAR (`__session=; …Max-Age=0`) the way a
      // browser does: the jar drops the session instead of replaying it.
      if (/^__session=;/.test(sc)) { cookie = ''; continue; }
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

const K = '/host/openwop-app/kanban';
const WS = '/host/openwop-app/workspaces';

/** An unbound OIDC caller (principal `oidc:<sub>`) and its canonical user id. */
async function oidcCaller(sub: string): Promise<{ c: ReturnType<typeof client>; canonical: string; personal: string }> {
  const c = client(mint(sub));
  expect((await c.get('/host/openwop-app/me/workspaces')).status).toBe(200);
  const personal = personalTenantOfSub(sub);
  const owner = (await listMembers(personal, personal)).find((m) => m.roles.includes('owner'));
  expect(owner?.subject).toMatch(/^user:/);
  return { c, canonical: owner!.subject!, personal };
}

describe('ADR 0774 D5 — legacy oidc:<sub> callers are judged by their canonical identity', () => {
  it('the personal-workspace owner arriving as oidc:<sub> is admitted in their own workspace', async () => {
    const { c } = await oidcCaller(`kst-owner-${Date.now()}`);
    const board = await c.post(`${K}/boards`, { name: 'Mine' });
    expect(board.status, JSON.stringify(board.body)).toBe(201);
    expect((await c.post(`${K}/boards/${board.body.id}/cards`, { title: 'ok', columnId: 'todo' })).status).toBe(201);
  });

  it('in a shared workspace: an owner keyed oidc:<sub> is admitted, a viewer keyed oidc:<sub> is refused', async () => {
    const stamp = Date.now();
    const owner = await oidcCaller(`kst-wsowner-${stamp}`);
    const viewer = await oidcCaller(`kst-viewer-${stamp}`);
    const ws = (await owner.c.post(WS, { name: `KST ${stamp}` })).body.workspaceId as string;
    expect((await owner.c.post(`${WS}/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    // MEASURED: a workspace created by an unbound OIDC caller records its OWNER
    // under the LEGACY spelling — so a gate that checked only the canonical
    // `user:<id>` would lock the owner out of their own workspace's boards.
    expect((await listMembers(ws, ws)).find((m) => m.roles.includes('owner'))?.subject).toBe(`oidc:kst-wsowner-${stamp}`);
    const board = await owner.c.post(`${K}/boards`, { name: 'Shared' });
    expect(board.status, JSON.stringify(board.body)).toBe(201);

    const add = await owner.c.post(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`, { displayName: 'viewer', subject: `oidc:kst-viewer-${stamp}`, roles: ['viewer'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect((await viewer.c.post(`${WS}/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    const refused = await viewer.c.post(`${K}/boards/${board.body.id}/cards`, { title: 'by the viewer', columnId: 'todo' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
  });

  it('an editor added by CANONICAL id is admitted once their bearer resolves user:<id> (bound)', async () => {
    const stamp = Date.now();
    const owner = await oidcCaller(`kst-wsowner2-${stamp}`);
    const editor = await oidcCaller(`kst-editor-${stamp}`);
    const ws = (await owner.c.post(WS, { name: `KST2 ${stamp}` })).body.workspaceId as string;
    expect((await owner.c.post(`${WS}/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    const board = (await owner.c.post(`${K}/boards`, { name: 'Shared 2' })).body;
    expect((await owner.c.post(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`, { displayName: 'editor', subject: editor.canonical, roles: ['editor'] })).status).toBe(201);
    expect((await editor.c.post('/host/openwop-app/users/auth/oidc/bind')).status).toBe(200);
    const sw = await editor.c.post(`${WS}/${encodeURIComponent(ws)}/switch`);
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    const made = await editor.c.post(`${K}/boards/${board.id}/cards`, { title: 'by the editor', columnId: 'todo' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
  });
});
