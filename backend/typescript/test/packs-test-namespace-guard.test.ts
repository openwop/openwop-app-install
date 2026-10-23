/**
 * The packs-test namespace can be enabled on a production-posture deployment
 * (the RFC 0199 witness side revision); its MUTATIONS need a non-anonymous
 * principal there. Cookies ON here, so an anonymous caller really is an
 * anonymous SESSION (not merely a missing bearer) — the case the guard exists for.
 *
 * The guard is `requireNonAnonymousPrincipal` (src/middleware/auth.ts), mounted
 * on `/packs-test` for every non-GET method (src/routes/packs-test.ts). Its 401
 * is asserted by its BODY (`details.reason: 'anonymous_principal_refused'`), so
 * the global ADR 0750 credential-less 401 cannot satisfy it (ADR 0812 P3c-0).
 * Witnessed: dropping the guard mount (probe 8fw1g1-pn-guard) reds the refusal.
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

const ENV_KEYS = [
  'OPENWOP_STORAGE_DSN',
  'OPENWOP_AUTH_DISABLE_COOKIES',
  'OPENWOP_PACKS_TEST_NAMESPACE_ENABLED',
  'OPENWOP_SESSION_SECRET',
] as const;
const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

interface ErrorBody { error?: string; message?: string; details?: { reason?: string } }

async function expectAnonRefused(res: Response): Promise<void> {
  expect(res.status).toBe(401);
  const body = (await res.json()) as ErrorBody;
  expect(body.error).toBe('unauthenticated');
  expect(body.details?.reason).toBe('anonymous_principal_refused');
  expect(body.message).toContain('the packs-test namespace');
}

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
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise<void>((res) => server.close(() => res()));
});

describe('packs-test namespace mutations need a non-anonymous principal', () => {
  it('anonymous reset / delete are refused 401', async () => {
    await expectAnonRefused(await fetch(`${BASE}/packs-test/reset`, { method: 'POST', headers: anon }));
    await expectAnonRefused(await fetch(`${BASE}/packs-test/foo/-/1.0.0`, { method: 'DELETE', headers: anon }));
  });

  it('an authenticated caller can reset', async () => {
    const r = await fetch(`${BASE}/packs-test/reset`, { method: 'POST', headers: { authorization: 'Bearer dev-token' } });
    expect(r.status).toBe(200);
    // Nothing is published in this file, so the cleared count is exactly 0.
    expect(await r.json()).toEqual({ cleared: 0 });
  });

  it('reads stay open (the suite fetches tarballs anonymously)', async () => {
    // The anonymous read REACHES the route: a well-formed but unpublished pack is
    // the route's own 404, not any refusal. (This used to fetch `nope`, which the
    // route refuses 400 `invalid_pack_name`; `.not.toBe(401)` accepted that.)
    const r = await fetch(`${BASE}/packs-test/community.test.not-published/-/1.0.0.tgz`, { headers: anon });
    expect(r.status).toBe(404);
    // A host error code, so the major-2 wire namespaces it (`openwop-app.<code>`).
    expect(((await r.json()) as ErrorBody).error).toBe('openwop-app.pack_not_found');
  });
});
