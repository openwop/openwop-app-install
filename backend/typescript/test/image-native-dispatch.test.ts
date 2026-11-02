/**
 * ADR 0115 § Correction (2026-07-17) — NATIVE vendor image dispatch.
 * A plain BYOK OpenAI/Google key generates images out-of-box (the
 * dispatchSpeech sibling), with the operator gateway keeping precedence when
 * configured. Unit-tests the vendor request/response shaping (mocked fetch) +
 * integration through the real adapter (secrets → resolveCredential → native
 * dispatch → Media asset), plus the key-never-echoed error contract.
 *
 * TST-DGC-6. Red when gpt-image-1 is sent `response_format`, when a non-2xx
 * error message carries the key, when an empty Imagen response succeeds, when
 * Imagen's `sampleCount` ignores `n` (the fixture asks for 2), when the BYOK
 * native path is skipped, and when a vendor 401 maps to another code
 * (sabotage-witnessed, wave 71). Vendor base-URL env overrides are cleared per
 * case so the exact URLs asserted below are the defaults.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createAiProvidersAdapter } from '../src/aiProviders/aiProvidersHost.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { dispatchImagesOpenAI, dispatchImagesGoogle } from '../src/providers/dispatchImages.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const realFetch = globalThis.fetch;
const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';
const fetchMock = vi.fn<typeof fetch>();
const priorBase = { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL, GOOGLE_BASE_URL: process.env.GOOGLE_BASE_URL };

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.GOOGLE_BASE_URL;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(priorBase)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A real `Response`, minted per call (a body can be read once). */
const respond = (status: number, body: unknown) => async (): Promise<Response> =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const call0 = (): { url: string; init: RequestInit } => {
  const [input, init] = fetchMock.mock.calls[0]!;
  return { url: String(input), init: init ?? {} };
};

describe('dispatchImagesOpenAI (unit)', () => {
  it('shapes the request for gpt-image-1 (b64 by default — NO response_format) and parses data[].b64_json', async () => {
    fetchMock.mockImplementation(respond(200, { data: [{ b64_json: PNG_B64 }] }));
    const out = await dispatchImagesOpenAI({ apiKey: 'sk-secret', prompt: 'a red square', n: 1 });
    expect(out).toEqual([{ base64: PNG_B64, mimeType: 'image/png' }]);
    const { url, init } = call0();
    expect(url).toBe(OPENAI_IMAGES_URL);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-secret');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'gpt-image-1', prompt: 'a red square', n: 1 });
    expect(body.response_format).toBeUndefined(); // gpt-image-1 REJECTS it
  });

  it('dall-e models get response_format b64_json + the size param threads', async () => {
    fetchMock.mockImplementation(respond(200, { data: [{ b64_json: PNG_B64 }] }));
    await dispatchImagesOpenAI({ apiKey: 'k', prompt: 'x', n: 2, model: 'dall-e-3', size: '1024x1024' });
    const body = JSON.parse(String(call0().init.body));
    expect(body).toMatchObject({ model: 'dall-e-3', response_format: 'b64_json', size: '1024x1024', n: 2 });
  });

  it('non-2xx throws with the status, and the error NEVER carries the key', async () => {
    fetchMock.mockImplementation(respond(401, { error: { message: 'bad key' } }));
    await expect(dispatchImagesOpenAI({ apiKey: 'sk-super-secret', prompt: 'x', n: 1 }))
      .rejects.toThrow(/openai_images_401/);
    await expect(dispatchImagesOpenAI({ apiKey: 'sk-super-secret', prompt: 'x', n: 1 }))
      .rejects.not.toThrow(/sk-super-secret/);
  });
});

describe('dispatchImagesGoogle (unit)', () => {
  it('shapes the Imagen :predict request (x-goog-api-key, instances + sampleCount) and parses predictions', async () => {
    fetchMock.mockImplementation(respond(200, { predictions: [{ bytesBase64Encoded: PNG_B64, mimeType: 'image/png' }] }));
    const out = await dispatchImagesGoogle({ apiKey: 'g-key', prompt: 'a cat', n: 2 });
    expect(out).toEqual([{ base64: PNG_B64, mimeType: 'image/png' }]);
    const { url, init } = call0();
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict');
    expect(new Headers(init.headers).get('x-goog-api-key')).toBe('g-key');
    expect(JSON.parse(String(init.body))).toEqual({ instances: [{ prompt: 'a cat' }], parameters: { sampleCount: 2 } });
  });

  it('an empty predictions array is a typed failure, not success-with-empty', async () => {
    fetchMock.mockImplementation(respond(200, { predictions: [] }));
    await expect(dispatchImagesGoogle({ apiKey: 'k', prompt: 'x', n: 1 })).rejects.toThrow(/google_imagen_no_data/);
  });
});

describe('callImageGenerator native path (integration)', () => {
  let server: http.Server;
  let adapter: ReturnType<typeof createAiProvidersAdapter>;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    delete process.env.OPENWOP_IMAGE_PROVIDER_ENABLED; // no operator gateway — native must carry it
    delete process.env.OPENWOP_IMAGE_PROVIDER_ENDPOINT;
    globalThis.fetch = realFetch; // app boot uses real fetch
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
    const hostSuite = app.locals.hostSuite as HostAdapterSuite;
    adapter = createAiProvidersAdapter({
      runId: 'img-native-run', nodeId: 'image.generate', tenantId: 'default', attempt: 1,
      secrets: { 'my-openai': 'sk-test-123' }, policyResolver: hostSuite.providerPolicyResolver,
    });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('a BYOK OpenAI key generates out-of-box: native dispatch → stored Media asset', async () => {
    fetchMock.mockImplementation(respond(200, { data: [{ b64_json: PNG_B64 }] }));
    globalThis.fetch = fetchMock;
    const r = await adapter.callImageGenerator({ prompt: 'a blue circle', provider: 'openai', credentialRef: 'my-openai', n: 1 });
    expect(r.images).toHaveLength(1);
    expect(r.images[0]!.url).toMatch(/^\/host\/openwop-app\/assets\/|^http/); // a host media serve ref, not raw base64
    expect(r.usage).toMatchObject({ images: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(call0().url).toBe(OPENAI_IMAGES_URL);
  });

  it('a native provider WITHOUT a credential stays honest-off (no fabricated dispatch)', async () => {
    globalThis.fetch = fetchMock;
    await expect(adapter.callImageGenerator({ prompt: 'x', provider: 'google' }))
      .rejects.toMatchObject({ code: 'host_capability_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a vendor 401 maps onto the taxonomy (provider_unavailable) without the key', async () => {
    fetchMock.mockImplementation(respond(401, { error: 'bad' }));
    globalThis.fetch = fetchMock;
    await expect(adapter.callImageGenerator({ prompt: 'x', provider: 'openai', credentialRef: 'my-openai' }))
      .rejects.toMatchObject({ code: 'provider_unavailable' });
  });
});
