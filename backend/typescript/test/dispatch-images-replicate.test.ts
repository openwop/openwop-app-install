/**
 * ADR 0401 P2 — the Replicate image dispatcher (TST-CWA-1): Prefer-wait create,
 * bounded polling under the abort signal, terminal-failure typed errors, and the
 * SSRF posture — output URLs are host-allowlist-pinned and fetched UNCREDENTIALED,
 * and polling only ever reads api.replicate.com.
 *
 * Red when (sabotage-witnessed, wave 69):
 *  - the output-host allowlist (`assertAllowedReplicateOutputUrl`) is bypassed or
 *    admits `http:` → "REJECTS an output URL off the allowlist";
 *  - the output fetch carries the key, or the create drops `prefer: wait=60` →
 *    "creates with Prefer: wait";
 *  - the poll-host check (`replicate_poll_host_denied`) is removed → the polling
 *    case's off-host leg (the allowlist alone admits replicate.delivery);
 *  - the failure reason is dropped OR the key is echoed into the error →
 *    "a failed prediction is a typed plain-Error";
 *  - the owner/name model check, the AbortError name, the 404/422 rotation
 *    message or the curated default-model map changes → the case of that name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchImagesReplicate, REPLICATE_OP_DEFAULT_MODELS } from '../src/providers/dispatchImages.js';

/** The default (flux-schnell) create endpoint, spelled out — never derived from the product. */
const CREATE_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions';
const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');

