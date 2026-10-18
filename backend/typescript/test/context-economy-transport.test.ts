/**
 * ADR 0148 Phase 5 (A6) — JSON gzip transport middleware.
 *
 * Guards `acceptsGzip` (gzip / `*` accepted, q=0 refused) and `jsonGzipMiddleware`
 * on a REAL Express app: off by default; when OPENWOP_CONTEXT_ECONOMY_TRANSPORT is
 * on and the client accepts gzip, a JSON body over the threshold is gzipped with
 * `Content-Encoding: gzip`, `Vary: Accept-Encoding` and a Content-Length of the
 * compressed bytes; a client that does not accept gzip, a small body, or a route
 * that already set Content-Encoding gets identity JSON. Responses are read with
 * raw node:http (no auto-decompression), so the headers and bytes are the wire's.
 *
 * Sabotage (grade-tests w28): ignoring the flag or Accept-Encoding, dropping the
 * threshold, the q=0 or `*` handling, the already-encoded guard, the Vary header,
 * or computing Content-Length from the raw body each turn a case red.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { acceptsGzip, jsonGzipMiddleware } from '../src/middleware/jsonGzip.js';

const ENV_KEYS = ['OPENWOP_CONTEXT_ECONOMY', 'OPENWOP_CONTEXT_ECONOMY_TRANSPORT'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('acceptsGzip', () => {
  it('true for gzip / *', () => {
    expect(acceptsGzip('gzip, deflate, br')).toBe(true);
    expect(acceptsGzip('*')).toBe(true);
    expect(acceptsGzip('br, gzip;q=0.5')).toBe(true);
  });
  it('false for absent / non-gzip / q=0', () => {
    expect(acceptsGzip(undefined)).toBe(false);
    expect(acceptsGzip('deflate, br')).toBe(false);
    expect(acceptsGzip('gzip;q=0')).toBe(false);
  });
});

const bigBody = { data: 'y'.repeat(5000) };

let server: http.Server;
let port = 0;
beforeAll(async () => {
  const app = express();
  // The middleware reads the env flag per request, so one server serves on and off cases.
  app.use(jsonGzipMiddleware());
  app.get('/big', (_req, res) => { res.json(bigBody); });
  app.get('/small', (_req, res) => { res.json({ ok: true }); });
  app.get('/pre', (_req, res) => { res.setHeader('Content-Encoding', 'br'); res.json(bigBody); });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => { port = (server.address() as AddressInfo).port; resolve(); }); });
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

/** Raw GET — node:http never decompresses, so `body` is exactly the wire bytes. */
function get(path: string, acceptEncoding: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { 'accept-encoding': acceptEncoding } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

describe('jsonGzipMiddleware', () => {
  it('off (flag unset) → res.json untouched, no Content-Encoding', async () => {
    const r = await get('/big', 'gzip');
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(r.body.toString())).toEqual(bigBody);
  });

  it('on + accepts gzip + over threshold → gzipped body with correct headers', async () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSPORT = 'on';
    const r = await get('/big', 'gzip');
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(r.headers['vary']).toBe('Accept-Encoding');
    expect(r.headers['content-length']).toBe(String(r.body.length));
    expect(JSON.parse(gunzipSync(r.body).toString())).toEqual(bigBody); // round-trips
  });

  it('on but client does NOT accept gzip → passes through (next, no override)', async () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSPORT = 'on';
    const r = await get('/big', 'deflate');
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(r.body.toString())).toEqual(bigBody);
  });

  it('on + small body under threshold → identity (not gzipped)', async () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSPORT = 'on';
    const r = await get('/small', 'gzip');
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(r.body.toString())).toEqual({ ok: true });
  });

  it('on + already Content-Encoding set → does not double-encode', async () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSPORT = 'on';
    const r = await get('/pre', 'gzip');
    expect(r.headers['content-encoding']).toBe('br');
    expect(JSON.parse(r.body.toString())).toEqual(bigBody); // identity JSON, not re-gzipped
  });
});
