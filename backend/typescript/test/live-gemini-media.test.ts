/**
 * GATED live verification of the media→text dispatch path (ADR 0108/0110). Runs ONLY when
 * GEMINI_LIVE_KEY is set; otherwise skipped — so it stays dormant in normal CI but lets
 * anyone re-verify the live path after a Gemini API change with:
 *   GEMINI_LIVE_KEY=<key> [GEMINI_LIVE_MODEL=gemini-3.1-flash-lite] \
 *     node node_modules/vitest/vitest.mjs run test/live-gemini-media.test.ts
 * It hits the real Gemini endpoint through OUR dispatchChat (the same path the KB media
 * ingest uses), proving text + multimodal vision-input work end-to-end against the model.
 */
import { describe, expect, it } from 'vitest';
import { dispatchChat } from '../src/providers/dispatch.js';

const KEY = process.env.GEMINI_LIVE_KEY ?? '';
const MODEL = process.env.GEMINI_LIVE_MODEL ?? 'gemini-2.5-flash';
const run = KEY ? describe : describe.skip;
// A valid 2×2 PNG — enough to prove the vision-input (inlineData) path is accepted live.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP8z8Dwn4EIwAgAJiQDwbV4kAYAAAAASUVORK5CYII=';

run(`LIVE Gemini media path (${MODEL})`, () => {
  it('text completion works through our dispatch (key + model + dispatchGoogle live)', async () => {
    const r = await dispatchChat({
      provider: 'google', model: MODEL, apiKey: KEY,
      messages: [{ role: 'user', content: 'Reply with exactly the single word: WORKING' }],
      maxTokens: 32,
    });
    expect(r.completion.toUpperCase()).toContain('WORKING');
  }, 30000);

  it('vision input (image inlineData) is accepted live through our dispatch', async () => {
    const r = await dispatchChat({
      provider: 'google', model: MODEL, apiKey: KEY,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Reply OK if you can see an image.' },
        { type: 'image', mimeType: 'image/png', dataBase64: TINY_PNG },
      ] }],
      maxTokens: 32,
    });
    expect(r.completion.trim().length).toBeGreaterThan(0); // model processed the image, no 4xx
  }, 30000);

  it('long audio (>15 MiB) goes through the Gemini File API end-to-end (ADR 0111)', async () => {
    // ~200 s of silent 16-bit/44.1k mono WAV ≈ 17.6 MiB — over the inline limit, so
    // dispatchGoogle uploads it via the File API. We assert it completes (silence ⇒ the
    // transcript may be empty); the point is the upload → ACTIVE → fileData path works live.
    const wav = silentWav(200);
    expect(wav.length).toBeGreaterThan(15 * 1024 * 1024);
    const r = await dispatchChat({
      provider: 'google', model: MODEL, apiKey: KEY,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Transcribe any speech in this audio. If silent, reply: SILENT.' },
        { type: 'audio', mimeType: 'audio/wav', dataBase64: wav.toString('base64') },
      ] }],
      maxTokens: 64,
    });
    expect(typeof r.completion).toBe('string'); // no throw ⇒ upload + poll + fileData succeeded
  }, 120000);
});

/** A silent 16-bit PCM mono WAV of `seconds` — a real, large audio file with no deps. */
function silentWav(seconds: number, sampleRate = 44100): Buffer {
  const dataSize = seconds * sampleRate * 2;
  const buf = Buffer.alloc(44 + dataSize); // samples default to 0 (silence)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  return buf;
}
