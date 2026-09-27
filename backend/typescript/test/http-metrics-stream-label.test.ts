/**
 * ADR 0556 P2 — the `stream` label on `openwop.http.server.duration`.
 *
 * This exists because a weaker assertion let a real sabotage through. The
 * route-level test asserted only that every HTTP sample carried
 * `stream === 'true' | 'false'` — which stays green when the middleware
 * hardcodes `false`, i.e. when the label is present, well-formed, and always
 * wrong. The latency objectives would then silently include EventStream
 * connections whose "duration" is a browser tab's lifetime, and A2/A3 would
 * breach permanently on a perfectly healthy host.
 *
 * So this asserts the label actually TRACKS the request, in both directions,
 * and at the seam that decides it.
 *
 * The pair that matters most is the last one: `/v1/runs/:runId/events` serves
 * BOTH an SSE stream and a JSON polling mode on the same path, separated only
 * by `Accept`. A route-template filter — the design this phase started with —
 * cannot tell them apart and would have dropped the JSON polling requests, real
 * short latency-bearing traffic, out of the picture along with the streams.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { httpMetricsMiddleware } from '../src/middleware/httpMetrics.js';
import { isLongLivedSseStream } from '../src/middleware/rateLimit.js';
import { _resetMetricsForTest, emissionsOf } from '../src/observability/metrics.js';

/** A request shaped enough for the middleware and the SSE predicate. */
function fakeReq(over: { method?: string; path?: string; accept?: string; route?: string }): Request {
  const accept = over.accept ?? 'application/json';
  return {
    method: over.method ?? 'GET',
    path: over.path ?? '/v1/workflows',
    baseUrl: '',
    route: { path: over.route ?? over.path ?? '/v1/workflows' },
    header: (name: string) => (name.toLowerCase() === 'accept' ? accept : undefined),
  } as unknown as Request;
}

/** A response that can be `finish`ed, which is when the middleware records. */
function fakeRes(status = 200): Response & EventEmitter {
  const res = new EventEmitter() as Response & EventEmitter;
  (res as unknown as { statusCode: number }).statusCode = status;
  return res;
}

function recordThrough(req: Request, status = 200): Record<string, unknown> {
  const res = fakeRes(status);
  httpMetricsMiddleware()(req, res, () => {});
  res.emit('finish');
  const emitted = emissionsOf('openwop.http.server.duration');
  expect(emitted.length, 'the middleware recorded nothing').toBe(1);
  return emitted[0]!.attributes as Record<string, unknown>;
}

beforeEach(() => _resetMetricsForTest());

describe('ADR 0556 P2 — the stream label tracks the REQUEST, not the route', () => {
  it('marks a real EventStream connection `stream: true`', () => {
    const attrs = recordThrough(fakeReq({
      path: '/v1/runs/019abc/events',
      route: '/v1/runs/:runId/events',
      accept: 'text/event-stream',
    }));
    expect(attrs.stream).toBe(true);
    // And the route is still the TEMPLATE — one series for every run there will
    // ever be, which is the P0 rule this label rides alongside.
    expect(attrs.route).toBe('/v1/runs/:runId/events');
  });

  it('marks an ordinary request `stream: false`', () => {
    expect(recordThrough(fakeReq({ path: '/v1/workflows' })).stream).toBe(false);
  });

  it('distinguishes the JSON POLLING mode of the SAME path from its SSE mode', () => {
    // THE case a route-template filter gets wrong. Same method, same path, same
    // template — only `Accept` differs, and one of them is a 30 ms request
    // while the other is a session that can last for hours.
    const sse = recordThrough(fakeReq({
      path: '/v1/runs/019abc/events', route: '/v1/runs/:runId/events', accept: 'text/event-stream',
    }));
    _resetMetricsForTest();
    const polling = recordThrough(fakeReq({
      path: '/v1/runs/019abc/events', route: '/v1/runs/:runId/events', accept: 'application/json',
    }));
    expect(sse.stream).toBe(true);
    expect(polling.stream).toBe(false);
    expect(sse.route).toBe(polling.route);
  });

  it('does not mark a POST to a stream path as a stream', () => {
    // The predicate is (GET) ∧ (known stream path) ∧ (Accept: text/event-stream),
    // so a caller cannot get themselves excluded from the latency objective by
    // sending the header on a write.
    expect(recordThrough(fakeReq({
      method: 'POST', path: '/v1/runs/019abc/events', route: '/v1/runs/:runId/events',
      accept: 'text/event-stream',
    })).stream).toBe(false);
  });

  it('uses the rate limiter\'s predicate, so a new stream route needs no second edit', () => {
    // One list, one answer. Asserted against the predicate directly for every
    // stream family the limiter knows about, so a route joining SSE_STREAM_PATHS
    // is excluded from the SLO the moment it is exempted from the rate budget.
    for (const path of [
      '/v1/host/openwop-app/notifications/stream',
      '/v1/host/openwop-app/kanban/boards/b1/events',
      '/v1/runs/r1/events',
      '/v1/host/openwop-app/channels/c1/stream',
      '/v1/host/openwop-app/channels/c1/presence',
      '/v1/host/openwop-app/voice/realtime/messages/stream',
      '/v1/host/openwop-app/present/p1/events',
    ]) {
      expect(isLongLivedSseStream(fakeReq({ path, accept: 'text/event-stream' })), path).toBe(true);
    }
    // ...and a public write surface is NOT one, however it is labelled.
    expect(isLongLivedSseStream(fakeReq({
      path: '/v1/host/openwop-app/public-forms/f1/submit', accept: 'text/event-stream',
    }))).toBe(false);
  });
});
