/**
 * R2 PR2-1 / SP-4 (UX_UPGRADE-podcasts) — duration at INGEST, without ffmpeg.
 *
 * `itunes:duration` is a required episode tag every leader derives at upload;
 * this host's `FeedItemInput.durationSeconds` had ZERO callers — no feed ever
 * carried one. This measures the two containers the synthesize pipeline
 * actually produces (the audioMux contract):
 *
 *   - `audio/wav` — exact: the 44-byte canonical header carries byteRate at
 *     offset 28 and the data-chunk size at offset 40.
 *   - `audio/mpeg` — an MPEG-frame WALK (skip ID3v2, parse each frame header,
 *     sum samples/sampleRate). Exact for CBR (what MiniMax/OpenAI TTS emit)
 *     and correct for VBR too, since every frame is visited.
 *
 * Returns null on anything it cannot parse confidently — a missing duration
 * is honest; a wrong one is not. Pure + dependency-free (testable in isolation).
 */

const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44_100, 48_000, 32_000], // MPEG1
  2: [22_050, 24_000, 16_000], // MPEG2
  0: [11_025, 12_000, 8_000],  // MPEG2.5
};

function id3v2Size(buf: Buffer): number {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  // 4 synchsafe bytes after 'ID3' + version(2) + flags(1); +10 for the header itself.
  return 10 + ((buf[6]! & 0x7f) << 21 | (buf[7]! & 0x7f) << 14 | (buf[8]! & 0x7f) << 7 | (buf[9]! & 0x7f));
}

function mp3DurationSeconds(buf: Buffer): number | null {
  let i = id3v2Size(buf);
  let seconds = 0;
  let frames = 0;
  while (i + 4 <= buf.length) {
    // Frame sync: 11 set bits.
    if (buf[i] !== 0xff || (buf[i + 1]! & 0xe0) !== 0xe0) {
      // Resync only before the first valid frame (leading junk); after that,
      // trailing garbage (an ID3v1 tag is 'TAG'+125 bytes) ends the walk.
      if (frames === 0) { i += 1; continue; }
      break;
    }
    const versionBits = (buf[i + 1]! >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layerBits = (buf[i + 1]! >> 1) & 0x03;   // 1=Layer III
    if (versionBits === 1 || layerBits !== 1) { if (frames === 0) { i += 1; continue; } break; }
    const bitrateIdx = (buf[i + 2]! >> 4) & 0x0f;
    const sampleIdx = (buf[i + 2]! >> 2) & 0x03;
    const padding = (buf[i + 2]! >> 1) & 0x01;
    const bitrateKbps = (versionBits === 3 ? MPEG1_BITRATES : MPEG2_BITRATES)[bitrateIdx]!;
    const sampleRate = SAMPLE_RATES[versionBits]?.[sampleIdx];
    if (!bitrateKbps || !sampleRate) { if (frames === 0) { i += 1; continue; } break; }
    const samplesPerFrame = versionBits === 3 ? 1152 : 576;
    const frameBytes = Math.floor((samplesPerFrame / 8) * (bitrateKbps * 1000) / sampleRate) + padding;
    if (frameBytes <= 4) break;
    seconds += samplesPerFrame / sampleRate;
    frames += 1;
    i += frameBytes;
  }
  return frames > 0 ? seconds : null;
}

function wavDurationSeconds(buf: Buffer): number | null {
  // Review F1 — NEVER trust fixed offsets: the mux pipeline writes canonical
  // 44-byte headers, but `recordEpisodeResult` accepts any workflow node's
  // audioMediaRef, and an 18-byte-fmt WAV (WAVE_FORMAT_EXTENSIBLE — typical
  // ffmpeg output) read at fixed offsets measured ~33 HOURS for a 10-second
  // file. Walk the RIFF chunks to find `fmt ` and `data` wherever they are.
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  let dataSize = 0;
  let i = 12;
  while (i + 8 <= buf.length) {
    const id = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === 'fmt ' && size >= 16 && i + 8 + 16 <= buf.length) byteRate = buf.readUInt32LE(i + 8 + 8);
    if (id === 'data') { dataSize = size; break; } // audio payload — stop walking
    i += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (byteRate <= 0 || dataSize <= 0) return null;
  return dataSize / byteRate;
}

/** Estimated playable duration in whole seconds, or null when unmeasurable. */
export function estimateAudioDurationSeconds(buf: Buffer, contentType: string): number | null {
  const type = contentType.toLowerCase();
  const raw = type.includes('wav') ? wavDurationSeconds(buf)
    : type.includes('mpeg') || type.includes('mp3') ? mp3DurationSeconds(buf)
    : null;
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;
  // Review F5 — a sub-half-second estimate would round to 0, violating the
  // "null when unmeasurable" contract this file promises.
  const r = Math.round(raw);
  return r > 0 ? r : null;
}
