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

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  process.env.OPENWOP_PACKS_TEST_NAMESPACE_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  delete process.env.OPENWOP_PACKS_TEST_NAMESPACE_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('packs-test namespace mutations need a non-anonymous principal', () => {
  it('anonymous reset / delete are refused 401', async () => {
    expect((await fetch(`${BASE}/v1/packs-test/reset`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${BASE}/v1/packs-test/foo/-/1.0.0`, { method: 'DELETE' })).status).toBe(401);
  });

  it('an authenticated caller can reset', async () => {
    const r = await fetch(`${BASE}/v1/packs-test/reset`, { method: 'POST', headers: { authorization: 'Bearer dev-token' } });
    expect(r.status).toBe(200);
  });

  it('reads stay open (the suite fetches tarballs anonymously)', async () => {
    expect((await fetch(`${BASE}/v1/packs-test/nope/-/1.0.0.tgz`)).status).not.toBe(401);
  });
});
