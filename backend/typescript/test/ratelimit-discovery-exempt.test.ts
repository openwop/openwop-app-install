import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from '../src/index.js';
import { _resetRateLimitState } from '../src/middleware/rateLimit.js';

/**
 * `/.well-known/openwop` is exempt from the per-IP BURST budget.
 *
 * WHY, and it is a measurement rather than a preference. Certifying this host
 * from one IP produced a bundle with 38 `blocked` rows; grouping them by their
 * own `detail` field showed **30 were "discovery unreachable"** — the suite
 * fetches discovery once per scenario and the 60/min per-IP read budget
 * throttled it. Those rows read as conformance gaps and were not: `blocked`
 * denies certification, so a throttled certifier is indistinguishable from a
 * non-conformant host.
 *
 * The document is public, side-effect-free and cacheable. Charging it against a
 * budget whose purpose is to blunt expensive/write-ish bursts protects nothing
 * and costs the one read every consumer must make first. Same reasoning as the
 * existing `isLongLivedSseStream` exemption directly above it.
 *
 * WHAT THIS MUST NOT DO is the other half, and it is why the third leg exists:
 * the exemption is scoped to GET/HEAD on that exact path. It must not become a
 * way to spend an unlimited budget on anything else.
 */
let server: Server;
let base: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // A deliberately tiny burst budget: the default 60 would need 60+ requests to
  // demonstrate anything, and a test that needs a big burst to prove a small
  // rule is a slow test that proves it weakly.
  process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = '5';
  process.env.OPENWOP_RATELIMIT_IP_READ_REQS_PER_MIN = '5'; // ADR 0640: the legs burst reads
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN;
  delete process.env.OPENWOP_RATELIMIT_IP_READ_REQS_PER_MIN;
  delete process.env.OPENWOP_FORCE_RATE_LIMIT;
});

/**
 * Every request carries `X-Forwarded-For`, and that is load-bearing rather than
 * decoration. `ipRateLimitMiddleware` exempts genuine loopback self-traffic
 * (`isLoopbackSelf`), keyed on the SOCKET address WITH NO XFF — so a test that
 * omits it connects from 127.0.0.1, takes the exemption, and measures nothing.
 *
 * That is not hypothetical: the first draft of this file omitted it, and BOTH
 * the exemption leg and its control passed — the control existing is the only
 * reason the vacuity was visible at all. Behind Cloud Run every real request
 * carries XFF, so this is also the production shape.
 *
 * 203.0.113.x is RFC 5737 TEST-NET-3: documentation-only, never routable.
 */
const CLIENT = { 'X-Forwarded-For': '203.0.113.7' };

async function burst(path: string, n: number, init?: RequestInit): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < n; i++) {
    const headers = { ...CLIENT, ...((init?.headers as Record<string, string>) ?? {}) };
    codes.push((await fetch(`${base}${path}`, { ...init, headers })).status);
  }
  return codes;
}

describe('per-IP burst budget', () => {
  it('does NOT throttle /.well-known/openwop — 4x the budget still answers', async () => {
    const codes = await burst('/.well-known/openwop', 20);
    expect(
      codes.filter((c) => c === 429).length,
      `discovery was throttled ${codes.filter((c) => c === 429).length}/20 times at a budget of 5. This is the defect that `
        + 'produced 30 "discovery unreachable" blocked rows in a real certification bundle, where they read as conformance gaps.',
    ).toBe(0);
    expect(codes.every((c) => c === 200), `unexpected statuses: ${[...new Set(codes)].join(',')}`).toBe(true);
  });

  it('STILL throttles an ordinary read — the budget is not disabled', async () => {
    // Non-vacuity. Without this leg, deleting the limiter entirely would pass
    // the leg above, and the exemption would be indistinguishable from an outage
    // of the whole protection.
    // AUTHENTICATED, and that is the point: `ipRateLimitMiddleware` is mounted at
    // `index.ts:743`, after auth, so an unauthenticated request is refused before
    // it ever reaches the bucket. A control leg that sent no credentials would
    // measure the 401 path and report "not enforced" for a limiter that is working
    // perfectly — which is exactly what the first draft of this leg did.
    const codes = await burst('/v1/workflows', 20, { headers: { Authorization: 'Bearer dev-token' } });
    expect(
      codes.some((c) => c === 429),
      'no request was throttled at a budget of 5 — the per-IP burst budget is not being enforced at all',
    ).toBe(true);
  });

  it('is SUSPENDED under OPENWOP_FORCE_RATE_LIMIT — the conformance scenario that induces a 429 bursts THIS path (ADR 0640)', async () => {
    // `rate-limit-envelope.test.ts` in the suite sends GET /.well-known/openwop
    // up to 200 times under FORCE and asserts the envelope shape ON the 429 it
    // observes. With the exemption honoured under FORCE it observes none and
    // skips every assertion — a gate that cannot fail. Measured after #3679.
    process.env.OPENWOP_FORCE_RATE_LIMIT = 'true';
    _resetRateLimitState();
    try {
      const codes = await burst('/.well-known/openwop', 6);
      expect(codes.some((c) => c === 429), 'FORCE must be able to induce a 429 on the discovery path').toBe(true);
    } finally {
      delete process.env.OPENWOP_FORCE_RATE_LIMIT;
      _resetRateLimitState();
    }
  });

  it('does NOT exempt a non-GET to the same path — the gate is method-scoped', async () => {
    // The dangerous direction: an exemption keyed on path alone would let a
    // caller spend an unbounded budget by POSTing to the discovery URL.
    // MUST assert 429 SPECIFICALLY. The first version of this leg accepted
    // `429 || 404 || 405` and was VACUOUS: no POST route is registered on that
    // path, so every POST 404s whether the gate exists or not — removing the
    // method gate left this leg green. The discriminating property is that a POST
    // is CHARGED to the bucket: with the gate it exhausts the budget and starts
    // returning 429; without it, it is exempt and 404s forever.
    const codes = await burst('/.well-known/openwop', 20, { method: 'POST' });
    expect(
      codes.filter((c) => c === 429).length,
      `POSTs to the discovery path returned ${[...new Set(codes)].join(',')} and were never throttled — they are taking the `
        + 'GET exemption, which is an unbounded budget for anyone who changes the verb',
    ).toBeGreaterThan(0);
  });
});
