/**
 * Witness for `test/setup/testServerKeepAlive.ts` (the class #4295 named in
 * `creative-briefs-render`): a test server must survive a synchronous stretch
 * longer than Node's default 5s keep-alive.
 *
 * The block is real (the event loop is held for 6.5s) because nothing shorter
 * can tell the patched server from the default one.
 *
 * CORRECTED 2026-10-23 (grade-tests wave 61): this header used to say that with
 * the setup entry's assignment removed BOTH legs fail, the POST with `fetch
 * failed`. On Node 22.23.4 that is no longer true: probe 8fw3g3-ka-timeout left
 * the fetch POST green with the patch removed. The global fetch (undici) honours
 * the server's `Keep-Alive: timeout=5` hint and retires the pooled socket itself
 * before reuse, so a fetch client opens a fresh connection and never sees the
 * reset (MEASURED with a plain node script, 6.5 s and 8 s blocks). A node:http
 * keep-alive Agent has no such client-side timer: on the default server its
 * reused socket dies with ECONNRESET, on the patched one it is reused (MEASURED).
 * So the POST leg drives an Agent, and asserts the socket was REUSED, which is
 * the thing the patch keeps alive.
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
    // One pooled socket. The body is READ: an unconsumed response never returns
    // its socket to the pool, the next request opens a fresh one, and the witness
    // passes vacuously (hence the reusedSocket assertion).
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const post = () => new Promise<{ status: number | undefined; reused: boolean }>((resolve, reject) => {
      const req = http.request(`${BASE}/ping`, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': '2' } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, reused: req.reusedSocket }));
      });
      req.on('error', reject);
      req.end('{}');
    });
    try {
      expect(await post()).toEqual({ status: 201, reused: false }); // opens + pools the socket
      // 6.5s, not 5.5s: this Node adds ~1s of grace to the 5s default, so a 5.5s
      // block passes on the unpatched server too (measured: 5.5s → 201, 6s → ECONNRESET).
      blockEventLoop(6_500);
      // One loop turn, as at any test boundary: the server's keep-alive timer gets
      // to fire before the client reuses the socket. Without this turn the request
      // is written first and the default server passes too — a block followed
      // directly by a request does NOT reproduce the defect (measured).
      await new Promise<void>((r) => setImmediate(r));
      // The default server resets this socket (ECONNRESET rejects here).
      expect(await post()).toEqual({ status: 201, reused: true });
    } finally {
      agent.destroy();
    }
  }, 20_000);

  it('close() still finishes promptly when a request was in flight at the call', async () => {
    let arrived!: () => void;
    const onServer = new Promise<void>((r) => { arrived = r; });
    const slow = express();
    slow.get('/slow', (_req, res) => { arrived(); setTimeout(() => res.json({ ok: true }), 300); });
    const s = await new Promise<http.Server>((r) => { const x = slow.listen(0, '127.0.0.1', () => r(x)); });
    const inFlight = fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/slow`).then((r) => r.text());
    await onServer; // the request is on the server (its handler ran), not a fixed sleep
    const started = Date.now();
    const closed = new Promise<void>((r) => s.close(() => r()));
    expect(await inFlight).toBe('{"ok":true}'); // not cut off
    await closed;
    // Without the reaper this waits for the 5s fallback (measured: the test reds).
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 20_000);
});
