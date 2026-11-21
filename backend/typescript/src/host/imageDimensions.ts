/**
 * #5928 ask 4 — an image's pixel width and height, read from its HEADER bytes only.
 * The sibling of `allowedUploadMime.ts`'s content-type sniffing (ADR 0818 §2), with the
 * same four raster types: PNG (IHDR), JPEG (the first SOFn frame header), GIF (the
 * logical screen) and WebP (`VP8 `, `VP8L` and `VP8X`). No image library: the backend
 * has none, and a header parser is a few dozen bounded reads.
 *
 * Defensive by contract: it never throws, never loops and never reads past the buffer
 * OR past the length a segment or chunk declares for itself. A truncated, hostile or
 * unknown header returns `undefined`, and so does a claim outside 1..{@link
 * MAX_IMAGE_DIMENSION} px (a 2^31-px PNG IHDR is a lie, not an image). SVG and every
 * non-image return `undefined`: they have no intrinsic pixel size worth trusting.
 *
 * JPEG EXIF orientation: when an APP1 `Exif` segment before the frame header carries
 * IFD0 tag 0x0112 with a value of 5–8 (a 90° rotation), width and height are swapped,
 * so the numbers are what a browser displays (`image-orientation: from-image`, the
 * default). Any EXIF it cannot read within the segment's own bounds is ignored, and the
 * STORED pixel dimensions are reported.
 */

/** The largest edge believed, in px. Above every real format's own ceiling but one
 *  (JPEG and GIF stop at 65,535, WebP at 16,384; PNG's field allows 2^31 − 1). */
export const MAX_IMAGE_DIMENSION = 65_535;

export interface ImageDimensions { width: number; height: number }

const ok = (width: number, height: number): ImageDimensions | undefined =>
  Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION
    ? { width, height }
    : undefined;

/** `[at, at + n)` lies inside `[0, end)`. Every read below goes through it. */
const fits = (at: number, n: number, end: number): boolean => at >= 0 && n >= 0 && at + n <= end;
const ascii = (b: Buffer, at: number, s: string): boolean => fits(at, s.length, b.length) && b.toString('latin1', at, at + s.length) === s;

function png(b: Buffer): ImageDimensions | undefined {
  // 8-byte signature, then the first chunk MUST be IHDR, whose length is exactly 13.
  if (!fits(0, 24, b.length) || b[0] !== 0x89 || !ascii(b, 1, 'PNG\r\n\x1a\n')) return undefined;
  if (b.readUInt32BE(8) !== 13 || !ascii(b, 12, 'IHDR')) return undefined;
  return ok(b.readUInt32BE(16), b.readUInt32BE(20));
}

