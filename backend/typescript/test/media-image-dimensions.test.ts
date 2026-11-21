/**
 * #5928 ask 4 — `imageDimensions`, the header-only pixel-size parser (PNG, JPEG, GIF,
 * WebP VP8/VP8L/VP8X) beside the ADR 0818 §2 content-type sniffing.
 *
 * Fixtures are REAL files, 5×3 px, made once with stock tools and inlined: the PNG by
 * hand (zlib + crc32), the JPEG and GIF by macOS `sips` from it (the JPEG carries
 * APP0, an APP1 Exif, an APP13 and two DQT/four DHT segments before SOF0, so segment
 * skipping is exercised), and the three WebPs by `cwebp` (lossy = `VP8 `, `-lossless`
 * = `VP8L`, lossy from an alpha PNG = `VP8X`).
 *
 * Pins: each format reads 5×3; a JPEG whose Exif says orientation 6 reads 3×5 and one
 * whose Exif is unreadable reads the stored 5×3; truncation, garbage, a self-referential
 * JPEG segment length (0 and 2), declared lengths past the buffer and an oversized claim
 * return undefined; and a seeded fuzz (truncations, byte flips, garbage) never throws,
 * only returns undefined or two in-range integers, and finishes in bounded time.
 *
 * Sabotage, each restored, each red: the JPEG walk not stepping past a segment (the
 * segment cap ends it; the fixture and Exif cases go red); dropping the
 * `MAX_IMAGE_DIMENSION` check (the oversized claim and the fuzz); reading SOF dimensions
 * without the segment-length bound (the short-SOF case); ignoring orientation (the Exif
 * cases). A JPEG length of 0 or 1 cannot loop even without its guard, since every step
 * lands past the marker; the guard makes it a clean refusal.
 */
import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_DIMENSION, imageDimensions } from '../src/host/imageDimensions.js';

const FIXTURES = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAUAAAADCAIAAADUVFKvAAAAO0lEQVR4nAEwAM//AAAoUHigyPAYQGiQuOAIMABagqrS+iJKcprC6hI6YooAtNwELFR8pMz0HERslLzk9S8WC4qdoZMAAAAASUVORK5CYII=',
  jpeg: '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABaADAAQAAAABAAAAAwAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAwAFAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A77w54B8G+LNa1DRNd0iCWx0eEC0ijXyBEE1DULBQPJ2EgW1jboASR8hb77uzdr/woL4R/wDQvp/3/uP/AI5UPw5/5G/xF/1xb/0+a3Xs9fofC2DoyyzDSlBNuEG3ZatxTbfm3qz4L/WTMaN6VLEzjFbJTkkvRJn/2Q==',
  gif: 'R0lGODdhBQADAMQAAAAAAOAIMPAYQAAoUBxEbCxUfDpiikpymlqCqmiQuHigyJS85KTM9LTcBMLqEtL6Iv///wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACH5BAQAAAAALAAAAAAFAAMAAAUN4KAISYA8h2M0BUMsIQA7',
  webpLossy: 'UklGRlQAAABXRUJQVlA4IEgAAADwAQCdASoFAAMAAsBMJbACdAD0kBm9oAAAywst0f8Af1FP6WI+P2MIx234jfQPPhy4ZBLamgRBj22ZhUl/ltMQ7ig+lEIAAAA=',
  webpLossless: 'UklGRlQAAABXRUJQVlA4TEcAAAAvBIAAAHdgkG0kg6UAB/D+ii9BkG2bOsFSgBNk28YMlgIc6vNfhdvvAxWACuzzVwEoiG0b+vtKABWEM8KpoGNE/+Oe+R/vFQA=',
  webpExtended: 'UklGRoAAAABXRUJQVlA4WAoAAAAQAAAABAAAAgAAQUxQSBAAAAAAeBi4WPjSchKyUizMbAysVlA4IEoAAADQAQCdASoFAAMAAsBMJbACdAD0h/vOAADLSDqx8rTLq/X+m9QvGRZB4rit562RjKkpSv0FX7v3v6StcyVTBPESvwePv/+L8pAAAA==',
} as const;
const buf = (k: keyof typeof FIXTURES): Buffer => Buffer.from(FIXTURES[k], 'base64');

/** The JPEG fixture with its APP1 replaced by a minimal big-endian Exif whose IFD0 holds
 *  one entry: Orientation (0x0112), SHORT, count 1, `value`. */
