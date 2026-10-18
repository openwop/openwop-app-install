/**
 * Voice API failures must carry the host's error envelope.
 *
 * Regression: `ok()` read `body.error.code` / `body.error.message`, but the canonical
 * envelope (rest-endpoints.md §"Error envelope", ADR 0143) is FLAT —
 * `{ error: "<code>", message, details? }` — so `error` is a string and both reads were
 * `undefined`. Every backend code/message was dropped in favour of `http_<status>`,
 * which made `useVoiceMode`'s `transcription_unsupported` / `speech_synthesis_unsupported`
 * branches unreachable and reduced a realtime mint failure to "failed (400)".
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { openRealtimeSession, commitVoiceTurn, VoiceApiError } from '../voiceClient.js';

/** The rejection, proven to BE a VoiceApiError (no cast; a resolved call fails here). */
async function rejection(p: Promise<unknown>): Promise<VoiceApiError> {
  const e: unknown = await p.then(() => new Error('expected a rejection, the call resolved'), (x: unknown) => x);
  if (!(e instanceof VoiceApiError)) throw new Error(`expected a VoiceApiError, got ${String(e)}`);
  return e;
}

function mockFetchOnce(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('voiceClient error envelopes', () => {
  it('surfaces the flat envelope code + message from a realtime mint failure', async () => {
    mockFetchOnce(400, {
      error: 'credential_unavailable',
      message: 'The realtime voice provider key could not be resolved.',
      details: { provider: 'gemini-live' },
    });

    const err = await rejection(openRealtimeSession({}));
    expect(err.code).toBe('credential_unavailable');
    expect(err.message).toBe('The realtime voice provider key could not be resolved.');
    expect(err.status).toBe(400);
  });

  it('preserves the codes useVoiceMode branches on', async () => {
    mockFetchOnce(400, { error: 'transcription_unsupported', message: 'No STT provider is configured.' });

    const err = await rejection(commitVoiceTurn('s1'));
    expect(err.code).toBe('transcription_unsupported');
    expect(err.message).toBe('No STT provider is configured.');
    expect(err.status).toBe(400);
  });

  it('falls back to the status when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })));

    const err = await rejection(openRealtimeSession({}));
    expect(err.code).toBe('http_502');
    expect(err.message).toBe('openRealtimeSession failed (502)');
    expect(err.status).toBe(502);
  });

  // Twin: src/client/__tests__/errorEnvelope.test.ts › "tolerates the legacy nested
  // `error.code`" covers the shared reader; this case pins that voiceClient still
  // routes through it (kept: protected failure-honesty file, wave 44 ruling 2).
  it('still reads a nested error object from an older peer', async () => {
    mockFetchOnce(403, { error: { code: 'forbidden', message: 'Not allowed.' } });

    const err = await rejection(openRealtimeSession({}));
    expect(err.code).toBe('forbidden');
    expect(err.message).toBe('Not allowed.');
    expect(err.status).toBe(403);
  });

  it('returns null (walkie fallback) when no realtime provider is configured', async () => {
    mockFetchOnce(200, { realtime: null });
    await expect(openRealtimeSession({})).resolves.toBeNull();
  });
});
