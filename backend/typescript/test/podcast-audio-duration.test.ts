/**
 * R2 PR2-1 (UX_UPGRADE-podcasts) — the duration estimator. Exactness matters
 * on WAV (header math); MP3 is a frame walk. A wrong duration is worse than a
 * missing one, so garbage MUST return null, never a number.
 */
import { describe, expect, it } from 'vitest';
import { estimateAudioDurationSeconds } from '../src/features/podcasts/audioDuration.js';

/** A canonical 44-byte-header WAV: `seconds` of silence at the given rates. */
function syntheticWav(seconds: number, sampleRate = 16_000, bytesPerSample = 2): Buffer {
  const byteRate = sampleRate * bytesPerSample;
  const dataSize = Math.round(seconds * byteRate);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);           // fmt chunk size
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(1, 22);            // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(bytesPerSample, 32);
  buf.writeUInt16LE(bytesPerSample * 8, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

/** A CBR MPEG1 Layer III stream: `frames` frames at 128 kbps / 44100 Hz. */
function syntheticMp3(frames: number): Buffer {
  const frameBytes = Math.floor((1152 / 8) * 128_000 / 44_100); // 417, no padding
  const frame = Buffer.alloc(frameBytes);
  frame[0] = 0xff; frame[1] = 0xfb;    // sync + MPEG1 Layer III, no CRC
  frame[2] = 0x90;                     // bitrate idx 9 (128k), sample idx 0 (44100), no padding
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

describe('estimateAudioDurationSeconds', () => {
  it('WAV: exact from the header (127s of 16kHz/16-bit mono)', () => {
    expect(estimateAudioDurationSeconds(syntheticWav(127), 'audio/wav')).toBe(127);
  });
  it('MP3: frame walk over a CBR stream (100 frames ≈ 3s at 44.1kHz)', () => {
    const d = estimateAudioDurationSeconds(syntheticMp3(100), 'audio/mpeg');
    expect(d).toBe(Math.round(100 * 1152 / 44_100)); // 3
  });
  it('MP3 with a leading ID3v2 tag still measures', () => {
    const id3 = Buffer.alloc(10 + 64);
    id3.write('ID3', 0, 'latin1'); id3[9] = 64; // synchsafe size 64
    const d = estimateAudioDurationSeconds(Buffer.concat([id3, syntheticMp3(200)]), 'audio/mpeg');
    expect(d).toBe(Math.round(200 * 1152 / 44_100)); // 5
  });
  it('garbage returns NULL, never a number (a wrong duration is worse than none)', () => {
    expect(estimateAudioDurationSeconds(Buffer.alloc(4096, 7), 'audio/mpeg')).toBeNull();
    expect(estimateAudioDurationSeconds(Buffer.alloc(4096, 7), 'audio/wav')).toBeNull();
    expect(estimateAudioDurationSeconds(syntheticWav(10), 'video/mp4')).toBeNull();
  });
});

describe('review F1 — non-canonical WAV headers (the fixed-offset trap)', () => {
  it('an 18-byte-fmt WAV (WAVE_FORMAT_EXTENSIBLE shape) measures CORRECTLY, not ~33 hours', () => {
    // 10s at 16kHz/16-bit mono, but with an 18-byte fmt chunk: `data` no
    // longer sits at offset 36. Fixed-offset math measured this at ~118,489s.
    const byteRate = 32_000;
    const dataSize = 10 * byteRate;
    const buf = Buffer.alloc(12 + 8 + 18 + 8 + dataSize);
    buf.write('RIFF', 0, 'latin1'); buf.writeUInt32LE(buf.length - 8, 4); buf.write('WAVE', 8, 'latin1');
    buf.write('fmt ', 12, 'latin1'); buf.writeUInt32LE(18, 16);
    buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(16_000, 24); buf.writeUInt32LE(byteRate, 28);
    buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.writeUInt16LE(0, 36); // cbSize=0
    buf.write('data', 38, 'latin1'); buf.writeUInt32LE(dataSize, 42);
    expect(estimateAudioDurationSeconds(buf, 'audio/wav')).toBe(10);
  });

  it('a WAV whose chunks never include data returns null (never a guess)', () => {
    const buf = Buffer.alloc(64);
    buf.write('RIFF', 0, 'latin1'); buf.writeUInt32LE(56, 4); buf.write('WAVE', 8, 'latin1');
    buf.write('LIST', 12, 'latin1'); buf.writeUInt32LE(44, 16);
    expect(estimateAudioDurationSeconds(buf, 'audio/wav')).toBeNull();
  });
});
