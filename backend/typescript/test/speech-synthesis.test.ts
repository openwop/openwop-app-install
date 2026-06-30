/**
 * RFC 0105 — speech-synthesis (text-to-speech) unit coverage for the
 * `dispatchSpeech` helpers.
 *
 * The canonical TTS surface is the `ai/call-speech-synthesizer` seam
 * (`test/speech-synthesis-seam.test.ts`); the legacy `media/synthesize` demo
 * route was retired (MEDIA-6 / ADR 0085 OQ-5), so its route cases moved out with
 * it. What remains here are the pure conversions that surface had relied on:
 *   - the MiniMax hex→base64 audio-payload conversion (`hexToBase64`);
 *   - opaque-voiceId → real-provider-voice resolution (`resolveMiniMaxVoice`).
 */

import { describe, expect, it } from 'vitest';
import { hexToBase64, resolveMiniMaxVoice } from '../src/providers/dispatchSpeech.js';

describe('RFC 0105 speech synthesis (dispatchSpeech helpers)', () => {
  it('dispatchSpeech: hex-decodes a MiniMax audio payload to base64', () => {
    // "ID3" (MP3 tag) bytes: 0x49 0x44 0x33 → base64 "SUQz".
    expect(hexToBase64('494433')).toBe('SUQz');
    // Round-trip an arbitrary buffer through hex → base64.
    const raw = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]);
    const hex = raw.toString('hex');
    expect(hexToBase64(hex)).toBe(raw.toString('base64'));
  });

  it('resolveMiniMaxVoice: known voices pass through, opaque ids resolve to a real default', () => {
    // A known MiniMax system voice passes through verbatim.
    expect(resolveMiniMaxVoice('male-qn-qingse')).toBe('male-qn-qingse');
    expect(resolveMiniMaxVoice('English_expressive_narrator')).toBe('English_expressive_narrator');
    // An opaque/host-resolved id (RFC 0105 §A) maps to a real default voice.
    expect(resolveMiniMaxVoice('host:narrator-test')).toBe('male-qn-qingse');
    expect(resolveMiniMaxVoice('whatever-unknown')).toBe('male-qn-qingse');
  });
});
