/**
 * Gap D-2 — the sample image-generation route that backs `openwop media`
 * (the CLI's `media generate-image`, ../openwop-cli/src/cli/media.ts).
 *
 *   POST /host/openwop-app/media/generate-image
 *
 * The demo host advertises aiProviders.imageGeneration: supported:false and
 * wires no live media provider, so the route returns a DETERMINISTIC stub PNG
 * tagged `stub: true`. LEAK-5 (ADR 0195): the route is mounted ONLY under
 * OPENWOP_TEST_SEAM_ENABLED, which is why this file sets it.
 *
 * Verifies the route rejects an empty prompt with the `invalid_argument`
 * envelope, returns the documented shape (stub flag, type, prompt echo, size),
 * and that the minted URL serves exactly those bytes. Breaks if the prompt
 * check, the stub flag, the stored type or the stored bytes change
 * (probes w5g2-gen-*).
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
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true'; // LEAK-5: the stub generate-image route is now test-seam-gated
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface AssetResp { url?: string; bytes?: number; contentType?: string; stub?: boolean; prompt?: string; error?: string }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('sample media routes (gap D-2)', () => {
  it('generate-image: rejects an empty prompt', async () => {
    const r = await jsonFetch<AssetResp>('/host/openwop-app/media/generate-image', { method: 'POST', body: JSON.stringify({}) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_argument');
  });

  it('generate-image: returns a stub PNG asset whose URL resolves', async () => {
    const r = await jsonFetch<AssetResp>('/host/openwop-app/media/generate-image', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'a red bicycle' }),
    });
    expect(r.status).toBe(201);
    expect(r.body.stub).toBe(true);
    expect(r.body.contentType).toBe('image/png');
    expect(r.body.url).toMatch(/^\/host\/openwop-app\/assets\//);
    expect((r.body.bytes ?? 0)).toBeGreaterThan(0);
    expect(r.body.prompt).toBe('a red bicycle');

    const served = await fetch(`${BASE}${r.body.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await served.arrayBuffer());
    expect(buf.length).toBe(r.body.bytes);
    expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  // MEDIA-6: the `transcribe` + `synthesize` demo routes were retired (ADR 0085
  // OQ-5) — superseded by the notebooks transcribe node + the RFC 0105
  // `ai/call-speech-synthesizer` seam. Their cases are removed with the routes.
});
