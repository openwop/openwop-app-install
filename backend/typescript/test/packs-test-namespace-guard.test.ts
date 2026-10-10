/**
 * The packs-test namespace can be enabled on a production-posture deployment
 * (the RFC 0199 witness side revision); its MUTATIONS need a non-anonymous
 * principal there. Cookies ON here, so an anonymous caller really is an
 * anonymous SESSION (not merely a missing bearer) — the case the guard exists for.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE = '';
/** An anonymous SESSION. ADR 0812 P3c-0 — on the major-2 wire a request with NO credential
 *  is refused 401 by the global layer before any route (ADR 0750), which would make the
 *  guard legs below vacuous; so the anonymous caller presents the anon session the vendor
 *  space mints, and it is the GUARD that must refuse it. */
let anon: Record<string, string> = {};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  process.env.OPENWOP_PACKS_TEST_NAMESPACE_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const boot = await fetch(`${BASE}/host/openwop-app/users/me`);
  const m = /(__session=[^;]+)/.exec(boot.headers.get('set-cookie') ?? '');
  expect(m?.[1], 'the vendor space must mint an anonymous session').toBeTruthy();
  anon = { cookie: m![1]! };
});

afterAll(async () => {
  delete process.env.OPENWOP_PACKS_TEST_NAMESPACE_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('packs-test namespace mutations need a non-anonymous principal', () => {
  it('anonymous reset / delete are refused 401', async () => {
    expect((await fetch(`${BASE}/packs-test/reset`, { method: 'POST', headers: anon })).status).toBe(401);
    expect((await fetch(`${BASE}/packs-test/foo/-/1.0.0`, { method: 'DELETE', headers: anon })).status).toBe(401);
  });

  it('an authenticated caller can reset', async () => {
    const r = await fetch(`${BASE}/packs-test/reset`, { method: 'POST', headers: { authorization: 'Bearer dev-token' } });
    expect(r.status).toBe(200);
  });

  it('reads stay open (the suite fetches tarballs anonymously)', async () => {
    expect((await fetch(`${BASE}/packs-test/nope/-/1.0.0.tgz`, { headers: anon })).status).not.toBe(401);
  });
});