function jpegWithOrientation(value: number, opts: { le?: boolean } = {}): Buffer {
  const src = buf('jpeg');
  const le = opts.le ?? false;
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  const w16 = (v: number, at: number): void => { if (le) tiff.writeUInt16LE(v, at); else tiff.writeUInt16BE(v, at); };
  const w32 = (v: number, at: number): void => { if (le) tiff.writeUInt32LE(v, at); else tiff.writeUInt32BE(v, at); };
  tiff.write(le ? 'II' : 'MM', 0, 'latin1');
  w16(42, 2); w32(8, 4); w16(1, 8);
  w16(0x0112, 10); w16(3, 12); w32(1, 14); w16(value, 18);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.alloc(2), body]);
  app1.writeUInt16BE(body.length + 2, 2);
  // Skip SOI + APP0 + the fixture's own APP1, then splice ours in.
  let i = 2;
  i += 2 + src.readUInt16BE(i + 2); // APP0
  const app1Len = src.readUInt16BE(i + 2);
  return Buffer.concat([src.subarray(0, i), app1, src.subarray(i + 2 + app1Len)]);
}

describe('#5928 ask 4 — imageDimensions on real fixtures', () => {
  it.each(Object.keys(FIXTURES) as (keyof typeof FIXTURES)[])('%s reads 5×3', (k) => {
    expect(imageDimensions(buf(k))).toEqual({ width: 5, height: 3 });
  });

  it('a JPEG whose Exif orientation is 5–8 reports the displayed (swapped) size; 1–4 the stored size', () => {
    for (const o of [5, 6, 7, 8]) expect(imageDimensions(jpegWithOrientation(o))).toEqual({ width: 3, height: 5 });
    for (const o of [1, 2, 3, 4]) expect(imageDimensions(jpegWithOrientation(o))).toEqual({ width: 5, height: 3 });
    expect(imageDimensions(jpegWithOrientation(6, { le: true }))).toEqual({ width: 3, height: 5 });
  });

  it('an Exif it cannot read in bounds is ignored: the stored size', () => {
    const j = jpegWithOrientation(6);
    const at = j.indexOf(Buffer.from('MM', 'latin1'));
    const badOffset = Buffer.from(j); badOffset.writeUInt32BE(0xfffffff0, at + 4); // IFD0 past the segment
    expect(imageDimensions(badOffset)).toEqual({ width: 5, height: 3 });
    const badCount = Buffer.from(j); badCount.writeUInt16BE(0xffff, at + 8); // 65535 entries in a 26-byte TIFF
    // The orientation entry is first, so it is still read; the count is never trusted past it.
    expect(imageDimensions(badCount)).toEqual({ width: 3, height: 5 });
  });

  it('SVG, text, PDF and empty input have no dimensions', () => {
    expect(imageDimensions(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'))).toBeUndefined();
    expect(imageDimensions(Buffer.from('%PDF-1.7 hello world'))).toBeUndefined();
    expect(imageDimensions(Buffer.from('plain text, not an image'))).toBeUndefined();
    expect(imageDimensions(Buffer.alloc(0))).toBeUndefined();
    expect(imageDimensions(null)).toBeUndefined();
  });
});

describe('#5928 ask 4 — hostile and truncated headers return undefined', () => {
  it('truncated before the dimensions', () => {
    expect(imageDimensions(buf('png').subarray(0, 23))).toBeUndefined();
    expect(imageDimensions(buf('gif').subarray(0, 9))).toBeUndefined();
    for (const k of ['webpLossy', 'webpLossless', 'webpExtended'] as const) expect(imageDimensions(buf(k).subarray(0, 24))).toBeUndefined();
    const jpeg = buf('jpeg');
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    expect(imageDimensions(jpeg.subarray(0, sof + 6))).toBeUndefined();
    expect(imageDimensions(jpeg.subarray(0, sof - 20))).toBeUndefined(); // inside the APP13, before SOF
  });

  it('a self-referential JPEG segment length (0, 1 or 2) never loops', () => {
    for (const len of [0, 1]) {
      const b = Buffer.from([0xff, 0xd8, 0xff, 0xe0, len >> 8, len & 0xff, 0, 0, 0, 0, 0, 0]);
      expect(imageDimensions(b)).toBeUndefined();
    }
    // Length 2 is an EMPTY segment: legal, and each one advances 4 bytes. 20,000 of them
    // end at the segment cap or the buffer, never in a loop.
    const empties = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(80_000, Buffer.from([0xff, 0xe0, 0x00, 0x02]))]);
    const t = performance.now();
    expect(imageDimensions(empties)).toBeUndefined();
    expect(performance.now() - t).toBeLessThan(200);
    // Endless 0xFF fill bytes are bounded by the buffer.
    expect(imageDimensions(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(100_000, 0xff)]))).toBeUndefined();
  });

  it('a declared length past the buffer, or a frame header shorter than its fields', () => {
    const past = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]);
    expect(imageDimensions(past)).toBeUndefined();
    // SOF0 with length 4: its height/width bytes lie OUTSIDE the declared segment.
    const shortSof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x04, 0x08, 0x00, 0x03, 0x00, 0x05, 0x03, 0xff, 0xd9]);
    expect(imageDimensions(shortSof)).toBeUndefined();
    // A WebP VP8L chunk whose declared size is too small for its own header.
    const vp8l = Buffer.from(buf('webpLossless')); vp8l.writeUInt32LE(2, 16);
    expect(imageDimensions(vp8l)).toBeUndefined();
    // A PNG whose first chunk is not a 13-byte IHDR.
    const png = Buffer.from(buf('png')); png.writeUInt32BE(14, 8);
    expect(imageDimensions(png)).toBeUndefined();
  });

  it('an oversized or zero claim', () => {
    const png = Buffer.from(buf('png')); png.writeUInt32BE(0x7fffffff, 16);
    expect(imageDimensions(png)).toBeUndefined();
    png.writeUInt32BE(MAX_IMAGE_DIMENSION + 1, 16);
    expect(imageDimensions(png)).toBeUndefined();
    png.writeUInt32BE(MAX_IMAGE_DIMENSION, 16);
    expect(imageDimensions(png)).toEqual({ width: MAX_IMAGE_DIMENSION, height: 3 });
    const gif = Buffer.from(buf('gif')); gif.writeUInt16LE(0, 6);
    expect(imageDimensions(gif)).toBeUndefined();
  });
});

