/**
 * Coverage for the P0.4 rate-limit middleware:
 *   - Per-IP request bucket returns 429 once the threshold is hit.
 *   - Run-quota middleware enforces per-session minute window.
 *   - 429 carries the canonical {error, message, details, Retry-After}
 *     envelope.
 *   - OPENWOP_RATELIMIT_DISABLED=true bypasses all checks.
 */

import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { ipRateLimitMiddleware, runQuotaMiddleware, reserveConcurrentSlot, _resetRateLimitState , snapshotRateLimits } from '../src/middleware/rateLimit.js';
import { notifyRunTerminal, _resetRunLifecycle } from '../src/executor/runLifecycle.js';

let server: http.Server;
let port: number;

async function startApp(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  // Synthetic session header for tests (real app derives from cookie).
  app.use((req, _res, next) => {
    const t = req.header('x-test-tenant');
    if (t) req.tenantId = t;
    next();
  });
  app.use(ipRateLimitMiddleware());
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  app.post('/v1/runs', runQuotaMiddleware(), (_req, res) => res.status(201).json({ ok: true }));
  // A route that RESERVES, mirroring what `routes/runs.ts` does. The previous
  // version of this file said "Need a test route that actually calls
  // reserveConcurrentSlot… (Done via the synthetic app in startApp())" — it was
  // not done, and the concurrent-run quota ended up with no coverage at all.
  let seq = 0;
  app.post('/v1/runs-reserving', runQuotaMiddleware(), (req, res) => {
    const runId = `run-${++seq}`;
    reserveConcurrentSlot(req, runId);
    res.status(201).json({ runId });
  });
  // Long-lived SSE stream routes — exempt from the per-IP burst bucket when
  // requested as text/event-stream (the reconnect-feedback-loop fix). The
  // handlers reply immediately so the test's fetch resolves.
  app.get('/v1/host/openwop-app/notifications/stream', (_req, res) => res.json({ ok: true }));
  app.get('/v1/runs/:runId/events', (_req, res) => res.json({ ok: true }));
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

let closeFn: () => Promise<void>;

describe('P0.4 rate limit', () => {
  beforeEach(async () => {
    _resetRateLimitState();
    process.env.OPENWOP_RATELIMIT_DISABLED = '';
    process.env.OPENWOP_FORCE_RATE_LIMIT = '';
    // These tests drive the limiter over loopback, so opt out of the bridge
    // loopback-self exemption (otherwise every test request would be exempt).
    process.env.OPENWOP_RATELIMIT_TRUST_LOOPBACK = 'false';
    process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = '5';
    // ADR 0640 — reads have their own tier (default 600, floored at the write
    // budget); the legs below burst GET /ping, so pin the read tier too.
    process.env.OPENWOP_RATELIMIT_IP_READ_REQS_PER_MIN = '5';
    process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_MIN = '3';
    process.env.OPENWOP_RATELIMIT_SESSION_RUNS_PER_DAY = '100';
    process.env.OPENWOP_RATELIMIT_SESSION_CONCURRENT = '100';
    process.env.OPENWOP_RATELIMIT_IP_RUNS_PER_DAY = '100';
    if (server) await new Promise<void>((r) => server.close(() => r()));
    const started = await startApp();
    closeFn = started.close;
  });

  afterAll(async () => {
    if (closeFn) await closeFn();
  });

  it('per-IP request limit returns 429 with retry-after', async () => {
    // 5 reqs/min: first 5 succeed, 6th rejects.
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/ping`);
      expect(r.status).toBe(200);
    }
    const r = await fetch(`http://127.0.0.1:${port}/ping`);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
    const body = (await r.json()) as { error: string; details: { scope: string; reason: string } };
    expect(body.error).toBe('rate_limited');
    // Canonical closed enum per rest-endpoints.md §429 (per-IP bucket → "key").
    expect(body.details.scope).toBe('key');
    // Host detail: which limiter fired — a GET burst lands in the READ tier (ADR 0640).
    expect(body.details.reason).toBe('ip_read_rate');
  });

  it('ADR 0640: reads and writes are SEPARATE per-IP buckets — a read flood cannot starve writes, and vice versa', async () => {
    process.env.OPENWOP_RATELIMIT_IP_READ_REQS_PER_MIN = '5';
    process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = '2';
    _resetRateLimitState();
    // Exhaust the write bucket first: the middleware runs before routing, so a
    // POST to a path with no handler still spends write budget (404, then 429).
    const w1 = await fetch(`http://127.0.0.1:${port}/ping`, { method: 'POST' });
    const w2 = await fetch(`http://127.0.0.1:${port}/ping`, { method: 'POST' });
    expect([w1.status, w2.status].every((s) => s !== 429)).toBe(true);
    const w3 = await fetch(`http://127.0.0.1:${port}/ping`, { method: 'POST' });
    expect(w3.status).toBe(429);
    expect(((await w3.json()) as { details: { reason: string } }).details.reason).toBe('ip_request_rate');
    // Reads are untouched by the exhausted write bucket…
    for (let i = 0; i < 5; i++) expect((await fetch(`http://127.0.0.1:${port}/ping`)).status).toBe(200);
    // …until their OWN budget runs out, with their own reason.
    const r6 = await fetch(`http://127.0.0.1:${port}/ping`);
    expect(r6.status).toBe(429);
    expect(((await r6.json()) as { details: { reason: string; scope: string } }).details).toMatchObject({ reason: 'ip_read_rate', scope: 'key' });
  });

  it('ADR 0640: the read tier is FLOORED at the write budget — raising the old single knob never lowers reads', () => {
    process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = '900';
    delete process.env.OPENWOP_RATELIMIT_IP_READ_REQS_PER_MIN;
    expect(snapshotRateLimits().ipReadReqsPerMin, 'default 600 must rise to the 900 write budget').toBe(900);
    process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = '60';
    process.env.OPENWOP_RATELIMIT_IP_READ_REQS_PER_MIN = '10';
    expect(snapshotRateLimits().ipReadReqsPerMin, 'an explicit read budget below the write budget is raised to it').toBe(60);
    delete process.env.OPENWOP_RATELIMIT_IP_READ_REQS_PER_MIN;
    expect(snapshotRateLimits().ipReadReqsPerMin).toBe(600);
  });

  it('OPENWOP_FORCE_RATE_LIMIT forces a deterministic 429 regardless of the configured IP budget (CF-6)', async () => {
    // Even with a generous configured budget, the conformance affordance forces a
    // tiny (3/min) per-IP budget so the harness can induce a canonical 429 without
    // load timing. The envelope MUST be identical to a production rate-limit.
    process.env.OPENWOP_FORCE_RATE_LIMIT = 'true';
    process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = '1000';
    process.env.OPENWOP_RATELIMIT_IP_READ_REQS_PER_MIN = '1000'; // FORCE overrides BOTH tiers (ADR 0640)
    _resetRateLimitState();
    let last: Response | undefined;
    for (let i = 0; i < 5; i++) {
      last = await fetch(`http://127.0.0.1:${port}/ping`);
      if (last.status === 429) break;
    }
    expect(last!.status).toBe(429);
    const body = (await last!.json()) as { error: string; details: { scope: string; reason: string } };
    expect(body.error).toBe('rate_limited');
    expect(body.details.scope).toBe('key');
  });

  it('per-session run quota: 3 runs/min then 429', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-tenant': 'anon:alice' },
        body: '{}',
      });
      expect(r.status).toBe(201);
    }
    const blocked = await fetch(`http://127.0.0.1:${port}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-tenant': 'anon:alice' },
      body: '{}',
    });
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { details: { scope: string; reason: string } };
    // Per-session/tenant bucket → canonical "tenant"; reason carries the detail.
    expect(body.details.scope).toBe('tenant');
    expect(body.details.reason).toBe('session_runs_per_min');
  });

  it('per-session quota is isolated between sessions', async () => {
    for (let i = 0; i < 3; i++) {
      await fetch(`http://127.0.0.1:${port}/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-tenant': 'anon:alice' },
        body: '{}',
      });
    }
    // Alice exhausted; Bob still has full quota.
    const bob = await fetch(`http://127.0.0.1:${port}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-tenant': 'anon:bob' },
      body: '{}',
    });
    expect(bob.status).toBe(201);
  });

  /**
   * §Correction — the per-session concurrent-run quota had NO coverage.
   *
   * Two verbatim-duplicated blocks asserted `expect(true).toBe(true)` and
   * deferred to "the full integration test [that] lives in
   * test/auth-cookies.test.ts". That claim was FALSE: `grep -c concurrent`
   * over that file returns 0, and `reserveConcurrentSlot` appears in no test
   * but this one. A release-path leak would have wedged a user at permanent
   * 429 with nothing red.
   *
   * These drive the REAL chain — middleware stamps `_sessionKey`, the route
   * reserves under it, the next request hits the middleware's pre-flight, and
   * `notifyRunTerminal` frees the slot.
   */
  it('a session at its concurrent cap is refused, and freeing a slot admits the next run', async () => {
    process.env.OPENWOP_RATELIMIT_SESSION_CONCURRENT = '1';
    _resetRateLimitState();
    _resetRunLifecycle();

    const reserve = (): Promise<Response> => fetch(`http://127.0.0.1:${port}/v1/runs-reserving`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-tenant': 'anon:conc' },
      body: '{}',
    });

    const first = await reserve();
    expect(first.status, 'the first run is under the cap').toBe(201);
    const { runId } = (await first.json()) as { runId: string };

    // Cap is 1 and one run is inflight ⇒ the pre-flight must refuse.
    const second = await reserve();
    expect(second.status, 'a session at its cap must be refused').toBe(429);
    // Assert the SPECIFIC limiter, not just "a 429" — a burst or per-minute
    // refusal would otherwise satisfy this test and the concurrent quota could
    // still be broken.
    const body = (await second.json()) as { error?: string; details?: { reason?: string } };
    expect(body.error).toBe('rate_limited');
    expect(body.details?.reason, 'the CONCURRENT limiter must be the one that fired').toBe('session_concurrent');

    // The release path — the half a leak would break, and the half that had
    // no assertion at all before.
    notifyRunTerminal(runId, 'completed');
    const third = await reserve();
    expect(third.status, 'freeing a slot must admit the next run — a leak wedges the session at 429').toBe(201);
  });

  it('one session reaching its cap does not refuse a different session', async () => {
    process.env.OPENWOP_RATELIMIT_SESSION_CONCURRENT = '1';
    _resetRateLimitState();
    _resetRunLifecycle();

    const reserveAs = (tenant: string): Promise<Response> => fetch(`http://127.0.0.1:${port}/v1/runs-reserving`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-tenant': tenant },
      body: '{}',
    });

    expect((await reserveAs('anon:alice')).status).toBe(201);
    expect((await reserveAs('anon:alice')).status, 'alice is now at her cap').toBe(429);
    // The quota is per session, so bob is unaffected — a shared-key bug would
    // show up here and nowhere else.
    expect((await reserveAs('anon:bob')).status, 'bob has his own quota').toBe(201);
  });


  it('long-lived SSE streams are exempt from the per-IP burst bucket (reconnect feedback-loop fix)', async () => {
    const sse = { Accept: 'text/event-stream' };
    // Limit is 5/min, but a session-long EventStream is one connection, not a
    // burst. Far past the budget, every SSE (re)connect to a known stream path
    // stays 200 — so a throttled tab's reconnects can't keep it throttled.
    for (let i = 0; i < 12; i++) {
      const a = await fetch(`http://127.0.0.1:${port}/v1/host/openwop-app/notifications/stream`, { headers: sse });
      expect(a.status).toBe(200);
      const b = await fetch(`http://127.0.0.1:${port}/v1/runs/run-xyz/events`, { headers: sse });
      expect(b.status).toBe(200);
    }
  });

  it('CS-CH-1 — channel stream/presence + voice transcript SSE are exempt too (the reconnect-storm class)', async () => {
    const sse = { Accept: 'text/event-stream' };
    for (let i = 0; i < 12; i++) {
      const stream = await fetch(`http://127.0.0.1:${port}/v1/host/openwop-app/channels/chan-1/stream`, { headers: sse });
      expect(stream.status).not.toBe(429);
      const presence = await fetch(`http://127.0.0.1:${port}/v1/host/openwop-app/channels/chan-1/presence`, { headers: sse });
      expect(presence.status).not.toBe(429);
      const voice = await fetch(`http://127.0.0.1:${port}/v1/host/openwop-app/voice/realtime/messages/stream?conversationId=c1`, { headers: sse });
      expect(voice.status).not.toBe(429);
    }
    // Without the Accept header the same channel path still counts (no free polling).
    _resetRateLimitState();
    let blocked = false;
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/v1/host/openwop-app/channels/chan-1/stream`, { headers: { Accept: 'application/json' } });
      if (r.status === 429) { blocked = true; break; }
    }
    expect(blocked).toBe(true);
  });

  it('the SSE exemption is gated on BOTH a known stream path AND the Accept header (no header-only bypass)', async () => {
    // Same Accept header on a NON-stream path → still counted (5/min → 429).
    let blockedOnPing = false;
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/ping`, { headers: { Accept: 'text/event-stream' } });
      if (r.status === 429) { blockedOnPing = true; break; }
    }
    expect(blockedOnPing).toBe(true);

    // The run-events path WITHOUT the SSE Accept header (its JSON polling mode)
    // is NOT exempt — it stays inside the budget.
    _resetRateLimitState();
    let blockedOnJsonPoll = false;
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/v1/runs/run-xyz/events`, { headers: { Accept: 'application/json' } });
      if (r.status === 429) { blockedOnJsonPoll = true; break; }
    }
    expect(blockedOnJsonPoll).toBe(true);
  });

  it('OPENWOP_RATELIMIT_DISABLED bypasses all checks', async () => {
    process.env.OPENWOP_RATELIMIT_DISABLED = 'true';
    _resetRateLimitState();
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/ping`);
      expect(r.status).toBe(200);
    }
  });

  it('loopback self-traffic (no XFF) is exempt; a spoofed XFF is NOT', async () => {
    // Enable the loopback-self exemption (limit is 5/min).
    process.env.OPENWOP_RATELIMIT_TRUST_LOOPBACK = '';
    _resetRateLimitState();
    // Direct loopback, no X-Forwarded-For → exempt: well past the limit, all 200.
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/ping`);
      expect(r.status).toBe(200);
    }
    // A spoofed `X-Forwarded-For: 127.0.0.1` must NOT bypass — presence of XFF
    // disqualifies the loopback-self check, so the limiter applies.
    _resetRateLimitState();
    let sawLimit = false;
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/ping`, { headers: { 'x-forwarded-for': '127.0.0.1' } });
      if (r.status === 429) { sawLimit = true; break; }
    }
    expect(sawLimit).toBe(true);
  });
});
