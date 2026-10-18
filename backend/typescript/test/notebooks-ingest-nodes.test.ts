/**
 * feature.notebooks.nodes — the audio/video + YouTube source-ingest nodes (ADR 0085
 * Phases 3–5): `transcribe-source` (ctx.callAI audio part), `fetch-youtube-source`
 * (ctx.http.safeFetch caption track), and `ingest-source` (the surface write).
 *
 * Pure node-fn unit test against a MOCK ctx — asserts the pack's own contract
 * (audio part shape, caption parsing + no_transcript, no-op short-circuits, surface
 * write) without the host surface (covered elsewhere). `safeFetch` returns REAL
 * `Response` objects, so `readBodyCapped` runs the same `body.getReader()` stream
 * branch (the MEDIA-4 byte cap) it runs against undici in production.
 *
 * What reds it (sabotage-witnessed, /grade-tests wave 20): the audio part's
 * `dataBase64` key; the empty-audio short-circuit; the 32 MiB cap; entity decoding;
 * the no-captions branch; the lowest-bitrate stream pick; the nested
 * `playerCaptionsTracklistRenderer` fallback; the `ctx.callAI`-absent guard; the
 * sourceType title weave; the empty-text no-op.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
import * as pack from '../../../packs/feature.notebooks.nodes/index.mjs';

type ContentPart = { type: string; text?: string; mimeType?: string; dataBase64?: string };
type CallAIRequest = { provider: string; model: string; messages: Array<{ role: string; content: ContentPart[] }> };

const audioPartOf = (req: CallAIRequest | undefined): ContentPart | undefined =>
  req?.messages[0]?.content.find((p) => p.type === 'audio');

/** A text body the way undici hands it back: a real `Response` with a stream body. */
const textRes = (body: string, status = 200): Response => new Response(body, { status });

describe('feature.notebooks.nodes — transcribe-source (ADR 0085)', () => {
  it('feeds an audio ContentPart to ctx.callAI and returns the transcript', async () => {
    let seen: CallAIRequest | undefined;
    const ctx = {
      inputs: { audioBase64: 'QUJD', mimeType: 'audio/mpeg', language: 'en' },
      config: { provider: 'google', model: 'gemini-2.5-flash' },
      callAI: async (req: CallAIRequest) => { seen = req; return { content: '  Hello world.  ' }; },
    };
    const out = await pack.transcribeSource(ctx);
    expect(out.status).toBe('success');
    expect(out.outputs.transcript).toBe('Hello world.');
    expect(out.outputs.empty).toBe(false);
    // The audio part is shaped per RFC 0091 (type:'audio' + dataBase64 + mimeType).
    expect(audioPartOf(seen)).toEqual({ type: 'audio', mimeType: 'audio/mpeg', dataBase64: 'QUJD' });
    expect(seen?.provider).toBe('google');
  });

  it('short-circuits empty audio to a no-op (no model call)', async () => {
    let called = false;
    const ctx = { inputs: { audioBase64: '   ' }, config: {}, callAI: async () => { called = true; return { content: 'x' }; } };
    const out = await pack.transcribeSource(ctx);
    expect(out.outputs.empty).toBe(true);
    expect(called).toBe(false);
  });
});

