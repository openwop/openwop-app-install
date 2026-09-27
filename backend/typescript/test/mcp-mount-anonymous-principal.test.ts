/**
 * RFC 0153 §E — the MCP server mount refuses ANONYMOUS principals unless the
 * host advertises `anonymousActor` (H43).
 *
 * MEASURED on prod 2026-08-17: an unauthenticated POST to
 * `/v1/host/openwop-app/mcp` answered 200. Not because auth was off — the
 * cookie posture MINTS an `anon:<sid>` principal for a credential-less caller
 * (ADR 0015) and marks it `req.anonymousPrincipal`, and the mount's boundary
 * (`principalFromReq`) only asked "is there a principal?". `auth.ts` says
 * consumers MUST NOT treat an anonymous principal as authenticated; the
 * conformance leg `mcp-current-auth-boundary` says "refuse (401/403) or
 * advertise anonymousActor" — and it was green locally only because the
 * driver's unauthenticated request carries no cookie, so no anon session was
 * ever minted in the lane. This test drives the COOKIE path the way a browser
 * (or a curl without a token) does, which is exactly what prod saw.
 */
import { createApp } from '../src/index.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';

let server: http.Server;
let BASE = '';
let cookie = '';

const REQ = {
  jsonrpc: '2.0', id: 1, method: 'server/discover',
  params: { _meta: { 'openwop/protocolVersion': '2026-07-28' } },
};
const HDR = { 'content-type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' };


beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_MCP_SERVER_ENABLED = 'true';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;   // the COOKIE posture — prod's
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;      // no seam principal fallback
  delete process.env.OPENWOP_ANON_ACTOR_ENABLED;     // anonymousActor NOT advertised
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `mcp-anon-${Date.now()}@acme.test` }),
  });
  expect(login.status, await login.clone().text()).toBe(201);
  for (const ck of getSetCookies(login.headers)) {
    const m = /(__session=[^;]+)/.exec(ck);
    if (m?.[1]) cookie = m[1];
  }
  expect(cookie).toBeTruthy();
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_MCP_SERVER_ENABLED;
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
});

describe('RFC 0153 §E — MCP mount vs anonymous principals (H43)', () => {
  it('a credential-less caller (anon cookie session minted for them) is REFUSED 401 with a flat envelope', async () => {
    const r = await fetch(`${BASE}/v1/host/openwop-app/mcp`, { method: 'POST', headers: HDR, body: JSON.stringify(REQ) });
    // Not 200: the auth middleware minted an anon principal, but that is not authentication.
    expect(r.status).toBe(401);
    const body = await r.json() as { error?: unknown; message?: unknown; details?: { reason?: unknown } };
    expect(body.error).toBe('unauthenticated');
    expect(typeof body.message).toBe('string');
    expect(body.details?.reason).toBe('anonymous_principal_refused');
    // The refusal happens BEFORE dispatch — no JSON-RPC frame leaks method/tool knowledge.
    expect('result' in body).toBe(false);
  });

  it('when the host ADVERTISES anonymousActor (RFC 0132), the same anonymous caller is admitted — advert and behaviour agree', async () => {
    process.env.OPENWOP_ANON_ACTOR_ENABLED = 'true';
    try {
      const r = await fetch(`${BASE}/v1/host/openwop-app/mcp`, { method: 'POST', headers: HDR, body: JSON.stringify(REQ) });
      const body = await r.json() as { error?: unknown; details?: { reason?: unknown } };
      expect(body.details?.reason).not.toBe('anonymous_principal_refused');
      expect(r.status).toBe(200);
    } finally {
      delete process.env.OPENWOP_ANON_ACTOR_ENABLED;
    }
  });

  it('a signed-in (cookie) principal reaches the mount — the boundary is anonymity, not cookies', async () => {
    const r = await fetch(`${BASE}/v1/host/openwop-app/mcp`, { method: 'POST', headers: { ...HDR, cookie }, body: JSON.stringify(REQ) });
    expect(r.status).toBe(200);
    const body = await r.json() as { result?: { resultType?: string } };
    expect(body.result?.resultType).toBe('complete');
  });
});
