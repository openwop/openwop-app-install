/**
 * CSRF Origin guard (2026-07 vuln-scan M4; ADR 0833 D4). Guards cookie-authed
 * unsafe methods against the CORS origin allowlist so a cross-site form POST to
 * a cookie-authed mutation (forced logout) is blocked, WITHOUT breaking the SPA
 * (allowlisted origin), bearer/webhook callers (no cookie), or the
 * cross-origin-by-design public embed surfaces (exempt).
 *
 * The guard runs on a REAL Express request (a bare app on an ephemeral port —
 * no `createApp`), so the request the guard reads is production-shaped; the
 * route-level wiring inside `createApp` is witnessed separately by
 * `test/adr0833-csrf-origin.test.ts`.
 *
 * The "no allowlist ⇒ admit" case holds only because the cookie here is NOT
 * cross-site (no `NODE_ENV=production` / `OPENWOP_COOKIE_SECURE`): ADR 0833 D4
 * made the no-allowlist answer follow the cookie's SameSite posture
 * (`cors.ts credentialedOriginAllowed`), and the cross-site posture is the
 * adr0833 file's subject.
 *
 * Sabotage that turns it red: `csrf.ts` `if (!credentialedOriginAllowed(origin, req)) {`
 * → `if (false) {` reds the BLOCKS cases.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { csrfOriginGuard } from '../csrf.js';
import { COOKIE_NAME } from '../cookieSession.js';
import { OpenwopError } from '../../types.js';

let server: http.Server;
let BASE = '';

beforeAll(async () => {
  const app = express();
  app.use(csrfOriginGuard());
  app.use((_req: Request, res: Response) => { res.status(200).json({ passed: true }); });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof OpenwopError) {
      res.status(err.httpStatus).json({ error: err.code, details: err.details ?? {} });
      return;
    }
    res.status(500).json({ error: 'unexpected' });
  });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

interface Outcome { status: number; body: { passed?: boolean; error?: string; details?: { code?: string } } }

async function run(opts: { method?: string; path?: string; cookie?: boolean; origin?: string; referer?: string }): Promise<Outcome> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = `${COOKIE_NAME}=abc.def`;
  if (opts.origin) headers.origin = opts.origin;
  if (opts.referer) headers.referer = opts.referer;
  const res = await fetch(`${BASE}${opts.path ?? '/host/openwop-app/users/auth/logout'}`, { method: opts.method ?? 'POST', headers });
  return { status: res.status, body: (await res.json()) as Outcome['body'] };
}

function expectPassed(o: Outcome): void {
  expect(o.status, JSON.stringify(o.body)).toBe(200);
  expect(o.body.passed).toBe(true);
}
function expectBlocked(o: Outcome): void {
  expect(o.status, JSON.stringify(o.body)).toBe(403);
  expect(o.body.error).toBe('forbidden');
  expect(o.body.details?.code).toBe('csrf_origin_rejected');
}

const prev = process.env.OPENWOP_CORS_ORIGINS;
afterEach(() => { if (prev === undefined) delete process.env.OPENWOP_CORS_ORIGINS; else process.env.OPENWOP_CORS_ORIGINS = prev; });

describe('csrfOriginGuard — with an explicit allowlist (prod posture)', () => {
  beforeEach(() => { process.env.OPENWOP_CORS_ORIGINS = 'https://app.openwop.dev'; });

  it('allows a GET (safe method)', async () => {
    expectPassed(await run({ method: 'GET', cookie: true, origin: 'https://evil.example' }));
  });
  it('BLOCKS a cookie-authed POST from an attacker origin', async () => {
    expectBlocked(await run({ cookie: true, origin: 'https://evil.example' }));
  });
  it('allows a cookie-authed POST from the allowlisted SPA origin', async () => {
    expectPassed(await run({ cookie: true, origin: 'https://app.openwop.dev' }));
  });
  it('allows a cookie-authed POST with NO origin (same-origin / native client)', async () => {
    expectPassed(await run({ cookie: true }));
  });
  it('allows a bearer/no-cookie POST from any origin (not CSRF-able)', async () => {
    expectPassed(await run({ cookie: false, origin: 'https://evil.example' }));
  });
  it('EXEMPTS a public embed POST even with a stray cookie + foreign origin', async () => {
    expectPassed(await run({ path: '/host/openwop-app/public/widget/message', cookie: true, origin: 'https://customer.example' }));
  });
  it('BLOCKS via the Referer origin when Origin is absent', async () => {
    expectBlocked(await run({ cookie: true, referer: 'https://evil.example/page' }));
  });
  it('allows via an allowlisted Referer origin when Origin is absent', async () => {
    expectPassed(await run({ cookie: true, referer: 'https://app.openwop.dev/x' }));
  });
});

describe('csrfOriginGuard — no allowlist + same-site (Lax) cookie is a no-op', () => {
  beforeEach(() => { delete process.env.OPENWOP_CORS_ORIGINS; });
  it('allows any origin in dev', async () => {
    expectPassed(await run({ cookie: true, origin: 'https://anything.example' }));
  });
});