describe('feature.notebooks.nodes — fetch-youtube-source (ADR 0085)', () => {
  const page = (captionsJson: string) => `<html>"captionTracks":${captionsJson}</html>`;
  const timedtext = '<transcript><text start="0">Hello &amp; welcome</text><text start="2">to the show</text></transcript>';

  it('extracts the caption track via ctx.http.safeFetch and joins the text', async () => {
    const ctx = {
      inputs: { url: 'https://www.youtube.com/watch?v=abc' },
      http: {
        safeFetch: async (url: string) => url.includes('timedtext')
          ? textRes(timedtext)
          : textRes(page('[{"baseUrl":"https://youtube.com/api/timedtext?v=abc"}]')),
      },
    };
    const out = await pack.fetchYoutubeSource(ctx);
    expect(out.outputs.transcript).toBe('Hello & welcome\nto the show');
    expect(out.outputs.empty).toBe(false);
  });

  it('throws no_transcript when no captions AND no transcription host', async () => {
    // The page DOES carry a directly-fetchable audio stream, so the only thing that
    // can refuse here is the missing `ctx.callAI` (the "no transcription host" leg) —
    // not the "no stream" throw two lines later.
    const player = JSON.stringify({ streamingData: { adaptiveFormats: [
      { mimeType: 'audio/webm; codecs="opus"', url: 'https://r1.googlevideo.com/audio-lo', bitrate: 60000 },
    ] } });
    const ctx = {
      inputs: { url: 'https://youtu.be/abc' },
      http: { safeFetch: async () => textRes(`<html><script>var ytInitialPlayerResponse = ${player};</script></html>`) },
    };
    await expect(pack.fetchYoutubeSource(ctx)).rejects.toMatchObject({
      code: 'no_transcript',
      message: expect.stringMatching(/transcription is unavailable/),
    });
  });

  it('falls back to STT over a directly-fetchable audio stream when no captions', async () => {
    const player = JSON.stringify({ streamingData: { adaptiveFormats: [
      { mimeType: 'audio/mp4; codecs="mp4a.40.2"', url: 'https://r1.googlevideo.com/audio', bitrate: 130000 },
      { mimeType: 'audio/webm; codecs="opus"', url: 'https://r1.googlevideo.com/audio-lo', bitrate: 60000 },
    ] } });
    const html = `<html><script>var ytInitialPlayerResponse = ${player};</script></html>`;
    let calledAI: CallAIRequest | undefined;
    const fetched: string[] = [];
    const ctx = {
      inputs: { url: 'https://www.youtube.com/watch?v=abc' },
      config: { provider: 'google', model: 'gemini-2.5-flash' },
      http: {
        safeFetch: async (u: string) => {
          fetched.push(u);
          return u.includes('googlevideo')
            ? new Response(new TextEncoder().encode('audiobts'), { status: 200, headers: { 'content-length': '8' } })
            : textRes(html);
        },
      },
      callAI: async (req: CallAIRequest) => { calledAI = req; return { content: 'Transcribed from the audio.' }; },
    };
    const out = await pack.fetchYoutubeSource(ctx);
    expect(out.outputs.transcript).toBe('Transcribed from the audio.');
    expect(out.outputs.source).toBe('stt');
    // It picked the LOWER-bitrate stream (cheapest to transcribe) and sent ITS bytes as an audio part.
    expect(fetched).toContain('https://r1.googlevideo.com/audio-lo');
    expect(audioPartOf(calledAI)).toEqual({ type: 'audio', mimeType: 'audio/webm', dataBase64: Buffer.from('audiobts').toString('base64') });
  });
});

describe('feature.notebooks.nodes — ingest-source (ADR 0084 deferred / 0085)', () => {
  it('writes the transcript through ctx.features.notebooks.ingestSource', async () => {
    let seen: { notebookId: string; title: string; text: string } | undefined;
    const ctx = {
      inputs: { notebookId: 'nb1', title: 'My recording', sourceType: 'audio', text: 'transcribed words' },
      features: { notebooks: { ingestSource: async (a: { notebookId: string; title: string; text: string }) => { seen = a; return { ingested: true, sourceId: 's1', title: a.title }; } } },
    };
    const out = await pack.ingestSource(ctx);
    expect(out.outputs.ingested).toBe(true);
    expect(out.outputs.sourceId).toBe('s1');
    expect(seen).toEqual({ notebookId: 'nb1', title: 'My recording (audio)', text: 'transcribed words' }); // sourceType woven into the title
  });

  it('is a no-op for empty text', async () => {
    let called = false;
    const ctx = {
      inputs: { notebookId: 'nb1', title: 'x', text: '   ' },
      features: { notebooks: { ingestSource: async () => { called = true; return { ingested: true }; } } },
    };
    const out = await pack.ingestSource(ctx);
    expect(out.outputs.ingested).toBe(false);
    expect(called).toBe(false);
  });
});

describe('feature.notebooks.nodes — hardening (ADR 0085)', () => {
  it('transcribe-source rejects oversize audio up front (no doomed model call)', async () => {
    let called = false;
    // > 32 MiB decoded ⇒ > ~44.7M base64 chars. The cap check is on length (no decode).
    const huge = 'A'.repeat(45_000_000);
    const ctx = { inputs: { audioBase64: huge, mimeType: 'audio/mpeg' }, config: {}, callAI: async () => { called = true; return { content: 'x' }; } };
    await expect(pack.transcribeSource(ctx)).rejects.toMatchObject({ code: 'audio_too_large' });
    expect(called).toBe(false);
  });

  it('fetch-youtube-source finds captions nested in ytInitialPlayerResponse (no literal captionTracks)', async () => {
    // Pretty-printed (`"captionTracks": [` — a space after the colon), so the literal
    // `"captionTracks":[…]` regex does NOT match and ONLY the brace-matched
    // player-response parse can find the track. A compact `JSON.stringify` here
    // matched the literal regex and left the nested path untested (wave-20 probe).
    const player = JSON.stringify({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://youtube.com/api/timedtext?v=z' }] } } }, null, 1);
    const html = `<html><script>var ytInitialPlayerResponse = ${player};</script></html>`;
    expect(html).not.toMatch(/"captionTracks":\[/);
    const timedtext = '<transcript><text start="0">Nested caption works</text></transcript>';
    const ctx = {
      inputs: { url: 'https://www.youtube.com/watch?v=z' },
      http: { safeFetch: async (u: string) => u.includes('timedtext') ? textRes(timedtext) : textRes(html) },
    };
    const out = await pack.fetchYoutubeSource(ctx);
    expect(out.outputs.transcript).toBe('Nested caption works');
    expect(out.outputs.source).toBe('captions');
  });
});
