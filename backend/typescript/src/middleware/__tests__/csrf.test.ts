/**
 * CSRF Origin guard (2026-07 vuln-scan M4). Guards cookie-authed unsafe methods
 * against the CORS origin allowlist so a cross-site form POST to a cookie-authed
 * mutation (forced logout) is blocked, WITHOUT breaking the SPA (allowlisted
 * origin), bearer/webhook callers (no cookie), or the cross-origin-by-design
 * public embed surfaces (exempt).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import { csrfOriginGuard } from '../csrf.js';
import { COOKIE_NAME } from '../cookieSession.js';
import { OpenwopError } from '../../types.js';

const guard = csrfOriginGuard();

function run(opts: { method?: string; path?: string; cookie?: boolean; origin?: string; referer?: string }): OpenwopError | undefined | 'next' {
  const headers: Record<string, string | undefined> = {
    cookie: opts.cookie ? `${COOKIE_NAME}=abc.def` : undefined,
    origin: opts.origin,
    referer: opts.referer,
  };
  const req = {
    method: opts.method ?? 'POST',
    path: opts.path ?? '/v1/host/openwop-app/users/auth/logout',
    header: (n: string) => headers[n.toLowerCase()],
  } as unknown as Request;
  let captured: OpenwopError | undefined | 'next' = undefined;
  guard(req, {} as never, (err?: unknown) => { captured = err ? (err as OpenwopError) : 'next'; });
  return captured;
}

const prev = process.env.OPENWOP_CORS_ORIGINS;
afterEach(() => { if (prev === undefined) delete process.env.OPENWOP_CORS_ORIGINS; else process.env.OPENWOP_CORS_ORIGINS = prev; });

describe('csrfOriginGuard — with an explicit allowlist (prod posture)', () => {
  beforeEach(() => { process.env.OPENWOP_CORS_ORIGINS = 'https://app.openwop.dev'; });

  it('allows a GET (safe method)', () => {
    expect(run({ method: 'GET', cookie: true, origin: 'https://evil.example' })).toBe('next');
  });
  it('BLOCKS a cookie-authed POST from an attacker origin', () => {
    const r = run({ cookie: true, origin: 'https://evil.example' });
    expect(r).toBeInstanceOf(OpenwopError);
    expect((r as OpenwopError).httpStatus).toBe(403);
  });
  it('allows a cookie-authed POST from the allowlisted SPA origin', () => {
    expect(run({ cookie: true, origin: 'https://app.openwop.dev' })).toBe('next');
  });
  it('allows a cookie-authed POST with NO origin (same-origin / native client)', () => {
    expect(run({ cookie: true })).toBe('next');
  });
  it('allows a bearer/no-cookie POST from any origin (not CSRF-able)', () => {
    expect(run({ cookie: false, origin: 'https://evil.example' })).toBe('next');
  });
  it('EXEMPTS a public embed POST even with a stray cookie + foreign origin', () => {
    expect(run({ path: '/v1/host/openwop-app/public/widget/message', cookie: true, origin: 'https://customer.example' })).toBe('next');
  });
  it('falls back to the Referer origin when Origin is absent', () => {
    expect(run({ cookie: true, referer: 'https://evil.example/page' })).toBeInstanceOf(OpenwopError);
    expect(run({ cookie: true, referer: 'https://app.openwop.dev/x' })).toBe('next');
  });
});

describe('csrfOriginGuard — no allowlist (dev reflect-any) is a no-op', () => {
  beforeEach(() => { delete process.env.OPENWOP_CORS_ORIGINS; });
  it('allows any origin in dev', () => {
    expect(run({ cookie: true, origin: 'https://anything.example' })).toBe('next');
  });
});
