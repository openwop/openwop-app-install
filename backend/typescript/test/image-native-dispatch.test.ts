/**
 * ADR 0115 § Correction (2026-07-17) — NATIVE vendor image dispatch.
 * A plain BYOK OpenAI/Google key generates images out-of-box (the
 * dispatchSpeech sibling), with the operator gateway keeping precedence when
 * configured. Unit-tests the vendor request/response shaping (mocked fetch) +
 * integration through the real adapter (secrets → resolveCredential → native
 * dispatch → Media asset), plus the key-never-echoed error contract.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createAiProvidersAdapter } from '../src/aiProviders/aiProvidersHost.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { dispatchImagesOpenAI, dispatchImagesGoogle } from '../src/providers/dispatchImages.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const realFetch = globalThis.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

const jsonRes = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

describe('dispatchImagesOpenAI (unit)', () => {
  it('shapes the request for gpt-image-1 (b64 by default — NO response_format) and parses data[].b64_json', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { data: [{ b64_json: PNG_B64 }] }));
    const out = await dispatchImagesOpenAI({ apiKey: 'sk-secret', prompt: 'a red square', n: 1 });
    expect(out).toEqual([{ base64: PNG_B64, mimeType: 'image/png' }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/images/generations');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-secret');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'gpt-image-1', prompt: 'a red square', n: 1 });
    expect(body.response_format).toBeUndefined(); // gpt-image-1 REJECTS it
  });

  it('dall-e models get response_format b64_json + the size param threads', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { data: [{ b64_json: PNG_B64 }] }));
    await dispatchImagesOpenAI({ apiKey: 'k', prompt: 'x', n: 2, model: 'dall-e-3', size: '1024x1024' });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ model: 'dall-e-3', response_format: 'b64_json', size: '1024x1024', n: 2 });
  });

  it('non-2xx throws with the status, and the error NEVER carries the key', async () => {
    fetchMock.mockResolvedValue(jsonRes(401, { error: { message: 'bad key' } }));
    await expect(dispatchImagesOpenAI({ apiKey: 'sk-super-secret', prompt: 'x', n: 1 }))
      .rejects.toThrow(/openai_images_401/);
    await expect(dispatchImagesOpenAI({ apiKey: 'sk-super-secret', prompt: 'x', n: 1 }))
      .rejects.not.toThrow(/sk-super-secret/);
  });
});

describe('dispatchImagesGoogle (unit)', () => {
  it('shapes the Imagen :predict request (x-goog-api-key, instances + sampleCount) and parses predictions', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { predictions: [{ bytesBase64Encoded: PNG_B64, mimeType: 'image/png' }] }));
    const out = await dispatchImagesGoogle({ apiKey: 'g-key', prompt: 'a cat', n: 1 });
    expect(out).toEqual([{ base64: PNG_B64, mimeType: 'image/png' }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
    expect(JSON.parse(String(init.body))).toEqual({ instances: [{ prompt: 'a cat' }], parameters: { sampleCount: 1 } });
  });

  it('an empty predictions array is a typed failure, not success-with-empty', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { predictions: [] }));
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
    fetchMock.mockResolvedValue(jsonRes(200, { data: [{ b64_json: PNG_B64 }] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await adapter.callImageGenerator({ prompt: 'a blue circle', provider: 'openai', credentialRef: 'my-openai', n: 1 });
    expect(r.images).toHaveLength(1);
    expect(r.images[0]!.url).toMatch(/^\/v1\/host|^http/); // a host media serve ref, not raw base64
    expect(r.usage).toMatchObject({ images: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('api.openai.com');
  });

  it('a native provider WITHOUT a credential stays honest-off (no fabricated dispatch)', async () => {
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(adapter.callImageGenerator({ prompt: 'x', provider: 'google' }))
      .rejects.toMatchObject({ code: 'host_capability_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a vendor 401 maps onto the taxonomy (provider_unavailable) without the key', async () => {
    fetchMock.mockResolvedValue(jsonRes(401, { error: 'bad' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(adapter.callImageGenerator({ prompt: 'x', provider: 'openai', credentialRef: 'my-openai' }))
      .rejects.toMatchObject({ code: 'provider_unavailable' });
  });
});