function gif(b: Buffer): ImageDimensions | undefined {
  if (!fits(0, 10, b.length) || !(ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) return undefined;
  return ok(b.readUInt16LE(6), b.readUInt16LE(8));
}

function webp(b: Buffer): ImageDimensions | undefined {
  if (!fits(0, 20, b.length) || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return undefined;
  // The RIFF size bounds the file; the first chunk's size bounds that chunk's reads.
  const riffEnd = Math.min(b.length, 8 + b.readUInt32LE(4));
  const fourcc = b.toString('latin1', 12, 16);
  const data = 20;
  const chunkEnd = Math.min(riffEnd, data + b.readUInt32LE(16));
  if (fourcc === 'VP8 ') {
    // 3-byte frame tag, the 9d 01 2a start code, then 14-bit width and height.
    if (!fits(data, 10, chunkEnd) || b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) return undefined;
    return ok(b.readUInt16LE(data + 6) & 0x3fff, b.readUInt16LE(data + 8) & 0x3fff);
  }
  if (fourcc === 'VP8L') {
    // 0x2f signature, then 14 bits of width − 1 and 14 bits of height − 1.
    if (!fits(data, 5, chunkEnd) || b[data] !== 0x2f) return undefined;
    const bits = b.readUInt32LE(data + 1);
    return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (fourcc === 'VP8X') {
    // flags (1) + reserved (3), then 24-bit canvas width − 1 and height − 1.
    if (!fits(data, 10, chunkEnd)) return undefined;
    return ok(b.readUIntLE(data + 4, 3) + 1, b.readUIntLE(data + 7, 3) + 1);
  }
  return undefined;
}

/** SOF0–3, 5–7, 9–11, 13–15: the frame headers (C4 DHT, C8 JPG and CC DAC are not). */
const isSof = (m: number): boolean => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
/** Markers with no length field. */
const standalone = (m: number): boolean => m === 0x01 || (m >= 0xd0 && m <= 0xd8);
/** More segments than any real header carries; a cap on top of guaranteed progress. */
const MAX_JPEG_SEGMENTS = 4096;

function jpeg(b: Buffer): ImageDimensions | undefined {
  if (!fits(0, 4, b.length) || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let i = 2;
  let orientation = 1;
  for (let seg = 0; seg < MAX_JPEG_SEGMENTS; seg += 1) {
    // A marker is 0xFF then a code; any run of 0xFF fill bytes before the code is legal.
    if (!fits(i, 2, b.length) || b[i] !== 0xff) return undefined;
    let j = i + 1;
    while (j < b.length && b[j] === 0xff) j += 1;
    if (j >= b.length) return undefined;
    const m = b[j]!;
    if (standalone(m)) { i = j + 1; continue; }
    // EOI or start-of-scan before a frame header: no dimensions in this header.
    if (m === 0xd9 || m === 0xda || m === 0x00) return undefined;
    if (!fits(j + 1, 2, b.length)) return undefined;
    const len = b.readUInt16BE(j + 1); // includes its own two bytes
    const start = j + 3;
    const end = j + 1 + len;
    // A length under 2 is self-referential; one past the buffer is truncated.
    if (len < 2 || end > b.length) return undefined;
    if (isSof(m)) {
      // precision (1), height (2), width (2), within the segment's declared length.
      if (!fits(start, 5, end)) return undefined;
      const height = b.readUInt16BE(start + 1);
      const width = b.readUInt16BE(start + 3);
      return orientation >= 5 && orientation <= 8 ? ok(height, width) : ok(width, height);
    }
    if (m === 0xe1) orientation = exifOrientation(b, start, end) ?? orientation;
    i = end; // strictly past this marker: `len >= 2` makes every step at least 4 bytes
  }
  return undefined;
}

/** IFD0 tag 0x0112 of an APP1 `Exif\0\0` segment in `[start, end)`, or undefined. Every
 *  offset is relative to the TIFF header and checked against the segment's end. */
function exifOrientation(b: Buffer, start: number, end: number): number | undefined {
  if (!ascii(b, start, 'Exif\0\0')) return undefined;
  const tiff = start + 6;
  if (!fits(tiff, 8, end)) return undefined;
  const le = ascii(b, tiff, 'II');
  if (!le && !ascii(b, tiff, 'MM')) return undefined;
  const u16 = (at: number): number => (le ? b.readUInt16LE(at) : b.readUInt16BE(at));
  const u32 = (at: number): number => (le ? b.readUInt32LE(at) : b.readUInt32BE(at));
  if (u16(tiff + 2) !== 42) return undefined;
  const ifd = tiff + u32(tiff + 4);
  if (!fits(ifd, 2, end)) return undefined;
  const count = u16(ifd);
  for (let k = 0; k < count; k += 1) {
    const entry = ifd + 2 + k * 12;
    if (!fits(entry, 12, end)) return undefined; // bounded by the segment, not by `count`
    // Orientation is one SHORT (type 3, count 1), stored in the first two value bytes.
    if (u16(entry) === 0x0112) return u16(entry + 2) === 3 ? u16(entry + 8) : undefined;
  }
  return undefined;
}

/**
 * The pixel dimensions in `bytes`' header, or undefined. The format is decided by the
 * bytes' own signature, never a declared type (a mislabelled image is relabelled the
 * same way, ADR 0818 §2). Never throws.
 */
export function imageDimensions(bytes: Buffer | Uint8Array | null | undefined): ImageDimensions | undefined {
  if (!bytes || bytes.length < 10) return undefined;
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (b[0] === 0x89) return png(b);
    if (b[0] === 0xff) return jpeg(b);
    if (b[0] === 0x47) return gif(b);
    if (b[0] === 0x52) return webp(b);
  } catch {
    // Belt and braces: every read above is bounds-checked, so this is unreachable.
  }
  return undefined;
}

/** How many leading bytes a stored image's header needs at most, for a reader that can
 *  fetch a prefix: room for a 64 KiB EXIF segment plus ICC and Photoshop segments. */
export const IMAGE_HEADER_PREFIX_BYTES = 512 * 1024;
