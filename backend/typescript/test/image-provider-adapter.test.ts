/**
 * ADR 0115 Phase 3 — external image-provider adapter (SSRF-guarded, §D-scrubbed).
 *
 * TST-DGC-7. Red when an endpoint alone (no operator opt-in) counts as
 * configured, when per-provider endpoint or key routing is dropped, when the
 * prompt is not forwarded, and when the deny-host SSRF check is removed. The
 * SSRF leg uses an HTTPS metadata URL so the separate `http:` →
 * `image_provider_insecure` guard cannot satisfy it; that second guard has its
 * own leg (sabotage-witnessed, wave 71).
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dispatchImageGeneration, imageProviderConfigured } from '../src/host/imageProviderAdapter.js';

/** The loopback provider's path (one literal, reused). */
const IMAGES_PATH = '/v1/images';
let server: http.Server;
let PORT = 0;
let lastBody: unknown = null;
let lastUrl = '';
let lastAuth = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    lastUrl = req.url ?? '';
    lastAuth = (req.headers.authorization as string) ?? '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      lastBody = JSON.parse(raw || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ images: [{ base64: 'aGVsbG8=', mimeType: 'image/png' }] }));
    });
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; r(); }); });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('OPENWOP_IMAGE_PROVIDER_') || k === 'OPENWOP_WEBHOOK_ALLOW_PRIVATE') delete process.env[k];
  }
});

describe('imageProviderConfigured', () => {
  it('is false unless opted-in AND an endpoint is wired', () => {
    expect(imageProviderConfigured()).toBe(false);
    // An endpoint WITHOUT the opt-in is not configured.
    process.env.OPENWOP_IMAGE_PROVIDER_ENDPOINT = 'https://images.example';
    expect(imageProviderConfigured()).toBe(false);
    delete process.env.OPENWOP_IMAGE_PROVIDER_ENDPOINT;
    process.env.OPENWOP_IMAGE_PROVIDER_ENABLED = 'true';
    expect(imageProviderConfigured()).toBe(false); // no endpoint
    process.env.OPENWOP_IMAGE_PROVIDER_ENDPOINT = 'https://images.example';
    expect(imageProviderConfigured()).toBe(true);
  });
});

describe('dispatchImageGeneration', () => {
  it('POSTs the prompt + returns the base64 image (loopback, allow-private)', async () => {
    process.env.OPENWOP_IMAGE_PROVIDER_ENDPOINT = `http://127.0.0.1:${PORT}${IMAGES_PATH}`;
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const out = await dispatchImageGeneration({ prompt: 'a cat', n: 1, model: 'gpt-image' });
    expect(out).toHaveLength(1);
    expect(out[0]!.base64).toBe('aGVsbG8=');
    expect(lastUrl).toBe(IMAGES_PATH);
    expect(lastBody).toMatchObject({ prompt: 'a cat', model: 'gpt-image', n: 1 });
  });

  it('throws image_provider_not_configured with no endpoint', async () => {
    await expect(dispatchImageGeneration({ prompt: 'x', n: 1 })).rejects.toThrow('image_provider_not_configured');
  });

  it('ADR 0115 Phase 6 — routes per PROVIDER: google → its own endpoint + key, while openai falls back to the generic', async () => {
    process.env.OPENWOP_IMAGE_PROVIDER_ENABLED = 'true';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    process.env.OPENWOP_IMAGE_PROVIDER_ENDPOINT = `http://127.0.0.1:${PORT}/generic`;
    process.env.OPENWOP_IMAGE_PROVIDER_ENDPOINT_GOOGLE = `http://127.0.0.1:${PORT}/imagen`;
    process.env.OPENWOP_IMAGE_PROVIDER_KEY_GOOGLE = 'imagen-key';

    // a second provider is configured independently of the default
    expect(imageProviderConfigured('google')).toBe(true);
    expect(imageProviderConfigured('openai')).toBe(true); // generic fallback

    await dispatchImageGeneration({ prompt: 'x', n: 1, provider: 'google' });
    expect(lastUrl).toBe('/imagen');            // routed to Imagen's own endpoint
    expect(lastAuth).toBe('Bearer imagen-key'); // with Imagen's own key

    await dispatchImageGeneration({ prompt: 'x', n: 1, provider: 'openai' });
    expect(lastUrl).toBe('/generic');           // openai → the generic fallback endpoint
  });

  it('ADR 0115 Phase 6 — a provider with NO endpoint (and no generic) is not configured (honest-off)', () => {
    process.env.OPENWOP_IMAGE_PROVIDER_ENABLED = 'true';
    process.env.OPENWOP_IMAGE_PROVIDER_ENDPOINT_GOOGLE = 'https://imagen.example';
    expect(imageProviderConfigured('google')).toBe(true);
    expect(imageProviderConfigured('openai')).toBe(false); // no generic, no _OPENAI ⇒ off
  });

  it('SSRF: blocks a private endpoint without allow-private + never echoes it (§D)', async () => {
    // HTTPS, so only the deny-host check can refuse it.
    process.env.OPENWOP_IMAGE_PROVIDER_ENDPOINT = 'https://169.254.169.254/latest/meta-data';
    const blocked: unknown = await dispatchImageGeneration({ prompt: 'x', n: 1 }).then(() => null, (e: unknown) => e);
    const msg = blocked instanceof Error ? blocked.message : '';
    expect(msg).toBe('image_provider_blocked');
    expect(msg).not.toContain('169.254'); // §D — endpoint never leaks
    // The second guard, on its own: a public host over plain http is refused as insecure.
    process.env.OPENWOP_IMAGE_PROVIDER_ENDPOINT = 'http://images.example.invalid/gen';
    await expect(dispatchImageGeneration({ prompt: 'x', n: 1 })).rejects.toThrow('image_provider_insecure');
  });
});
