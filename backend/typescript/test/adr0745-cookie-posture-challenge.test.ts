/**
 * RFC 0200 §B.1 in the PRODUCTION auth posture (cookies ON) — the invariants, whichever
 * rule owns them.
 *
 * Every other RFC 0200 test boots with `OPENWOP_AUTH_DISABLE_COOKIES=true`, the
 * conformance posture, not the one `app.openwop.dev` runs. In cookie mode a
 * credential-less request used to be handed a fresh `anon:<sid>` tenant, so a bare
 * `GET /runs/{id}` answered 404 instead of 401 + the challenge.
 *
 * The RULE belongs to ADR 0750 (#4106); ADR 0745 withdrew its own (D1). This file pins
 * what must hold whichever predicate decides it:
 *   - a bare MAJOR-2 protocol call with no credential → 401, `Bearer
 *     resource_metadata=…`, no error code, no session minted;
 *   - a presented-and-refused bearer → 401 `error="invalid_token"`, no session minted;
 *   - the anonymous-first product posture survives: a browser visitor still gets a
 *     session, and that session is honoured on the protocol surface.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE = '';
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_AUTH_ENFORCE_BEARER']) saved[k] = process.env[k];
  // The posture is captured at construction (ADR 0743 harness note) — set it FIRST.
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'adr0745-cookie-posture',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const sessionCookie = (res: Response): string | null => {
  const raw = res.headers.get('set-cookie');
  const m = raw ? /(__session=[^;]+)/.exec(raw) : null;
  return m ? m[1]! : null;
};

function challengeParams(res: Response): Record<string, string> {
  const h = res.headers.get('www-authenticate') ?? '';
  expect(h, 'a 401 MUST carry WWW-Authenticate (RFC 9110 §15.5.2)').toMatch(/^Bearer /);
  return Object.fromEntries([...h.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
}

const V2 = { 'OpenWOP-Version': '2.0', accept: 'application/json' };

describe('RFC 0200 §B.1 in cookie mode — a bare major-2 protocol client', () => {
  // Owned by ADR 0750 (#4106). MEASURED before it merged: red on the prior main (404 +
  // a minted session — the defect), green against #4106's rule.
  it('no credential → 401, Bearer + resource_metadata, NO error code, no session minted (ADR 0750)', async () => {
    const res = await fetch(`${BASE}/runs/run-that-does-not-exist`, { headers: V2 });
    expect(res.status).toBe(401);
    expect(sessionCookie(res), 'a refused bare caller must not be handed a tenant').toBeNull();
    const p = challengeParams(res);
    expect(p['resource_metadata']).toBe(`${BASE}/.well-known/oauth-protected-resource`);
    expect(p['error'], 'RFC 6750 §3.1 — no credential was presented').toBeUndefined();
  });

  it('a garbage bearer → 401 error="invalid_token", and no session is minted in its place (ADR 0434)', async () => {
    const res = await fetch(`${BASE}/runs/run-that-does-not-exist`, { headers: { ...V2, authorization: 'Bearer not-a-real-credential' } });
    expect(res.status).toBe(401);
    expect(sessionCookie(res)).toBeNull();
    const p = challengeParams(res);
    expect(p['error']).toBe('invalid_token');
    expect(p['resource_metadata']).toBe(`${BASE}/.well-known/oauth-protected-resource`);
  });

  it('behind the Hosting rewrite (`/api/…`, as production is reached) the challenge names the sub-path PRM', async () => {
    const res = await fetch(`${BASE}/api/runs/run-that-does-not-exist`, { headers: { ...V2, authorization: 'Bearer not-a-real-credential' } });
    expect(res.status).toBe(401);
    expect(challengeParams(res)['resource_metadata']).toBe(`${BASE}/.well-known/oauth-protected-resource/api`);
  });
});

describe('major 1 behaves as main does (ADR 0750 scopes its rule to major 2)', () => {
  it('a bare major-1 protocol call with no credential is minted an anonymous session and gets the resource answer', async () => {
    // Pins TODAY's major-1 behaviour so a change to it is a decision, not a side effect.
    // Outside RFC 0200's MUST (§A.5: v1 gains no new MUST) — ADR 0745 D1 residual.
    const res = await fetch(`${BASE}/v1/runs/run-that-does-not-exist`);
    expect(res.status).toBe(404);
    expect(sessionCookie(res)).toMatch(/^__session=/);
  });
});

describe('the anonymous-first product posture survives (regression)', () => {
  it('a browser first visit gets a session, and the protocol surface honours it', async () => {
    // The SPA bootstraps on a host-extension route (ADR 0750 keeps that minting).
    const boot = await fetch(`${BASE}/v1/host/openwop-app/workflows`, { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(boot.status).toBe(200);
    const cookie = sessionCookie(boot);
    expect(cookie).toMatch(/^__session=/);
    // Its later protocol calls carry only the cookie, and are served in that tenant.
    const list = await fetch(`${BASE}/runs`, { headers: { ...V2, cookie: cookie! } });
    expect(list.status, 'the anonymous visitor is a principal on the protocol surface').toBe(200);
    expect(sessionCookie(list), 'no second identity is minted').toBeNull();
  });
});