type FetchCall = { url: string; init: RequestInit | undefined };

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  return { calls };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('dispatchImagesReplicate', () => {
  it('creates with Prefer: wait, fetches allowlisted output uncredentialed, returns base64', async () => {
    const { calls } = fakeFetch((url) => {
      if (url.includes('/models/')) {
        return json({ id: 'p1', status: 'succeeded', output: ['https://replicate.delivery/pbxt/abc/out.png'] });
      }
      if (url.startsWith('https://replicate.delivery/')) {
        return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const images = await dispatchImagesReplicate({ apiKey: 'r8_test_key', prompt: 'a fox', n: 1 });
    expect(images).toEqual([{ base64: PNG_BYTES.toString('base64'), mimeType: 'image/png' }]);

    const create = calls[0]!;
    expect(create.url).toBe(CREATE_URL);
    expect((create.init?.headers as Record<string, string>).prefer).toBe('wait=60');
    // The output fetch never carries the key — it carries no headers at all.
    const output = calls.find((c) => c.url.startsWith('https://replicate.delivery/'))!;
    expect(output.init?.headers).toBeUndefined();
  });

  it('polls a non-terminal prediction to success (api.replicate.com only)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    let polls = 0;
    fakeFetch((url) => {
      if (url.endsWith('/predictions')) {
        return json({ id: 'p2', status: 'processing', urls: { get: 'https://api.replicate.com/v1/predictions/p2' } });
      }
      if (url === 'https://api.replicate.com/v1/predictions/p2') {
        polls += 1;
        return polls < 2
          ? json({ id: 'p2', status: 'processing', urls: { get: 'https://api.replicate.com/v1/predictions/p2' } })
          : json({ id: 'p2', status: 'succeeded', output: 'https://replicate.delivery/pbxt/x/one.webp' });
      }
      return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/webp' } });
    });
    let settled = false;
    const pending = dispatchImagesReplicate({ apiKey: 'k', prompt: 'x', n: 1 }).finally(() => { settled = true; });
    // The product waits 1 s between polls; advance the fake clock instead of waiting.
    for (let i = 0; i < 5 && !settled; i++) await vi.advanceTimersByTimeAsync(1_000);
    const images = await pending;
    expect(polls).toBe(2);
    expect(images[0]?.mimeType).toBe('image/webp');

    // A poll URL on an allowlisted OUTPUT host is still not a poll host: the
    // allowlist alone admits replicate.delivery, so this leg is the poll-host check.
    const { calls } = fakeFetch(() => json({ id: 'p5', status: 'processing', urls: { get: 'https://replicate.delivery/p5' } }));
    await expect(dispatchImagesReplicate({ apiKey: 'k', prompt: 'x', n: 1 }))
      .rejects.toThrow('replicate_poll_host_denied: poll URL must be api.replicate.com');
    expect(calls.map((c) => c.url)).toEqual([CREATE_URL]);
  });

  it('a failed prediction is a typed plain-Error (reason surfaced, key never echoed)', async () => {
    fakeFetch(() => json({ id: 'p3', status: 'failed', error: 'NSFW content detected' }));
    const err = await dispatchImagesReplicate({ apiKey: 'r8_secret', prompt: 'x', n: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('replicate_failed: NSFW content detected');
    expect((err as Error).message).not.toContain('r8_secret');
  });

  it('REJECTS an output URL off the allowlist (SSRF pin) without fetching it', async () => {
    const { calls } = fakeFetch(() => json({ status: 'succeeded', output: ['https://169.254.169.254/latest/meta-data'] }));
    await expect(dispatchImagesReplicate({ apiKey: 'k', prompt: 'x', n: 1 }))
      .rejects.toThrow(/replicate_output_host_denied/);
    expect(calls.some((c) => c.url.includes('169.254'))).toBe(false);
    fakeFetch(() => json({ status: 'succeeded', output: ['http://replicate.delivery/not-https'] }));
    await expect(dispatchImagesReplicate({ apiKey: 'k', prompt: 'x', n: 1 }))
      .rejects.toThrow(/replicate_output_host_denied/);
  });

  it('rejects a malformed model id before any network call', async () => {
    const { calls } = fakeFetch(() => json({}));
    await expect(dispatchImagesReplicate({ apiKey: 'k', prompt: 'x', n: 1, model: '../evil?x=1' }))
      .rejects.toThrow(/replicate_bad_model/);
    expect(calls.length).toBe(0);
  });

  it('an aborted signal surfaces as AbortError during the poll wait', async () => {
    const ac = new AbortController();
    fakeFetch((url) => {
      if (url.endsWith('/predictions')) {
        ac.abort();
        return json({ status: 'processing', urls: { get: 'https://api.replicate.com/v1/predictions/p4' } });
      }
      return json({ status: 'processing', urls: { get: 'https://api.replicate.com/v1/predictions/p4' } });
    });
    await expect(dispatchImagesReplicate({ apiKey: 'k', prompt: 'x', n: 1, signal: ac.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('R0401-2 — a 404/422 on the model endpoint names the model + the override (rotation guard)', async () => {
    fakeFetch(() => new Response('not found', { status: 404 }));
    await expect(dispatchImagesReplicate({ apiKey: 'k', prompt: 'x', n: 1, model: 'owner/sunset-model' }))
      .rejects.toThrow(/replicate_model_unavailable_404: model "owner\/sunset-model" is unavailable.*override/);
    fakeFetch(() => new Response('unprocessable', { status: 422 }));
    await expect(dispatchImagesReplicate({ apiKey: 'k', prompt: 'x', n: 1 }))
      .rejects.toThrow(/replicate_model_unavailable_422/);
  });

  it('R0401-2 — the curated default models are the pinned rotation surface (well-formed owner/name)', () => {
    const defaults = Object.values(REPLICATE_OP_DEFAULT_MODELS);
    expect(defaults.length).toBe(4);
    for (const m of defaults) expect(m, m).toMatch(/^[\w.-]+\/[\w.-]+$/);
    // A change here should be deliberate — pin the current set.
    expect(REPLICATE_OP_DEFAULT_MODELS).toEqual({
      edit: 'black-forest-labs/flux-dev',
      inpaint: 'stability-ai/stable-diffusion-inpainting',
      'background-remove': 'lucataco/remove-bg',
      upscale: 'nightmareai/real-esrgan',
    });
  });
});
