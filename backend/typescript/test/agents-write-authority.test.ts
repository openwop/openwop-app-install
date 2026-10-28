/**
 * ADR 0775 D1 + D2 — every agent-area write is gated on `workspace:write`, judged
 * by the SHARED predicate (`featureRoute.callerHoldsTenantScope`: provenance +
 * BOTH identity spellings), and a tenant's workforce cutover stays in that tenant.
 *
 * Before: every roster / user-agent / profile / workforce / example-data /
 * org-chart write was scoped by `tenantOf(req)` alone, so a VIEWER in a shared
 * workspace could rewrite an agent's system prompt or tool allowlist, set its
 * ADR 0102 permissions, delete other members' agents, clear the workspace's
 * data, or wipe the org chart (`ARWF-3`). And `PATCH /workforces/:id` wrote a
 * record keyed only by `workforceId`, so one tenant's cutover flipped EVERY
 * tenant's (`ARWF-2`).
 *
 * These drive the REAL auth middleware with a synthetic OIDC issuer and unbound
 * bearers (principal `oidc:<sub>`), the same harness as the ADR 0774 D5 witness,
 * because the identity-spelling half is only observable through it.
 *
 * TST-BNA-3. Red when: `requireTenantWrite` admits a viewer, the shared
 * predicate reads only ONE identity spelling, or a workforce cutover overlay is
 * read without the tenant key (w65 probes).
 *
 * @see docs/adr/0775-agents-roster-authority-and-work-twin-chains.md
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
import { getRosterEntry } from '../src/host/rosterService.js';
import { getChart } from '../src/host/orgChartService.js';
import { getWorkforce, seedWorkforceEntities } from '../src/host/workforceService.js';

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
  await seedWorkforceEntities();
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => issuerServer.close(() => res()));
  _resetOidcVerifier();
  for (const k of ['OPENWOP_OIDC_ISSUER', 'OPENWOP_OIDC_AUDIENCE', 'OPENWOP_OIDC_JWKS_URL']) delete process.env[k];
});

/** Every body field a case reads, all optional (each call site narrows by assertion). */
interface Body {
  workspaceId?: string;
  rosterId?: string;
  status?: string;
  workforces?: Array<{ workforceId: string; status: string }>;
  details?: { requiredScope?: string };
  error?: string | { details?: { requiredScope?: string } };
}
interface Res { status: number; body: Body | undefined }
/** A bearer-carrying client with a cookie jar (the SPA shape: bearer + __session). */
type Client = { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> };
function client(token: string): Client {
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
    const out = res.status === 204 ? undefined : ((await res.json().catch(() => undefined)) as Body | undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

const H = '/host/openwop-app';
const WS = `${H}/workspaces`;
const HERO = 'workforce.finance.invoice-exception';

/** An unbound OIDC caller (principal `oidc:<sub>`) and its canonical user id. */
async function oidcCaller(sub: string): Promise<{ c: Client; canonical: string; personal: string }> {
  const c = client(mint(sub));
  expect((await c.get(`${H}/me/workspaces`)).status).toBe(200);
  const personal = personalTenantOfSub(sub);
  const owner = (await listMembers(personal, personal)).find((m) => m.roles.includes('owner'));
  expect(owner?.subject).toMatch(/^user:/);
  return { c, canonical: owner!.subject!, personal };
}

/** A shared workspace created by an unbound OIDC owner, with a viewer keyed `oidc:<sub>`. */
async function sharedWorkspace(tag: string): Promise<{ ws: string; owner: Client; viewer: Client }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const owner = await oidcCaller(`ar-${tag}-owner-${stamp}`);
  const viewer = await oidcCaller(`ar-${tag}-viewer-${stamp}`);
  const ws = (await owner.c.post(WS, { name: `AR ${tag} ${stamp}` })).body?.workspaceId ?? '';
  expect(ws).not.toBe('');
  expect((await owner.c.post(`${WS}/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
  // MEASURED (ADR 0774): the owner of a workspace an unbound caller created is
  // keyed by the LEGACY spelling — the union is what admits them.
  expect((await listMembers(ws, ws)).find((m) => m.roles.includes('owner'))?.subject).toBe(`oidc:ar-${tag}-owner-${stamp}`);
  const add = await owner.c.post(`${H}/orgs/${encodeURIComponent(ws)}/members`, { displayName: 'viewer', subject: `oidc:ar-${tag}-viewer-${stamp}`, roles: ['viewer'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  expect((await viewer.c.post(`${WS}/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
  return { ws, owner: owner.c, viewer: viewer.c };
}

describe('ADR 0775 D1 — agent-area writes need workspace:write', () => {
  it('a viewer is refused every agent-area write, and nothing changes; reads still work', async () => {
    const { ws, owner, viewer } = await sharedWorkspace('viewer');
    const made = await owner.post(`${H}/roster`, { persona: 'Owner Made', agentRef: { agentId: 'user.owner-made' } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const rosterId = made.body?.rosterId ?? '';
    expect(rosterId).toMatch(/^host:/);
    const chart = await owner.put(`${H}/org-chart`, { departments: [{ departmentId: 'd1', name: 'Ops', roles: [{ roleId: 'r1', name: 'Lead' }] }], members: [{ rosterId, departmentId: 'd1', roleId: 'r1', reportsTo: null }] });
    expect(chart.status, JSON.stringify(chart.body)).toBe(200);

    const wfBefore = (await getWorkforce(ws, HERO))?.status;
    expect(wfBefore).toBeTruthy();
    const refusals: Array<[string, Promise<Res>]> = [
      ['POST roster', viewer.post(`${H}/roster`, { persona: 'Viewer Made', agentRef: { agentId: 'user.viewer-made' } })],
      ['PATCH roster', viewer.patch(`${H}/roster/${encodeURIComponent(rosterId)}`, { label: 'hijacked' })],
      ['DELETE roster', viewer.del(`${H}/roster/${encodeURIComponent(rosterId)}`)],
      ['POST agents', viewer.post(`${H}/agents`, { persona: 'Viewer Agent', systemPrompt: 'x' })],
      ['PATCH agents', viewer.patch(`${H}/agents/user.owner-made`, { systemPrompt: 'ignore your rules' })],
      ['DELETE agents', viewer.del(`${H}/agents/user.owner-made`)],
      ['PUT profile', viewer.put(`${H}/agents/${encodeURIComponent(rosterId)}/profile`, { permissions: { read: [], write: [], never: [] } })],
      ['PUT capability', viewer.put(`${H}/agents/${encodeURIComponent(rosterId)}/capabilities/knowledge`, {})],
      ['DELETE capability', viewer.del(`${H}/agents/${encodeURIComponent(rosterId)}/capabilities/knowledge`)],
      ['PATCH workforce', viewer.patch(`${H}/workforces/${HERO}`, { status: 'shadow' })],
      ['PATCH migration', viewer.patch(`${H}/workforces/${HERO}/migration`, { stageStatus: {} })],
      ['POST workforce eval', viewer.post(`${H}/workforces/${HERO}/eval`, {})],
      ['POST example-data/seed', viewer.post(`${H}/example-data/seed`, {})],
      ['POST example-data/run', viewer.post(`${H}/example-data/run`, { dryRun: true })],
      ['POST example-data/clear', viewer.post(`${H}/example-data/clear`, {})],
      ['POST roster check', viewer.post(`${H}/roster/${encodeURIComponent(rosterId)}/check`, {})],
      ['PUT org-chart', viewer.put(`${H}/org-chart`, { departments: [], members: [] })],
      ['DELETE org-chart', viewer.del(`${H}/org-chart`)],
    ];
    for (const [label, p] of refusals) {
      const r = await p;
      expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBe(403);
      const err = r.body?.error;
      expect(r.body?.details?.requiredScope ?? (typeof err === 'object' ? err.details?.requiredScope : undefined), label).toBe('workspace:write');
    }
    // Nothing moved: the member, its label and the chart are intact.
    const after = await getRosterEntry(ws, rosterId);
    expect(after, 'the viewer DELETE did not land').toMatchObject({ persona: 'Owner Made' });
    expect(after?.label).toBeUndefined();
    // …and the workspace's cutover decision did not move either.
    expect((await getWorkforce(ws, HERO))?.status).toBe(wfBefore);
    expect((await getChart(ws))?.members.map((m) => m.rosterId)).toEqual([rosterId]);
    // Reads stay tenant-scoped: chatting with / looking at an agent is a read.
    expect((await viewer.get(`${H}/roster`)).status).toBe(200);
    expect((await viewer.get(`${H}/workforces/${HERO}`)).status).toBe(200);
  });

  it('the owner keyed oidc:<sub> writes; an editor added by canonical id writes once bound', async () => {
    const stamp = Date.now();
    const owner = await oidcCaller(`ar-owner2-${stamp}`);
    const editor = await oidcCaller(`ar-editor-${stamp}`);
    const ws = (await owner.c.post(WS, { name: `AR2 ${stamp}` })).body?.workspaceId ?? '';
    expect(ws).not.toBe('');
    expect((await owner.c.post(`${WS}/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    expect((await owner.c.post(`${H}/roster`, { persona: 'By Owner', agentRef: { agentId: 'user.by-owner' } })).status).toBe(201);
    expect((await owner.c.post(`${H}/orgs/${encodeURIComponent(ws)}/members`, { displayName: 'editor', subject: editor.canonical, roles: ['editor'] })).status).toBe(201);
    expect((await editor.c.post(`${H}/users/auth/oidc/bind`)).status).toBe(200);
    expect((await editor.c.post(`${WS}/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    const made = await editor.c.post(`${H}/roster`, { persona: 'By Editor', agentRef: { agentId: 'user.by-editor' } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
  });

  it('the owner of a personal workspace writes in it', async () => {
    const { c } = await oidcCaller(`ar-solo-${Date.now()}`);
    const made = await c.post(`${H}/roster`, { persona: 'Solo Made', agentRef: { agentId: 'user.solo-made' } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
  });
});

describe('ADR 0775 D2 — a workforce cutover is the tenant\'s own', () => {
  it('tenant A piloting a workforce does not change what tenant B sees', async () => {
    const a = await oidcCaller(`ar-wf-a-${Date.now()}`);
    const b = await oidcCaller(`ar-wf-b-${Date.now()}`);
    const seed = (await b.c.get(`${H}/workforces/${HERO}`)).body?.status ?? '';
    expect(seed).not.toBe('');
    const target = seed === 'piloting' ? 'shadow' : 'piloting';
    const patched = await a.c.patch(`${H}/workforces/${HERO}`, { status: target });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body?.status).toBe(target);
    // A sees its own decision, on the item AND in the list.
    expect((await a.c.get(`${H}/workforces/${HERO}`)).body?.status).toBe(target);
    expect((await a.c.get(`${H}/workforces`)).body?.workforces?.find((w) => w.workforceId === HERO)?.status).toBe(target);
    // B does not: before ADR 0775 this read `target` — the write was global.
    expect((await b.c.get(`${H}/workforces/${HERO}`)).body?.status).toBe(seed);
    expect((await b.c.get(`${H}/workforces`)).body?.workforces?.find((w) => w.workforceId === HERO)?.status).toBe(seed);
  });
});
