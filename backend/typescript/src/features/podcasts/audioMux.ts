/**
 * Single-file audio mux for podcast episodes (ADR 0086 §mix). The synthesize node
 * produces one stored clip per dialogue turn; this concatenates them into ONE
 * playable asset where the codec allows it cheaply (no ffmpeg on this host):
 *
 *   - `audio/mpeg` (MiniMax / OpenAI) → byte-concatenate the MP3 frame streams
 *     (tolerant players treat the result as one stream).
 *   - `audio/wav`  (Google Gemini PCM, wrapped by `pcmToWav` → exactly 44-byte
 *     headers) → strip each clip's header, concatenate the PCM, re-wrap once with
 *     the first clip's fmt + corrected RIFF/data sizes.
 *
 * Returns `null` when the clips mix codecs or use an unknown container — the caller
 * KEEPS the ordered-clip playlist (the Studio player plays turns sequentially), so
 * mux failure degrades, never corrupts. Pure + dependency-free (testable in isolation).
 */

const WAV_HEADER_BYTES = 44;

export interface AudioPart { contentBase64: string; contentType: string }

/** Aggregate cap on the muxed output — keeps the single-file mux bounded in memory
 *  and well under the WAV header's UInt32 data-size field (review fix). Over the cap
 *  ⇒ return null and the caller keeps the ordered-clip playlist. */
const MAX_MIX_BYTES = 256 * 1024 * 1024;

export function muxAudioClips(parts: readonly AudioPart[]): { contentBase64: string; contentType: string } | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return { contentBase64: parts[0]!.contentBase64, contentType: parts[0]!.contentType };
  const types = new Set(parts.map((p) => p.contentType));
  if (types.size !== 1) return null; // mixed codecs — keep the playlist
  // Bail to the playlist if the combined audio would exceed the mux cap (decoded ≈
  // 3/4 of base64 length) — never buffer an unbounded concatenation.
  const totalBytes = parts.reduce((sum, p) => sum + Math.floor((p.contentBase64.length * 3) / 4), 0);
  if (totalBytes > MAX_MIX_BYTES) return null;
  const type = parts[0]!.contentType;

  if (type === 'audio/mpeg' || type === 'audio/mp3') {
    // Strip a leading ID3v2 tag from every clip AFTER the first — a mid-stream ID3
    // tag derails tolerant decoders (they expect tags only at offset 0). The first
    // clip keeps its tag. ID3v2 header = 'ID3' + 2 version + 1 flags + 4 synchsafe
    // size bytes (7 bits each) ⇒ tag length = 10 + size.
    const stripLeadingId3 = (buf: Buffer, isFirst: boolean): Buffer => {
      if (isFirst) return buf;
      if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
        const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
        return buf.subarray(10 + size);
      }
      return buf;
    };
    const buf = Buffer.concat(parts.map((p, i) => stripLeadingId3(Buffer.from(p.contentBase64, 'base64'), i === 0)));
    return { contentBase64: buf.toString('base64'), contentType: 'audio/mpeg' };
  }

  if (type === 'audio/wav' || type === 'audio/x-wav') {
    const buffers = parts.map((p) => Buffer.from(p.contentBase64, 'base64'));
    if (buffers.some((b) => b.length < WAV_HEADER_BYTES)) return null;
    const pcm = Buffer.concat(buffers.map((b) => b.subarray(WAV_HEADER_BYTES)));
    const header = Buffer.from(buffers[0]!.subarray(0, WAV_HEADER_BYTES)); // copy fmt from the first clip
    header.writeUInt32LE(36 + pcm.length, 4); // RIFF chunk size
    header.writeUInt32LE(pcm.length, 40); // data chunk size
    return { contentBase64: Buffer.concat([header, pcm]).toString('base64'), contentType: 'audio/wav' };
  }

  return null; // unknown container — keep the playlist
}
