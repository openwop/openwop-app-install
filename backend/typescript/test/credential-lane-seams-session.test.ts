/**
 * RFC 0170 §B.3 — the SESSION lane of the mint/revoke seams (suite ≥ 2.40.3,
 * openwop#1602 cookie presentation). Cookies ENABLED here, as in production: the
 * lane is advertised only then, and the credential is the session cookie itself.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('RFC 0170 — session lane: cookie-presented mint, epoch-bump revoke', () => {
  it('discovery advertises session (next-request) and anonymous WITHOUT a revocation rule', async () => {
    const d = (await (await fetch(`${BASE}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } })).json()) as { auth?: { lanes?: { lane: string; revocation?: string }[] } };
    const lanes = d.auth?.lanes ?? [];
    expect(lanes.find((l) => l.lane === 'session')?.revocation).toBe('next-request');
    const anon = lanes.find((l) => l.lane === 'anonymous');
    expect(anon).toBeDefined();
    expect(anon && 'revocation' in anon).toBe(false);
  });

  it('mint → authenticate by cookie → revoke → the next request is 401 credential_revoked (v2)', async () => {
    const minted = await fetch(`${BASE}/conformance/seams/sample/auth/credential/mint`, { method: 'POST', headers: H, body: JSON.stringify({ lane: 'session' }) });
    expect(minted.status, await minted.clone().text()).toBe(201);
    const m = (await minted.json()) as { lane: string; credential: string; presentation?: { kind: string; name: string } };
    expect(m.lane).toBe('session');
    expect(m.presentation?.kind).toBe('cookie');
    const cookie = { cookie: `${m.presentation!.name}=${m.credential}`, 'OpenWOP-Version': '2', accept: 'application/json' };
    expect((await fetch(`${BASE}/runs`, { headers: cookie })).status).not.toBe(401);

    const rev = await fetch(`${BASE}/conformance/seams/sample/auth/credential/revoke`, { method: 'POST', headers: H, body: JSON.stringify({ lane: 'session', credential: m.credential }) });
    expect(rev.status).toBe(200);

    const after = await fetch(`${BASE}/runs`, { headers: cookie });
    expect(after.status).toBe(401);
    const body = (await after.json()) as { error?: unknown };
    const code = typeof body.error === 'string' ? body.error : (body.error as { code?: string } | undefined)?.code;
    expect(code).toBe('credential_revoked');
  });
});
