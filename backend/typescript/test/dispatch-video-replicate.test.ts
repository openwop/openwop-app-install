/**
 * ADR 0411 P1 — the Replicate VIDEO dispatcher: Prefer-wait create, bounded
 * polling under the abort signal (slower cadence than images), terminal-failure
 * typed errors, and the same SSRF posture — output URLs are host-allowlist-pinned
 * and fetched UNCREDENTIALED. Reuses the ADR 0401 primitives so this test mirrors
 * dispatch-images-replicate.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchVideoReplicate, DEFAULT_REPLICATE_VIDEO_MODEL, isAudioCapableVideoModel } from '../src/providers/dispatchVideo.js';

const MP4_BYTES = Buffer.from('00000018667479706d703432', 'hex');

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

afterEach(() => { vi.unstubAllGlobals(); });

describe('dispatchVideoReplicate', () => {
  it('creates against the Veo-3 default with Prefer: wait, fetches allowlisted output uncredentialed, returns base64', async () => {
    const { calls } = fakeFetch((url) => {
      if (url.includes('/models/')) {
        return json({ id: 'v1', status: 'succeeded', output: 'https://replicate.delivery/pbxt/abc/reel.mp4' });
      }
      if (url.startsWith('https://replicate.delivery/')) {
        return new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const video = await dispatchVideoReplicate({ apiKey: 'r8_test_key', prompt: 'a fox running' });
    expect(video).toEqual({ base64: MP4_BYTES.toString('base64'), mimeType: 'video/mp4', sizeBytes: MP4_BYTES.byteLength });

    const create = calls[0]!;
    expect(create.url).toBe(`https://api.replicate.com/v1/models/${DEFAULT_REPLICATE_VIDEO_MODEL}/predictions`);
    expect((create.init?.headers as Record<string, string>).prefer).toBe('wait=60');
    // The output fetch never carries the key.
    const output = calls.find((c) => c.url.startsWith('https://replicate.delivery/'))!;
    const outHeaders = (output.init?.headers ?? {}) as Record<string, string>;
    expect(JSON.stringify(outHeaders)).not.toContain('r8_test_key');
  });

  it('forwards negative_prompt / duration / aspect_ratio / seed into the model input', async () => {
    const { calls } = fakeFetch((url) => {
      if (url.includes('/models/')) return json({ status: 'succeeded', output: 'https://replicate.delivery/x/o.mp4' });
      return new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } });
    });
    await dispatchVideoReplicate({ apiKey: 'k', prompt: 'city', negativePrompt: 'blurry', durationSeconds: 8, aspectRatio: '9:16', seed: 42 });
    const body = JSON.parse(String((calls[0]!.init as RequestInit).body));
    expect(body.input).toMatchObject({ prompt: 'city', negative_prompt: 'blurry', duration: 8, aspect_ratio: '9:16', seed: 42 });
  });

  // ADR 0411 P2 — `generate_audio` forwarded ONLY for the audio-capable family.
  const audioInput = async (model: string | undefined, generateAudio: boolean | undefined): Promise<Record<string, unknown>> => {
    const { calls } = fakeFetch((url) => {
      if (url.includes('/models/')) return json({ status: 'succeeded', output: 'https://replicate.delivery/x/o.mp4' });
      return new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } });
    });
    await dispatchVideoReplicate({ apiKey: 'k', prompt: 'x', ...(model ? { model } : {}), ...(generateAudio != null ? { generateAudio } : {}) });
    return JSON.parse(String((calls[0]!.init as RequestInit).body)).input;
  };

  it('the predicate matches the Veo-3 family only', () => {
    expect(isAudioCapableVideoModel('google/veo-3-fast')).toBe(true);
    expect(isAudioCapableVideoModel('google/veo-3.1')).toBe(true);
    expect(isAudioCapableVideoModel('kwaivgi/kling-v2')).toBe(false);
    expect(isAudioCapableVideoModel('luma/ray')).toBe(false);
  });

  it('forwards generate_audio for a Veo model (both true and the load-bearing false)', async () => {
    expect(await audioInput(undefined, false)).toMatchObject({ generate_audio: false }); // default model is veo-3-fast
    expect(await audioInput('google/veo-3.1', true)).toMatchObject({ generate_audio: true });
  });

  it('NEVER forwards generate_audio to a non-Veo model (avoids Replicate 422), and omits it when unset', async () => {
    expect(await audioInput('kwaivgi/kling-v2', true)).not.toHaveProperty('generate_audio');
    expect(await audioInput(undefined, undefined)).not.toHaveProperty('generate_audio'); // unset ⇒ upstream default
  });

  it('polls a non-terminal prediction to success (api.replicate.com only)', async () => {
    let polls = 0;
    fakeFetch((url) => {
      if (url.endsWith('/predictions')) {
        return json({ id: 'v2', status: 'processing', urls: { get: 'https://api.replicate.com/v1/predictions/v2' } });
      }
      if (url === 'https://api.replicate.com/v1/predictions/v2') {
        polls += 1;
        return polls < 2
          ? json({ id: 'v2', status: 'processing', urls: { get: 'https://api.replicate.com/v1/predictions/v2' } })
          : json({ id: 'v2', status: 'succeeded', output: 'https://replicate.delivery/pbxt/x/two.mp4' });
      }
      return new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } });
    });
    const video = await dispatchVideoReplicate({ apiKey: 'k', prompt: 'x' });
    expect(polls).toBe(2);
    expect(video.mimeType).toBe('video/mp4');
  }, 15_000);

  it('a failed prediction is a typed plain-Error (reason surfaced, key never echoed)', async () => {
    fakeFetch(() => json({ id: 'v3', status: 'failed', error: 'content policy' }));
    await expect(dispatchVideoReplicate({ apiKey: 'r8_secret', prompt: 'x' }))
      .rejects.toThrow(/replicate_failed: content policy/);
  });

  it('REJECTS an output URL off the allowlist (SSRF pin) without fetching it', async () => {
    const { calls } = fakeFetch(() => json({ status: 'succeeded', output: 'https://169.254.169.254/latest/meta-data' }));
    await expect(dispatchVideoReplicate({ apiKey: 'k', prompt: 'x' }))
      .rejects.toThrow(/replicate_output_host_denied/);
    expect(calls.some((c) => c.url.includes('169.254'))).toBe(false);
  });

  it('rejects a malformed model id before any network call', async () => {
    const { calls } = fakeFetch(() => json({}));
    await expect(dispatchVideoReplicate({ apiKey: 'k', prompt: 'x', model: '../evil?x=1' }))
      .rejects.toThrow(/replicate_bad_model/);
    expect(calls.length).toBe(0);
  });

  it('an aborted signal surfaces as AbortError during the poll wait', async () => {
    const ac = new AbortController();
    fakeFetch((url) => {
      if (url.endsWith('/predictions')) {
        ac.abort();
        return json({ status: 'processing', urls: { get: 'https://api.replicate.com/v1/predictions/v4' } });
      }
      return json({ status: 'processing', urls: { get: 'https://api.replicate.com/v1/predictions/v4' } });
    });
    await expect(dispatchVideoReplicate({ apiKey: 'k', prompt: 'x', signal: ac.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a 404/422 on the model endpoint names the model + the override (rotation guard)', async () => {
    fakeFetch(() => new Response('not found', { status: 404 }));
    await expect(dispatchVideoReplicate({ apiKey: 'k', prompt: 'x', model: 'owner/sunset-video' }))
      .rejects.toThrow(/replicate_model_unavailable_404: video model "owner\/sunset-video" is unavailable.*override/);
    fakeFetch(() => new Response('unprocessable', { status: 422 }));
    await expect(dispatchVideoReplicate({ apiKey: 'k', prompt: 'x' }))
      .rejects.toThrow(/replicate_model_unavailable_422/);
  });

  it('the curated default video model is the pinned rotation surface (Veo 3, well-formed owner/name)', () => {
    expect(DEFAULT_REPLICATE_VIDEO_MODEL).toMatch(/^[\w.-]+\/[\w.-]+$/);
    // A change here should be deliberate — pin the current Veo-3 steer.
    expect(DEFAULT_REPLICATE_VIDEO_MODEL).toBe('google/veo-3-fast');
  });

  describe('output cap enforced DURING download (grade-code VID-2)', () => {
    afterEach(() => { delete process.env.OPENWOP_VIDEO_MAX_BYTES; });

    it('rejects a declared-oversized content-length up front (no full buffer)', async () => {
      process.env.OPENWOP_VIDEO_MAX_BYTES = '8';
      fakeFetch((url) => {
        if (url.includes('/models/')) return json({ status: 'succeeded', output: 'https://replicate.delivery/x/big.mp4' });
        return new Response(Buffer.alloc(64), { status: 200, headers: { 'content-type': 'video/mp4' } }); // Response sets content-length: 64 > 8
      });
      await expect(dispatchVideoReplicate({ apiKey: 'k', prompt: 'x' })).rejects.toThrow(/replicate_output_too_large/);
    });

    it('aborts the streamed read the instant the running total crosses the cap (no content-length)', async () => {
      process.env.OPENWOP_VIDEO_MAX_BYTES = '8';
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(6)); }, // 6 bytes per pull → exceeds 8 on the 2nd
        cancel() { cancelled = true; },
      });
      fakeFetch((url) => {
        if (url.includes('/models/')) return json({ status: 'succeeded', output: 'https://replicate.delivery/x/stream.mp4' });
        return new Response(stream, { status: 200, headers: { 'content-type': 'video/mp4' } }); // a stream body carries NO content-length
      });
      await expect(dispatchVideoReplicate({ apiKey: 'k', prompt: 'x' })).rejects.toThrow(/replicate_output_too_large/);
      expect(cancelled).toBe(true); // the reader cancelled the stream instead of draining it
    });

    it('a body within the cap still returns the exact bytes', async () => {
      process.env.OPENWOP_VIDEO_MAX_BYTES = String(1024 * 1024);
      fakeFetch((url) => {
        if (url.includes('/models/')) return json({ status: 'succeeded', output: 'https://replicate.delivery/x/ok.mp4' });
        return new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } });
      });
      const video = await dispatchVideoReplicate({ apiKey: 'k', prompt: 'x' });
      expect(video).toEqual({ base64: MP4_BYTES.toString('base64'), mimeType: 'video/mp4', sizeBytes: MP4_BYTES.byteLength });
    });
  });
});
