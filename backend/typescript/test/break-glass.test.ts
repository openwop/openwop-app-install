/**
 * Break-glass operator login (ADR 0389 Phase 3) — over HTTP against the real
 * app: disabled ⇒ 404 (invisible); config gaps + wrong token ⇒ opaque 401 with
 * an audited denial reason; success ⇒ short-TTL superadmin-tenant cookie +
 * audit + single-use burn (a second identical login is refused); the per-IP
 * attempt window 429s brute force. The route is PUBLIC-prefixed so a hardened
 * cookie-less posture can't lock the operator out of it.
 *
 * `createApp` is load-bearing here: the no-sliding-refresh claim (grade SEC-C2)
 * lives in the global auth middleware's refresh branch, which only a follow-up
 * request through the real stack exercises.
 *
 * Sabotage that turns it red (`authBreakGlass.ts`): `if (!enabled()) {` →
 * `if (false) {` ⇒ the 404 case; `if (!claimed) return` → `if (false) return` ⇒
 * the burn; `noRefresh: true,` → `noRefresh: false,` ⇒ the follow-up request
 * re-mints a 24h cookie; `if (times.length >= MAX_ATTEMPTS) {` → `if (false) {` ⇒ 429.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { hashBreakGlassToken, _resetBreakGlassAttempts } from '../src/routes/authBreakGlass.js';
import { listChain, __resetAuditChain } from '../src/host/auditChainService.js';
import { verifySession } from '../src/middleware/cookieSession.js';

let server: http.Server;
let BASE: string;
const PATH = '/host/openwop-app/auth/break-glass';
const TENANT = 'ws:breakglass-test';
const TOKEN = 'a-very-long-break-glass-token-1234567890';
const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_BREAKGLASS_ENABLED', 'OPENWOP_BREAKGLASS_TOKEN_HASH', 'OPENWOP_BREAKGLASS_TENANT', 'OPENWOP_SUPERADMIN_TENANTS', 'OPENWOP_SUPERADMIN_REQUIRE_MFA'] as const;
const SAVED_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE}${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_BREAKGLASS_ENABLED;
  delete process.env.OPENWOP_BREAKGLASS_TOKEN_HASH;
  delete process.env.OPENWOP_BREAKGLASS_TENANT;
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterEach(() => {
  _resetBreakGlassAttempts();
  delete process.env.OPENWOP_BREAKGLASS_ENABLED;
  delete process.env.OPENWOP_BREAKGLASS_TOKEN_HASH;
  delete process.env.OPENWOP_BREAKGLASS_TENANT;
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  delete process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA;
});

afterAll(async () => {
  await __resetAuditChain();
  await new Promise<void>((res) => server.close(() => res()));
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

function arm(): void {
  process.env.OPENWOP_BREAKGLASS_ENABLED = 'true';
  process.env.OPENWOP_BREAKGLASS_TOKEN_HASH = hashBreakGlassToken(TOKEN);
  process.env.OPENWOP_BREAKGLASS_TENANT = TENANT;
  process.env.OPENWOP_SUPERADMIN_TENANTS = TENANT;
}

describe('ADR 0389 P3 — break-glass', () => {
  it('disabled ⇒ 404, indistinguishable from a missing route', async () => {
    const res = await post({ token: TOKEN });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe('not_found');
    expect(res.headers.get('set-cookie') ?? '').not.toMatch(/__session=[^;]/);
  });

  it('wrong token ⇒ opaque 401 + audited denial', async () => {
    arm();
    const res = await post({ token: 'wrong-token-wrong-token-wrong' });
    expect(res.status).toBe(401);
    const chain = await listChain(TENANT);
    const denied = chain.filter((e) => e.kind === 'security.breakglass-denied');
    expect(denied.length).toBeGreaterThan(0);
    expect((denied.at(-1)!.payload as { reason?: string }).reason).toBe('token_mismatch');
  });

  it('tenant not in OPENWOP_SUPERADMIN_TENANTS ⇒ refused (fail-closed config)', async () => {
    arm();
    process.env.OPENWOP_SUPERADMIN_TENANTS = 'ws:some-other-tenant';
    const res = await post({ token: TOKEN });
    expect(res.status).toBe(401);
    const chain = await listChain(TENANT);
    expect((chain.at(-1)!.payload as { reason?: string }).reason).toBe('tenant_not_superadmin');
  });

  it('success ⇒ short-TTL superadmin-tenant cookie + audit; the token then BURNS (single-use)', async () => {
    arm();
    const res = await post({ token: TOKEN });
    expect(res.status, JSON.stringify(await res.clone().json().catch(() => null))).toBe(200);
    const body = (await res.json()) as { ok: boolean; tenantId: string; expiresInSeconds: number };
    expect(body.tenantId).toBe(TENANT);
    expect(body.expiresInSeconds).toBe(600);

    // The cookie is a user-tier session for the break-glass tenant with ≤10min TTL.
    const setCookie = res.headers.get('set-cookie') ?? '';
    const m = /__session=([^;]+)/.exec(setCookie);
    expect(m).toBeTruthy();
    const session = verifySession(m![1]!);
    expect(session?.tenantId).toBe(TENANT);
    expect(session?.tier).toBe('user');
    expect(session!.exp - session!.iat).toBeLessThanOrEqual(600);
    expect(session?.subject?.startsWith('breakglass:')).toBe(true);

    const chain = await listChain(TENANT);
    expect(chain.some((e) => e.kind === 'security.breakglass-login')).toBe(true);

    // Single-use: the SAME token is now burned.
    _resetBreakGlassAttempts();
    const again = await post({ token: TOKEN });
    expect(again.status).toBe(401);
    const denied = (await listChain(TENANT)).filter((e) => e.kind === 'security.breakglass-denied');
    expect((denied.at(-1)!.payload as { reason?: string }).reason).toBe('token_already_used');

    // Rotating the hash re-arms.
    process.env.OPENWOP_BREAKGLASS_TOKEN_HASH = hashBreakGlassToken(TOKEN);
    _resetBreakGlassAttempts();
    const rearmed = await post({ token: TOKEN });
    expect(rearmed.status).toBe(200);

    // GRADE SEC-C2: the 10-minute window is HARD — a follow-up request must
    // NOT sliding-refresh the cookie to the standard 24h TTL.
    const cookie2 = /__session=([^;]+)/.exec(rearmed.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const follow = await fetch(`${BASE}/host/openwop-app/me/workspaces`, { headers: { cookie: `__session=${cookie2}` } });
    expect(follow.status).toBe(200);
    // Whatever session the browser holds AFTER the follow-up (a re-issued cookie
    // if the middleware set one, else the original) must still end within the
    // original 10-minute window — never a sliding 24h refresh.
    const reissued = /__session=([^;]+)/.exec(follow.headers.get('set-cookie') ?? '')?.[1];
    const original = verifySession(cookie2);
    const held = verifySession(reissued ?? cookie2);
    expect(held).not.toBeNull();
    expect(held!.exp).toBeLessThanOrEqual(original!.exp);
    expect(held!.exp - held!.iat).toBeLessThanOrEqual(600);
  });

  // ADR 0981 P3 no-lockout: with the superadmin second factor REQUIRED (the strict
  // profile's D2 row 8), break-glass still reaches a superadmin surface. It is the
  // recovery door for a superadmin who cannot produce a factor.
  it('with OPENWOP_SUPERADMIN_REQUIRE_MFA=true, a break-glass session still reaches a superadmin route', async () => {
    arm();
    process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA = 'true';
    const res = await post({ token: TOKEN });
    expect(res.status).toBe(200);
    const cookie = /__session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const admin = await fetch(`${BASE}/host/openwop-app/operations/profile-census`, { headers: { cookie: `__session=${cookie}` } });
    expect(admin.status, await admin.clone().text()).toBe(200);
  });

  it('per-IP window ⇒ 429 after repeated attempts', async () => {
    arm();
    for (let i = 0; i < 5; i++) {
      await post({ token: 'nope-nope-nope-nope' }, { 'x-forwarded-for': '203.0.113.9' });
    }
    const res = await post({ token: 'nope-nope-nope-nope' }, { 'x-forwarded-for': '203.0.113.9' });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error?: string }).error).toBe('rate_limited');
    // PER-IP: the window that throttles .9 must not throttle a different caller,
    // who still reaches the token check (opaque 401), not the 429.
    const other = await post({ token: 'nope-nope-nope-nope' }, { 'x-forwarded-for': '203.0.113.10' });
    expect(other.status).toBe(401);
  });
});
