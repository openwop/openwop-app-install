/**
 * host/sseChannel — REAL-socket lifecycle. The unit suite (sse-channel.test.ts)
 * drives teardown through a mock `req._close()`, which ASSUMES `req.on('close')`
 * fires when a client disconnects mid-stream. Node ≥16 changed IncomingMessage
 * 'close' semantics (message completion, not socket close), so that assumption
 * needed a real-socket witness: during the 2026-07-14 stream-cap incident the
 * per-tenant counter read at-cap with ~zero ACTIVE connections, and a broken
 * decrement was the leading theory until this test exonerated it (the counter
 * was honest — the streams were real but idle; the true cause was client-side
 * orphaned subscriptions re-opening hourly, fixed in #1823). This test pins
 * release-on-abort over a real http server + real client sockets so a future
 * Node/Express bump that breaks teardown delivery fails CI instead of leaking
 * slots in production.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Request } from 'express';
import { openSseChannel, _resetSseStreamCounts } from '../src/host/sseChannel.js';

let server: http.Server;
let base: string;

beforeEach(async () => {
  _resetSseStreamCounts();
  process.env.OPENWOP_SSE_MAX_STREAMS_PER_TENANT = '2';
  const app = express();
  app.get('/stream', (req, res, next) => {
    try {
      // Pin every request to ONE cap key regardless of source port.
      (req as Request & { tenantId?: string }).tenantId = 'tenant-real';
      openSseChannel(req, res, { heartbeatMs: 50 });
    } catch (err) { next(err); }
  });
  // Mirror the app's error middleware: OpenwopError.httpStatus → wire status.
  app.use((err: { httpStatus?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.httpStatus ?? 500).json({ error: true });
  });
  server = http.createServer(app);
  await new Promise<void>((res) => {
    server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterEach(async () => {
  delete process.env.OPENWOP_SSE_MAX_STREAMS_PER_TENANT;
  _resetSseStreamCounts();
  await new Promise<void>((res) => server.close(() => res()));
});

/** Open a live SSE connection; resolve once the first bytes arrive. */
function openStream(): Promise<{ res: http.IncomingMessage; abort: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/stream`, { headers: { accept: 'text/event-stream' } }, (res) => {
      res.once('data', () => resolve({ res, abort: () => req.destroy() }));
      res.on('error', () => undefined);
    });
    req.on('error', (e) => reject(e));
  });
}

/** One-shot status probe (does NOT hold a slot on 429; holds one on 200). */
function probeStatus(): Promise<{ status: number; abort: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/stream`, { headers: { accept: 'text/event-stream' } }, (res) => {
      res.on('data', () => undefined);
      res.on('error', () => undefined);
      resolve({ status: res.statusCode ?? 0, abort: () => req.destroy() });
    });
    req.on('error', (e) => reject(e));
  });
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('sseChannel over real sockets', () => {
  it('client disconnect RELEASES the cap slot (the production leak)', async () => {
    const a = await openStream();
    const b = await openStream();
    expect((await probeStatus()).status).toBe(429); // at cap — sanity

    a.abort();
    b.abort();
    // Give the server a heartbeat interval + a tick to observe the socket
    // close and run teardown. If req.on('close') never fires for a completed
    // bodyless GET, the slots stay consumed and the probe below 429s forever.
    await settle(300);

    const after = await probeStatus();
    expect(after.status).toBe(200); // slot released → a new stream fits
    after.abort();
  });
});
