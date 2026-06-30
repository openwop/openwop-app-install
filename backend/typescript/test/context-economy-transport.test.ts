/**
 * ADR 0148 Phase 5 (A6) — JSON gzip transport middleware.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { acceptsGzip, jsonGzipMiddleware } from '../src/middleware/jsonGzip.js';
import { gunzipSync } from 'node:zlib';

afterEach(() => {
  delete process.env.OPENWOP_CONTEXT_ECONOMY;
  delete process.env.OPENWOP_CONTEXT_ECONOMY_TRANSPORT;
});

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

/** Minimal mock req/res harness exercising the res.json override. */
function harness(acceptEncoding: string | undefined) {
  const headers: Record<string, string> = {};
  let ended: Buffer | undefined;
  const res = {
    getHeader: (k: string) => headers[k.toLowerCase()],
    setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
    removeHeader: (k: string) => { delete headers[k.toLowerCase()]; },
    end: (buf: Buffer) => { ended = buf; return res; },
    json: ((body: unknown) => { ended = Buffer.from(JSON.stringify(body)); return res; }) as Response['json'],
  } as unknown as Response;
  const req = { header: (k: string) => (k.toLowerCase() === 'accept-encoding' ? acceptEncoding : undefined) } as unknown as Request;
  return { req, res, headers, getEnded: () => ended };
}

describe('jsonGzipMiddleware', () => {
  const bigBody = { data: 'y'.repeat(5000) };

  it('off (flag unset) → res.json untouched, no Content-Encoding', () => {
    const { req, res, headers, getEnded } = harness('gzip');
    const next = vi.fn();
    jsonGzipMiddleware()(req, res, next);
    expect(next).toHaveBeenCalled();
    res.json(bigBody);
    expect(headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(getEnded()!.toString())).toEqual(bigBody);
  });

  it('on + accepts gzip + over threshold → gzipped body with correct headers', () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSPORT = 'on';
    const { req, res, headers, getEnded } = harness('gzip');
    jsonGzipMiddleware()(req, res, () => {});
    res.json(bigBody);
    expect(headers['content-encoding']).toBe('gzip');
    expect(headers['vary']).toBe('Accept-Encoding');
    expect(headers['content-length']).toBe(String(getEnded()!.length));
    expect(JSON.parse(gunzipSync(getEnded()!).toString())).toEqual(bigBody); // round-trips
  });

  it('on but client does NOT accept gzip → passes through (next, no override)', () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSPORT = 'on';
    const { req, res, headers } = harness('deflate');
    const next = vi.fn();
    jsonGzipMiddleware()(req, res, next);
    expect(next).toHaveBeenCalled();
    res.json(bigBody);
    expect(headers['content-encoding']).toBeUndefined();
  });

  it('on + small body under threshold → identity (not gzipped)', () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSPORT = 'on';
    const { req, res, headers, getEnded } = harness('gzip');
    jsonGzipMiddleware()(req, res, () => {});
    res.json({ ok: true });
    expect(headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(getEnded()!.toString())).toEqual({ ok: true });
  });

  it('on + already Content-Encoding set → does not double-encode', () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_TRANSPORT = 'on';
    const { req, res, headers, getEnded } = harness('gzip');
    jsonGzipMiddleware()(req, res, () => {});
    res.setHeader('Content-Encoding', 'br');
    res.json(bigBody);
    expect(headers['content-encoding']).toBe('br');
    expect(JSON.parse(getEnded()!.toString())).toEqual(bigBody); // identity JSON, not re-gzipped
  });
});
