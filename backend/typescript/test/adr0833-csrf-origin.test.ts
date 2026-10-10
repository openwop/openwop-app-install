/**
 * ADR 0833 S4 / D4 — the CSRF Origin guard and the cookie's SameSite posture
 * come from ONE predicate, witnessed through the REAL app (`createApp`), so the
 * guard's MOUNT is part of the claim (the guard's own decision table is the
 * unit test `src/middleware/__tests__/csrf.test.ts`, which also owns the
 * explicit-allowlist cases — this file no longer repeats them).
 *
 * RED on `97baad74b`: with a production-shaped cookie (`SameSite=None; Secure`)
 * and NO `OPENWOP_CORS_ORIGINS`, the guard's allowlist was reflect-any, so a
 * cross-site form POST carrying the victim's cookie reached the body-less
 * `/users/me/sessions/revoke`, `/users/users/:id/disable` routes.
 *
 * Sabotage that turns it red: `cors.ts` `return selfOrigins(req).has(normalized);`
 * → `return true;` reds the cross-site and lookalike cases; dropping the
 * `csrfOriginGuard()` mount from `createApp` reds them too (the unit test stays
 * green — this is the wiring witness).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_COOKIE_SECURE = 'true'; // SameSite=None — the production posture
  delete process.env.OPENWOP_CORS_ORIGINS;
  delete process.env.PUBLIC_BASE_URL;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.OPENWOP_COOKIE_SECURE;
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
});

async function login(subject: string): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, displayName: subject }),
  });
  expect(res.status).toBe(201);
  return /(__session=[^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
}

interface Body { error?: string; details?: { code?: string }; signedOut?: boolean }
async function revoke(cookie: string, origin: string): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${BASE}/host/openwop-app/users/me/sessions/revoke`, { method: 'POST', headers: { cookie, origin } });
  return { status: res.status, body: (await res.json()) as Body };
}
function expectCsrfRefusal(r: { status: number; body: Body }, label: string): void {
  expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBe(403);
  expect(r.body.details?.code, label).toBe('csrf_origin_rejected');
  expect(r.body.signedOut, `${label}: the route must not have run`).toBeUndefined();
}

describe('S4 / D4 — cross-site cookie + no allowlist ⇒ same-origin only', () => {
  it('a cross-site POST carrying the cookie is refused (403 csrf_origin_rejected)', async () => {
    const cookie = await login('oidc:adr0833-csrf-a');
    expectCsrfRefusal(await revoke(cookie, 'https://evil.example'), 'cross-site');
  });

  it('a lookalike origin on another port or scheme is refused too', async () => {
    const cookie = await login('oidc:adr0833-csrf-b');
    const port = new URL(BASE).port;
    expectCsrfRefusal(await revoke(cookie, `https://127.0.0.1:${port}`), 'same host+port, other scheme');
    expectCsrfRefusal(await revoke(cookie, 'http://127.0.0.1:1'), 'same host+scheme, other port');
  });

  // An opaque `null` origin (sandboxed iframe, data: URL) is refused. It is
  // fail-closed TWICE by construction (`origin === 'null'` AND the URL-parse
  // catch in `credentialedOriginAllowed`), so no single-line edit turns this red;
  // it is kept as the behaviour statement, not as a witness for either line.
  it('an opaque `null` origin is refused (fail-closed by two independent guards)', async () => {
    const cookie = await login('oidc:adr0833-csrf-null');
    expectCsrfRefusal(await revoke(cookie, 'null'), 'null origin');
  });

  it('the host’s OWN origin passes (allowed-with — the refusal is the origin, not the route)', async () => {
    const cookie = await login('oidc:adr0833-csrf-c');
    const res = await revoke(cookie, BASE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.signedOut).toBe(true);
  });
});
