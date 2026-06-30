/**
 * Multi-speaker podcasts (ADR 0086) — audio mux + speech-provider dispatch helpers.
 * Pure unit tests (no network): the MP3/WAV concatenation contract, the WAV header
 * wrap, and the opaque-voiceId → provider-voice resolution for the three TTS
 * providers (MiniMax managed; OpenAI + Google BYOK). Anthropic has NO TTS API and is
 * deliberately absent from the speech path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { muxAudioClips } from '../src/features/podcasts/audioMux.js';
import {
  resolveOpenAIVoice, resolveGoogleVoice, resolveMiniMaxVoice, pcmToWav,
  dispatchSpeechMiniMax, dispatchSpeechOpenAI, dispatchSpeechGoogle,
} from '../src/providers/dispatchSpeech.js';

const b64 = (s: string): string => Buffer.from(s).toString('base64');

describe('podcasts — audio mux (ADR 0086 §mix)', () => {
  it('byte-concatenates homogeneous MP3 clips', () => {
    const out = muxAudioClips([
      { contentBase64: b64('AAA'), contentType: 'audio/mpeg' },
      { contentBase64: b64('BBB'), contentType: 'audio/mpeg' },
    ]);
    expect(out).not.toBeNull();
    expect(out!.contentType).toBe('audio/mpeg');
    expect(Buffer.from(out!.contentBase64, 'base64').toString()).toBe('AAABBB');
  });

  it('strips + re-wraps homogeneous WAV clips into one valid container', () => {
    // Two 1-sample WAVs (44-byte header + 2 bytes PCM each) at 24 kHz.
    const w1 = pcmToWav(b64('\x01\x02'), 24000);
    const w2 = pcmToWav(b64('\x03\x04'), 24000);
    const out = muxAudioClips([
      { contentBase64: w1, contentType: 'audio/wav' },
      { contentBase64: w2, contentType: 'audio/wav' },
    ]);
    expect(out).not.toBeNull();
    expect(out!.contentType).toBe('audio/wav');
    const buf = Buffer.from(out!.contentBase64, 'base64');
    expect(buf.subarray(0, 4).toString()).toBe('RIFF');
    // 44-byte header + 4 bytes of concatenated PCM.
    expect(buf.length).toBe(48);
    expect(buf.readUInt32LE(40)).toBe(4); // data chunk size = 2 + 2
  });

  it('returns null for MIXED codecs (caller keeps the playlist)', () => {
    expect(muxAudioClips([
      { contentBase64: b64('A'), contentType: 'audio/mpeg' },
      { contentBase64: b64('B'), contentType: 'audio/wav' },
    ])).toBeNull();
  });

  it('passes a single clip through unchanged', () => {
    const out = muxAudioClips([{ contentBase64: b64('solo'), contentType: 'audio/mpeg' }]);
    expect(out).toEqual({ contentBase64: b64('solo'), contentType: 'audio/mpeg' });
  });

  it('strips a leading ID3v2 tag from MP3 clips after the first (hardening)', () => {
    // clip2 carries a 13-byte ID3v2 tag ('ID3' + ver + flags + synchsafe size=3 + 'TAG') then 'BBB'.
    const id3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0, 0, 0, 3]), Buffer.from('TAG'), Buffer.from('BBB')]);
    const out = muxAudioClips([
      { contentBase64: b64('AAA'), contentType: 'audio/mpeg' },
      { contentBase64: id3.toString('base64'), contentType: 'audio/mpeg' },
    ]);
    expect(out).not.toBeNull();
    // The 2nd clip's ID3 tag is stripped; the first clip's bytes are untouched.
    expect(Buffer.from(out!.contentBase64, 'base64').toString()).toBe('AAABBB');
  });
});

describe('podcasts — speech provider voice resolution', () => {
  it('OpenAI: known voice passes, unknown → default alloy', () => {
    expect(resolveOpenAIVoice('nova')).toBe('nova');
    expect(resolveOpenAIVoice('host:whatever')).toBe('alloy');
  });
  it('Google: known voice passes, unknown → default Kore', () => {
    expect(resolveGoogleVoice('Puck')).toBe('Puck');
    expect(resolveGoogleVoice('opaque-id')).toBe('Kore');
  });
  it('MiniMax: known voice passes, unknown → default', () => {
    expect(resolveMiniMaxVoice('Wise_Woman')).toBe('Wise_Woman');
    expect(resolveMiniMaxVoice('host:x')).toBe('male-qn-qingse');
  });
  it('pcmToWav prepends a valid 44-byte RIFF/WAVE header', () => {
    const wav = Buffer.from(pcmToWav(b64('abcd'), 24000), 'base64');
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav.length).toBe(44 + 4);
  });
});

describe('podcasts — speech dispatch threads the abort signal (MEDIA-3)', () => {
  afterEach(() => vi.restoreAllMocks());

  // A minimal OK response shaped per provider, capturing the fetch init.
  const stubFetch = (json: unknown, bytes?: Uint8Array) => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push(init);
      return {
        ok: true,
        status: 200,
        json: async () => json,
        text: async () => '',
        arrayBuffer: async () => (bytes ?? new Uint8Array([1, 2, 3])).buffer,
      } as unknown as Response;
    });
    return calls;
  };

  it('MiniMax forwards the signal to fetch', async () => {
    const calls = stubFetch({ data: { audio: '0102' } });
    const signal = new AbortController().signal;
    await dispatchSpeechMiniMax({ apiKey: 'k', text: 'hi', voiceId: 'Wise_Woman', signal });
    expect(calls[0]?.signal).toBe(signal);
  });

  it('OpenAI forwards the signal to fetch', async () => {
    const calls = stubFetch({}, new Uint8Array([9, 9, 9]));
    const signal = new AbortController().signal;
    await dispatchSpeechOpenAI({ apiKey: 'k', text: 'hi', voiceId: 'alloy', signal });
    expect(calls[0]?.signal).toBe(signal);
  });

  it('Google forwards the signal to fetch', async () => {
    const calls = stubFetch({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: b64('ab') } }] } }] });
    const signal = new AbortController().signal;
    await dispatchSpeechGoogle({ apiKey: 'k', text: 'hi', voiceId: 'Kore', signal });
    expect(calls[0]?.signal).toBe(signal);
  });

  it('omits signal cleanly when none is supplied (no regression)', async () => {
    const calls = stubFetch({ data: { audio: '0102' } });
    await dispatchSpeechMiniMax({ apiKey: 'k', text: 'hi', voiceId: 'Wise_Woman' });
    expect(calls[0]?.signal).toBeUndefined();
  });
});
