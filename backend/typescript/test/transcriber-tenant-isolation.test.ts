/**
 * RFC 0106 §B / §F + RFC 0055 `media-asset-url-tenant-scoped` — `callTranscriber`
 * MUST bind a resolved `audio.url` media asset to the caller's tenant, so a leaked
 * (unguessable) capability token cannot let one tenant transcribe another's audio
 * and land the transcript on its own run log.
 *
 * Booted WITHOUT `OPENWOP_TEST_SEAM_ENABLED` on purpose: with the test seam on the
 * call-transcriber seam forces `provider:'mock'`, which short-circuits to the canned
 * turn BEFORE the url/tenant path — so the real-path tenant check only runs here.
 * The asset is stored under a foreign tenant; the request's tenant differs, so the
 * check throws `invalid_request` before any provider call (no transcript leaks).
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';

let BASE: string;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  delete process.env.OPENWOP_TEST_SEAM_ENABLED; // force the REAL url path, not the mock short-circuit
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const SEAM = '/v1/host/sample/ai/call-transcriber';
const post = (body: unknown) => fetch(`${BASE}${SEAM}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

describe('RFC 0055 media-asset-url-tenant-scoped — callTranscriber tenant binding', () => {
  it('rejects a foreign tenant\'s asset url (no cross-tenant transcript)', async () => {
    // Mint an asset OWNED BY a different tenant than the request will carry.
    const victim = await storeMediaAsset('tenant-victim-7f3a', {
      contentBase64: Buffer.from('not-real-audio').toString('base64'),
      contentType: 'audio/mpeg',
    });

    const res = await post({ audio: { url: victim.url } });
    // The tenant check throws before any provider call → 400 invalid_request, NOT a turn.
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { code?: string }; finalText?: unknown; events?: unknown };
    expect(body.error?.code).toBe('invalid_request');
    // Crucially: NO transcript / events leaked for the foreign asset.
    expect(body.finalText).toBeUndefined();
    expect(body.events).toBeUndefined();
  });
});
