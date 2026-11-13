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
 * ADR 1003 D6 added: the most specific Accept-Encoding entry wins (an explicit
 * gzip beats `*` either way round); the gzipped body goes through `res.send`, so
 * it keeps Express's ETag and answers a fresh revalidation with 304; a route's
 * strong ETag is weakened on the gzipped representation only; `res.json(undefined)`
 * is an empty 200, never a thrown 500.
 *
 * Sabotage (grade-tests w28, re-probed w107): ignoring the flag or Accept-Encoding,
 * dropping the threshold, the q=0 or `*` handling, letting the first entry decide,
 * the already-encoded guard, the Vary header, ending with `res.end(gz)` instead of
 * `res.send`, dropping `weakenEtag`, or dropping the `undefined` guard each turn a
 * case red. Content-Length is asserted as the wire claim, but no middleware line
 * owns it any more: `res.send` (and Node's `end`) set it, so no sabotage of this
 * file can move it.
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
  // ADR 1003 D6 — the most specific entry wins, whatever its position.
  it('an explicit gzip entry beats the wildcard in both directions', () => {
    expect(acceptsGzip('*;q=0, gzip')).toBe(true);
    expect(acceptsGzip('gzip;q=0, *')).toBe(false);
    expect(acceptsGzip('*, gzip;q=0')).toBe(false);
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
  app.get('/strong', (_req, res) => { res.setHeader('ETag', '"rev-7"'); res.json(bigBody); });
  app.get('/undef', (_req, res) => { res.json(undefined); });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => { port = (server.address() as AddressInfo).port; resolve(); }); });
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

/** Raw GET — node:http never decompresses, so `body` is exactly the wire bytes. */
function get(path: string, acceptEncoding: string, extra: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { 'accept-encoding': acceptEncoding, ...extra } }, (res) => {
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

  // ADR 1003 D6 — the compressed path goes through `res.send`, so Express's
  // conditional-GET machinery still runs. Sabotage: ending the response with
  // `res.end(gz)` (the first version) reds the ETag and 304 cases; dropping
  // `weakenEtag` reds the strong-ETag case.
  it('on + gzipped → carries an ETag and answers a matching revalidation with 304', async () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSPORT = 'on';
    const first = await get('/big', 'gzip');
    // The ETag must belong to the GZIPPED representation: the identity path gets
    // one from Express too, so without this the case passes with gzip broken.
    expect(first.headers['content-encoding']).toBe('gzip');
    const etag = first.headers['etag'];
    expect(typeof etag).toBe('string');
    const again = await get('/big', 'gzip', { 'if-none-match': String(etag) });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
  });

  it('on + a route\'s strong ETag → weakened on the gzipped representation, still revalidates', async () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSPORT = 'on';
    const r = await get('/strong', 'gzip');
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(r.headers['etag']).toBe('W/"rev-7"');
    const again = await get('/strong', 'gzip', { 'if-none-match': 'W/"rev-7"' });
    expect(again.status).toBe(304);
    const identity = await get('/strong', 'deflate');
    expect(identity.headers['etag']).toBe('"rev-7"');
  });

  it('on + res.json(undefined) → an empty 200, not a thrown 500', async () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSPORT = 'on';
    const r = await get('/undef', 'gzip');
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.body.length).toBe(0);
  });
});