describe('#5928 ask 4 — seeded fuzz', () => {
  /** mulberry32: a small deterministic PRNG, so a red run reproduces exactly. */
  function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const valid = (r: unknown): boolean => r === undefined || (
    typeof r === 'object' && r !== null && Object.keys(r).length === 2
    && [(r as { width: unknown }).width, (r as { height: unknown }).height].every((v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_IMAGE_DIMENSION)
  );

  it('truncations, byte flips and garbage: never throws, only undefined or two in-range integers, bounded time', () => {
    const rnd = prng(0x5928);
    const int = (n: number): number => Math.floor(rnd() * n);
    const seeds = [...(Object.keys(FIXTURES) as (keyof typeof FIXTURES)[]).map(buf), jpegWithOrientation(6), jpegWithOrientation(8, { le: true })];
    const cases: Buffer[] = [];
    for (const s of seeds) {
      for (let i = 0; i < 400; i += 1) cases.push(s.subarray(0, int(s.length + 1)));
      for (let i = 0; i < 400; i += 1) {
        const b = Buffer.from(s);
        // Flip 1–8 bytes; bias half of them into the header, where the parser reads.
        for (let f = 1 + int(8); f > 0; f -= 1) b[rnd() < 0.5 ? int(Math.min(64, b.length)) : int(b.length)] = int(256);
        cases.push(b);
      }
    }
    // Garbage, half of it behind a real signature so it reaches each format's parser.
    const sigs = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0xff, 0xd8]), Buffer.from('GIF89a', 'latin1'), Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')];
    for (let i = 0; i < 2000; i += 1) {
      const g = Buffer.alloc(int(512));
      for (let j = 0; j < g.length; j += 1) g[j] = int(256);
      cases.push(rnd() < 0.5 ? Buffer.concat([sigs[int(sigs.length)]!, g]) : g);
    }
    expect(cases.length).toBeGreaterThan(8000);
    let slowest = 0;
    let found = 0;
    const t0 = performance.now();
    for (const c of cases) {
      const t = performance.now();
      let r: unknown;
      expect(() => { r = imageDimensions(c); }).not.toThrow();
      slowest = Math.max(slowest, performance.now() - t);
      if (!valid(r)) throw new Error(`invalid result ${JSON.stringify(r)} for ${c.toString('base64').slice(0, 120)}`);
      if (r) found += 1;
    }
    expect(found).toBeGreaterThan(0); // the fuzz still reaches the success path
    expect(slowest).toBeLessThan(50);
    expect(performance.now() - t0).toBeLessThan(750);
  });
});

describe('#5928 ask 4 — createAsset records them on every lane', () => {
  it('reads the stored head when the caller passes no bytes (the seed, render, video and intake lanes), and never across tenants', async () => {
    const { openStorage } = await import('../src/storage/index.js');
    const { initHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
    initHostExtPersistence(await openStorage('memory://'));
    const mediaStorage = await import('../src/features/media/mediaStorage.js');
    const { createAsset } = await import('../src/features/media/mediaService.js');
    const stored = await mediaStorage.put('t-dim', { contentBase64: FIXTURES.webpExtended, contentType: 'image/webp' });
    const base = { tenantId: 't-dim', orgId: 'o', name: 'x.webp', contentType: 'image/webp', sizeBytes: stored.sizeBytes, storageRef: stored.storageRef, serveToken: stored.serveToken, uploadedBy: 'u' };
    expect(await createAsset(base)).toMatchObject({ width: 5, height: 3 });
    // Caller-held bytes win (no storage read), and a non-image gets none.
    expect(await createAsset({ ...base, bytes: buf('gif') })).toMatchObject({ width: 5, height: 3 });
    const txt = await createAsset({ ...base, contentType: 'text/plain', bytes: buf('png') });
    expect(txt.width).toBeUndefined();
    // Another tenant's ref is not read.
    const foreign = await createAsset({ ...base, tenantId: 't-other' });
    expect(foreign.width).toBeUndefined();
  });
});
