/**
 * Tiny dependency-free PNG canvas for the demo-media seeder.
 *
 * The app's upload allowlist DELIBERATELY blocks `image/svg+xml` as a stored-XSS
 * guard (`host/allowedUploadMime.ts`) — seeding SVG would contradict the app's
 * own security posture. `image/png` is allowed and renders everywhere, so we
 * author the demo imagery as real PNG bytes: a minimal encoder (Node `zlib`
 * deflate of filter-0 scanlines) over a small RGBA canvas with a handful of
 * brand-shape drawers. No external fetches, no libraries, no copyrighted images.
 */
import zlib from 'node:zlib';

// ── CRC32 (PNG chunk checksum) ──────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type RGB = readonly [number, number, number];
function hexRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** A small RGBA canvas with the few primitives the brand shapes need. */
export class Canvas {
  readonly width: number;
  readonly height: number;
  private readonly px: Uint8ClampedArray;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.px = new Uint8ClampedArray(width * height * 4);
  }
  private set(x: number, y: number, [r, g, b]: RGB, a = 255): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    // Source-over alpha composite (opaque background is the common case).
    const inv = (255 - a) / 255;
    this.px[i] = r * (a / 255) + this.px[i]! * inv;
    this.px[i + 1] = g * (a / 255) + this.px[i + 1]! * inv;
    this.px[i + 2] = b * (a / 255) + this.px[i + 2]! * inv;
    this.px[i + 3] = 255;
  }
  fill(hex: string): void {
    const c = hexRgb(hex);
    for (let y = 0; y < this.height; y += 1) for (let x = 0; x < this.width; x += 1) this.set(x, y, c);
  }
  /** Vertical two-stop gradient (top → bottom). */
  gradientV(topHex: string, bottomHex: string): void {
    const a = hexRgb(topHex), b = hexRgb(bottomHex);
    for (let y = 0; y < this.height; y += 1) {
      const t = y / (this.height - 1);
      const c: RGB = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      for (let x = 0; x < this.width; x += 1) this.set(x, y, c);
    }
  }
  rect(x0: number, y0: number, w: number, h: number, hex: string, a = 255): void {
    const c = hexRgb(hex);
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) this.set(x, y, c, a);
  }
  roundRect(x0: number, y0: number, w: number, h: number, r: number, hex: string): void {
    const c = hexRgb(hex);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const dx = Math.min(x, w - 1 - x), dy = Math.min(y, h - 1 - y);
        if (dx < r && dy < r && (r - dx) * (r - dx) + (r - dy) * (r - dy) > r * r) continue;
        this.set(x0 + x, y0 + y, c);
      }
    }
  }
  disc(cx: number, cy: number, radius: number, hex: string, a = 255): void {
    const c = hexRgb(hex);
    for (let y = cy - radius; y <= cy + radius; y += 1)
      for (let x = cx - radius; x <= cx + radius; x += 1)
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= radius * radius) this.set(x, y, c, a);
  }
  ring(cx: number, cy: number, radius: number, thickness: number, hex: string): void {
    const c = hexRgb(hex);
    const outer = radius * radius, inner = (radius - thickness) * (radius - thickness);
    for (let y = cy - radius; y <= cy + radius; y += 1)
      for (let x = cx - radius; x <= cx + radius; x += 1) {
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d <= outer && d >= inner) this.set(x, y, c);
      }
  }
  /** Encode to a base64 PNG string (what `mediaStorage.put` expects). */
  toBase64Png(): string {
    const stride = this.width * 4;
    const raw = Buffer.alloc((stride + 1) * this.height);
    for (let y = 0; y < this.height; y += 1) {
      raw[y * (stride + 1)] = 0; // filter type 0 (none)
      Buffer.from(this.px.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const png = Buffer.concat([
      PNG_SIG,
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    return png.toString('base64');
  }
}
