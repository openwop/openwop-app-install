/**
 * Gap D-2 — sample media generation routes that back `openwop media`.
 *
 *   POST /v1/host/openwop-app/media/generate-image
 *
 * The demo host advertises aiProviders.imageGeneration: supported:false and
 * wires no live media provider, so these return DETERMINISTIC stub assets
 * tagged `stub: true`. Verifies each route validates its required field,
 * returns the documented shape, and (for the binary kinds) that the minted
 * asset URL resolves to the stored bytes via the token-authed serve route.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface AssetResp { url?: string; bytes?: number; contentType?: string; stub?: boolean }

describe('sample media routes (gap D-2)', () => {
  it('generate-image: rejects an empty prompt', async () => {
    const r = await jsonFetch('/v1/host/openwop-app/media/generate-image', { method: 'POST', body: JSON.stringify({}) });
    expect(r.status).toBe(400);
  });

  it('generate-image: returns a stub PNG asset whose URL resolves', async () => {
    const r = await jsonFetch<AssetResp>('/v1/host/openwop-app/media/generate-image', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'a red bicycle' }),
    });
    expect(r.status).toBe(201);
    expect(r.body.stub).toBe(true);
    expect(r.body.contentType).toBe('image/png');
    expect(r.body.url).toMatch(/^\/v1\/host\/openwop-app\/assets\//);
    expect((r.body.bytes ?? 0)).toBeGreaterThan(0);

    const served = await fetch(`${BASE}${r.body.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
  });

  // MEDIA-6: the `transcribe` + `synthesize` demo routes were retired (ADR 0085
  // OQ-5) — superseded by the notebooks transcribe node + the RFC 0105
  // `ai/call-speech-synthesizer` seam. Their cases are removed with the routes.
});
