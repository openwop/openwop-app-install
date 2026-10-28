/**
 * ADR 0945 D3 stage A — rasterise through `@resvg/resvg-js`, the one image
 * decoder this host has (G7; Q4 answered "resvg first", no new dependency).
 * An `<image>` inside a tiny SVG is rendered to an RGBA grid: the same engine
 * and the same placement rules the ADR 0399 renderer uses, so the source and
 * the composite are sampled the same way.
 */
import { Resvg } from '@resvg/resvg-js';

export interface RgbaGrid { w: number; h: number; data: Uint8Array }
export interface Box { x: number; y: number; w: number; h: number }

const EMBEDDABLE = new Set(['image/png', 'image/jpeg', 'image/gif']);
export function isRasterisable(mime: string): boolean { return EMBEDDABLE.has(mime); }

function render(svg: string): RgbaGrid {
  const r = new Resvg(svg, { font: { loadSystemFonts: false }, fitTo: { mode: 'original' } }).render();
  return { w: r.width, h: r.height, data: new Uint8Array(r.pixels) };
}

/** The SOURCE (a cut-out) placed into a slot of `box` size exactly as the
 *  renderer places a `fit:'contain'` layer (`xMidYMid meet`), sampled to
 *  `grid`×`grid`. Letterbox cells come out transparent. */
export function rasteriseIntoSlot(mime: string, base64: string, box: Pick<Box, 'w' | 'h'>, grid: number): RgbaGrid {
  const href = `data:${mime};base64,${base64}`;
  return render(`<svg xmlns="http://www.w3.org/2000/svg" width="${grid}" height="${grid}" viewBox="0 0 ${box.w} ${box.h}" preserveAspectRatio="none"><image x="0" y="0" width="${box.w}" height="${box.h}" preserveAspectRatio="xMidYMid meet" href="${href}"/></svg>`);
}

/** The CANDIDATE (a whole composite of `canvas` size) cropped to `box`,
 *  sampled to `grid`×`grid` with the same stretch as {@link rasteriseIntoSlot}. */
export function rasteriseCrop(mime: string, base64: string, canvas: Pick<Box, 'w' | 'h'>, box: Box, grid: number): RgbaGrid {
  const href = `data:${mime};base64,${base64}`;
  return render(`<svg xmlns="http://www.w3.org/2000/svg" width="${grid}" height="${grid}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}" preserveAspectRatio="none"><image x="0" y="0" width="${canvas.w}" height="${canvas.h}" preserveAspectRatio="none" href="${href}"/></svg>`);
}

/** A whole image stretched to `grid`×`grid` (edit-mode comparisons: the source,
 *  the cut-out and the candidate share the source's geometry). */
export function rasteriseFull(mime: string, base64: string, grid: number): RgbaGrid {
  const href = `data:${mime};base64,${base64}`;
  return render(`<svg xmlns="http://www.w3.org/2000/svg" width="${grid}" height="${grid}" viewBox="0 0 100 100" preserveAspectRatio="none"><image x="0" y="0" width="100" height="100" preserveAspectRatio="none" href="${href}"/></svg>`);
}

/**
 * ADR 0945 D2 — the edit-mode PROTECTION mask, from a cut-out's alpha, at the
 * source's natural size. Encoded per provider, because they disagree on which
 * pixels are repainted: Replicate repaints WHITE (product drawn black on
 * white); OpenAI repaints TRANSPARENT (product opaque, the rest clear).
 */
export function protectionMaskPng(cutoutMime: string, cutoutBase64: string, size: { w: number; h: number }, provider: 'replicate' | 'openai'): string {
  const href = `data:${cutoutMime};base64,${cutoutBase64}`;
  const { w, h } = size;
  const svg = provider === 'replicate'
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><filter id="k" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"/></filter></defs><rect width="${w}" height="${h}" fill="#ffffff"/><image width="${w}" height="${h}" preserveAspectRatio="none" filter="url(#k)" href="${href}"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><image width="${w}" height="${h}" preserveAspectRatio="none" href="${href}"/></svg>`;
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng()).toString('base64');
}
