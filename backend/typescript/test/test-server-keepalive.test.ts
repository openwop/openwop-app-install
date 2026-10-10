/**
 * Witness for `test/setup/testServerKeepAlive.ts`: a test server must survive a
 * synchronous stretch longer than Node's default 5s keep-alive.
 *
 * The block is real (the event loop is held for 6.5s) because nothing shorter
 * can tell the patched server from the default one. With the setup entry's
 * assignment removed, BOTH legs fail — the POST with `fetch failed` (ECONNRESET)
 * — measured.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { TEST_SERVER_KEEP_ALIVE_MS } from './setup/testServerKeepAlive.js';

let server: http.Server;
let BASE: string;

beforeAll(async () => {
  const app = express();
  app.all('/ping', (_req, res) => { res.status(201).json({ ok: true }); });
  // The same spelling the suite's test files use.
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function blockEventLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

describe('test servers outlive a synchronous stretch (keep-alive class)', () => {
  it('a server booted with app.listen carries the lifted keep-alive', () => {
    expect(server.keepAliveTimeout).toBe(TEST_SERVER_KEEP_ALIVE_MS);
  });

  it('a POST on the pooled socket succeeds after the loop was blocked past the default keep-alive', async () => {
    // The body is READ: an unconsumed response never returns its socket to the
    // pool, the next request opens a fresh one, and the witness passes vacuously.
    const post = async () => {
      const r = await fetch(`${BASE}/ping`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await r.text();
      return r;
    };
    expect((await post()).status).toBe(201); // opens + pools the socket
    // 6.5s, not 5.5s: this Node adds ~1s of grace to the 5s default, so a 5.5s
    // block passes on the unpatched server too (measured: 5.5s → 201, 6s → ECONNRESET).
    blockEventLoop(6_500);
    // One loop turn, as at any test boundary: the server's keep-alive timer gets
    // to fire before the client reuses the socket. Without this turn the request
    // is written first and the default server passes too — a block followed
    // directly by a request does NOT reproduce the defect (measured).
    await new Promise<void>((r) => setImmediate(r));
    const again = await post();
    expect(again.status).toBe(201);
  }, 20_000);

  it('close() still finishes promptly when a request was in flight at the call', async () => {
    const slow = express();
    slow.get('/slow', (_req, res) => { setTimeout(() => res.json({ ok: true }), 300); });
    const s = await new Promise<http.Server>((r) => { const x = slow.listen(0, '127.0.0.1', () => r(x)); });
    const inFlight = fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/slow`).then((r) => r.text());
    await new Promise<void>((r) => setTimeout(r, 100)); // the request is on the server
    const started = Date.now();
    const closed = new Promise<void>((r) => s.close(() => r()));
    expect(await inFlight).toBe('{"ok":true}'); // not cut off
    await closed;
    // Without the reaper this waits for the 5s fallback (measured: the test reds).
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 20_000);
});
