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
 * The pair that matters most is the last one: `/runs/:runId/events` serves
 * BOTH an SSE stream and a JSON polling mode on the same path, separated only
 * by `Accept`. A route-template filter — the design this phase started with —
 * cannot tell them apart and would have dropped the JSON polling requests, real
 * short latency-bearing traffic, out of the picture along with the streams.
 *
 * Real requests through a minimal express app (no `createApp`, no faked
 * request objects): the middleware and the predicate see what production sees.
 *
 * Tracker TST-DFD-5. Red when (w71g1, witnessed): the middleware hardcodes the label;
 * the predicate stops requiring GET or `Accept: text/event-stream`; a stream family
 * leaves `SSE_STREAM_PATHS`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { httpMetricsMiddleware } from '../src/middleware/httpMetrics.js';
import { isLongLivedSseStream } from '../src/middleware/rateLimit.js';
import { _resetMetricsForTest, emissionsOf } from '../src/observability/metrics.js';

let server: http.Server;
let BASE = '';
let predicateServer: http.Server;
let PREDICATE_BASE = '';

const listen = (app: express.Express): Promise<{ s: http.Server; base: string }> => new Promise((res) => {
  const s = app.listen(0, '127.0.0.1', () => res({ s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }));
});

beforeAll(async () => {
  const app = express();
  app.use(httpMetricsMiddleware());
  app.get('/workflows', (_req, res) => { res.json({ ok: true }); });
  app.get('/runs/:runId/events', (_req, res) => { res.json({ ok: true }); });
  app.post('/runs/:runId/events', (_req, res) => { res.json({ ok: true }); });
  ({ s: server, base: BASE } = await listen(app));
  // A second app that answers the predicate on the REAL request, for any path.
  const predicateApp = express();
  predicateApp.use((req, res) => { res.json({ stream: isLongLivedSseStream(req) }); });
  ({ s: predicateServer, base: PREDICATE_BASE } = await listen(predicateApp));
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => predicateServer.close(() => res()));
});
beforeEach(() => _resetMetricsForTest());

/** Send one request and return the single duration sample it produced. */
async function recordThrough(method: string, path: string, accept: string): Promise<Record<string, unknown>> {
  _resetMetricsForTest();
  const res = await fetch(`${BASE}${path}`, { method, headers: { accept } });
  expect(res.status).toBe(200);
  await res.text();
  // `finish` fires on the server side; wait for the sample rather than sleeping.
  await vi.waitFor(() => expect(emissionsOf('openwop.http.server.duration').length, 'the middleware recorded nothing').toBe(1));
  return emissionsOf('openwop.http.server.duration')[0]!.attributes as Record<string, unknown>;
}

describe('ADR 0556 P2 — the stream label tracks the REQUEST, not the route', () => {
  it('marks a real EventStream connection `stream: true`', async () => {
    const attrs = await recordThrough('GET', '/runs/019abc/events', 'text/event-stream');
    expect(attrs.stream).toBe(true);
    // And the route is still the TEMPLATE — one series for every run there will
    // ever be, which is the P0 rule this label rides alongside.
    expect(attrs.route).toBe('/runs/:runId/events');
  });

  it('marks an ordinary request `stream: false`', async () => {
    expect((await recordThrough('GET', '/workflows', 'application/json')).stream).toBe(false);
  });

  it('distinguishes the JSON POLLING mode of the SAME path from its SSE mode', async () => {
    // THE case a route-template filter gets wrong. Same method, same path, same
    // template — only `Accept` differs, and one of them is a 30 ms request
    // while the other is a session that can last for hours.
    const sse = await recordThrough('GET', '/runs/019abc/events', 'text/event-stream');
    const polling = await recordThrough('GET', '/runs/019abc/events', 'application/json');
    expect(sse.stream).toBe(true);
    expect(polling.stream).toBe(false);
    expect(sse.route).toBe(polling.route);
  });

  it('does not mark a POST to a stream path as a stream', async () => {
    // The predicate is (GET) ∧ (known stream path) ∧ (Accept: text/event-stream),
    // so a caller cannot get themselves excluded from the latency objective by
    // sending the header on a write.
    expect((await recordThrough('POST', '/runs/019abc/events', 'text/event-stream')).stream).toBe(false);
  });

  it('uses the rate limiter\'s predicate, so a new stream route needs no second edit', async () => {
    // One list, one answer. Asserted against the predicate directly for every
    // stream family the limiter knows about, so a route joining SSE_STREAM_PATHS
    // is excluded from the SLO the moment it is exempted from the rate budget.
    const ask = async (path: string): Promise<boolean> => {
      const r = await fetch(`${PREDICATE_BASE}${path}`, { headers: { accept: 'text/event-stream' } });
      return ((await r.json()) as { stream: boolean }).stream;
    };
    for (const path of [
      '/host/openwop-app/notifications/stream',
      '/host/openwop-app/kanban/boards/b1/events',
      '/runs/r1/events',
      '/host/openwop-app/channels/c1/stream',
      '/host/openwop-app/channels/c1/presence',
      '/host/openwop-app/voice/realtime/messages/stream',
      '/host/openwop-app/present/p1/events',
    ]) {
      expect(await ask(path), path).toBe(true);
    }
    // ...and a public write surface is NOT one, however it is labelled.
    expect(await ask('/host/openwop-app/public-forms/f1/submit')).toBe(false);
  });
});
