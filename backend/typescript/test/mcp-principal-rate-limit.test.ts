/**
 * MCP-1 (ADR 0087 OQ-2) — per-principal budget for inbound MCP `tools/call`,
 * layered on the per-IP floor. Hammering past the per-minute budget for one
 * principal is rejected with a canonical 429; a different principal has its own
 * budget; reads aren't routed here (the route only calls this for `tools/call`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enforceMcpPrincipalRateLimit, _resetRateLimitState } from '../src/middleware/rateLimit.js';

/** Minimal Express Response capturing the rate-limit envelope. */
function mockRes() {
  const r: { statusCode?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  return {
    res: {
      set: (k: string, v: string) => { r.headers[k] = v; },
      status: (c: number) => { r.statusCode = c; return { json: (b: unknown) => { r.body = b; } }; },
    } as unknown as import('express').Response,
    captured: r,
  };
}

describe('enforceMcpPrincipalRateLimit (MCP-1)', () => {
  beforeEach(() => { _resetRateLimitState(); process.env.OPENWOP_MCP_PRINCIPAL_REQS_PER_MIN = '3'; });
  afterEach(() => { delete process.env.OPENWOP_MCP_PRINCIPAL_REQS_PER_MIN; _resetRateLimitState(); });

  it('admits calls up to the budget, then rejects with a canonical 429', () => {
    const { res, captured } = mockRes();
    // 3 allowed
    expect(enforceMcpPrincipalRateLimit(res, 'user:a')).toBe(false);
    expect(enforceMcpPrincipalRateLimit(res, 'user:a')).toBe(false);
    expect(enforceMcpPrincipalRateLimit(res, 'user:a')).toBe(false);
    // 4th over budget
    expect(enforceMcpPrincipalRateLimit(res, 'user:a')).toBe(true);
    expect(captured.statusCode).toBe(429);
    const body = captured.body as { error: string; details: { scope: string; reason: string; retryAfterMs: number } };
    expect(body.error).toBe('rate_limited');
    expect(body.details.scope).toBe('tenant');
    expect(body.details.reason).toBe('mcp_principal_rate');
    expect(body.details.retryAfterMs).toBeGreaterThanOrEqual(1000);
    expect(captured.headers['Retry-After']).toBeTruthy();
  });

  it('budgets each principal independently', () => {
    const { res } = mockRes();
    for (let i = 0; i < 3; i++) expect(enforceMcpPrincipalRateLimit(res, 'user:a')).toBe(false);
    expect(enforceMcpPrincipalRateLimit(res, 'user:a')).toBe(true); // a exhausted
    // b is fresh
    expect(enforceMcpPrincipalRateLimit(res, 'user:b')).toBe(false);
  });

  it('is disabled when OPENWOP_RATELIMIT_DISABLED=true', () => {
    process.env.OPENWOP_RATELIMIT_DISABLED = 'true';
    const { res } = mockRes();
    for (let i = 0; i < 10; i++) expect(enforceMcpPrincipalRateLimit(res, 'user:a')).toBe(false);
    delete process.env.OPENWOP_RATELIMIT_DISABLED;
  });

  it('a budget of 0 disables the limiter (unbounded)', () => {
    process.env.OPENWOP_MCP_PRINCIPAL_REQS_PER_MIN = '0';
    const { res } = mockRes();
    for (let i = 0; i < 10; i++) expect(enforceMcpPrincipalRateLimit(res, 'user:a')).toBe(false);
  });
});
