/** CB-RENDER-1 (ADR 0399 correction 2026-11-06) — actual pixels must use shipped fonts, even on fontless Linux.
 * Native resvg rejects WASM fontBuffers, silently resets options, and otherwise
 * lets developer system fonts mask missing production glyphs. The reference
 * uses the documented native fontFiles carrier with the exact shipped bytes.
 * Sabotage-witnessed (w93): dropping the font carrier from the PNG or GIF raster;
 * dropping custom faces from the PNG. Not visible in pixels here, so held
 * elsewhere: `loadSystemFonts: true` (asserted literally by
 * creative-native-font-lifetime.test.ts). The GIF case renders shipped fonts
 * only, so it does not claim custom faces in GIFs. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import * as gifencNs from 'gifenc';
import { bundledFontBuffers } from '../src/features/creative-briefs/render/fonts.js';
import { composeAdSvg, renderAd, renderAnimatedGif, type RenderAdInput } from '../src/features/creative-briefs/render/renderCreative.js';
import { extractFontFamily } from '../src/features/brand/brandFonts.js';
import { getTemplate } from '../src/features/creative-briefs/render/templates.js';

const { GIFEncoder, quantize, applyPalette } = typeof gifencNs.GIFEncoder === 'function' ? gifencNs : (gifencNs.default ?? gifencNs);
function input(): RenderAdInput {
  const template = getTemplate('meta.feed.1x1');
  if (!template) throw new Error('Shipped Meta template missing');
  return {
    template,
    brand: { colors: { ink: '#111111', paper: '#ffffff', accent: '#3b5bdb', accentInk: '#ffffff' }, fontFamilies: { sans: 'Inter', serif: 'PT Serif' } },
    content: { images: {}, texts: { headline: 'A small action for this real week', body: 'Make the next small step feel achievable in the week a person actually has.', cta: 'Explore free early access' } },
  };
}
// Independent native reference, not a mock of the product renderer.
function withReferenceFonts<T>(fonts: Buffer[], run: (font: NonNullable<ResvgRenderOptions['font']>) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'creative-font-reference-'));
  try {
    const fontFiles = fonts.map((bytes, n) => { const file = join(directory, `${n}.ttf`); writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' }); return file; });
    return run({ loadSystemFonts: false, fontFiles, defaultFontFamily: 'Inter' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('creative native font pixels', () => {
  it('static PNG equals the shipped-font native raster, includes glyphs and responds to copy/nudge', () => {
    const original = input();
    const svg = composeAdSvg(original).svg;
    const expected = withReferenceFonts(bundledFontBuffers(), (font) => {
      const raster = new Resvg(svg, { font }).render();
      const pixels = raster.pixels;
      let glyphs = 0;
      for (let y = 700; y < 980; y++) for (let x = 0; x < raster.width; x++) {
        const n = (y * raster.width + x) * 4;
        if (pixels[n] > 220 && pixels[n + 1] > 220 && pixels[n + 2] > 220) glyphs++;
      }
      expect(glyphs, 'white glyphs on gray scrim, excluding white background and CTA').toBeGreaterThan(1000);
      return Buffer.from(raster.asPng());
    });
    const actual = renderAd(original);
    expect(actual.png.equals(expected), 'actual PNG must use embedded fonts, not OS fallback').toBe(true);
    expect(renderAd(original).png.equals(actual.png)).toBe(true);
    const changed = input(); changed.content.texts.headline = 'A different next step';
    expect(renderAd(changed).png.equals(actual.png)).toBe(false);
    expect(renderAd({ ...original, overrides: { headline: { dx: 1 } } }).png.equals(actual.png)).toBe(false);
    const fontless = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
    expect(Buffer.from(fontless.asPng()).equals(expected)).toBe(false);
  });

  it('a supplied custom face changes actual glyphs and is included in the native raster', () => {
    const serifBold = bundledFontBuffers()[3];
    if (!serifBold) throw new Error('Shipped serif-bold font missing');
    // Distinct test family from the licensed shipped face: same-length name
    // replacements keep the TTF name-table offsets intact; no new font dependency.
    const custom = Buffer.from(serifBold);
    for (const [from, to] of [['PT Serif', 'QA Serif'], ['PTSerif', 'QASerif']]) {
      for (const encoding of ['ascii', 'utf16le'] as const) {
        const before = Buffer.from(from, encoding), after = Buffer.from(to, encoding);
        if (encoding === 'utf16le') { before.swap16(); after.swap16(); }
        for (let n = custom.indexOf(before); n !== -1; n = custom.indexOf(before, n + before.length)) after.copy(custom, n);
      }
    }
    expect(extractFontFamily(custom)).toBe('QA Serif');
    const value = input(); value.brand.fontFamilies.sans = 'QA Serif';
    const svg = composeAdSvg(value).svg;
    const expected = withReferenceFonts([...bundledFontBuffers(), custom], (font) => Buffer.from(new Resvg(svg, { font }).render().asPng()));
    expect(renderAd({ ...value, extraFontBuffers: [custom] }).png.equals(expected)).toBe(true);
    expect(renderAd(value).png.equals(expected), 'omitting the custom face must change glyphs').toBe(false);
  });

  it('animated GIF uses exact shipped fonts for both reveal frames', () => {
    const value = input();
    // Two frames are exact endpoints; no copy of the intermediate easing math.
    const expected = withReferenceFonts(bundledFontBuffers(), (font) => {
      const encoder = GIFEncoder();
      for (const revealProgress of [0, 1]) {
        const { svg } = composeAdSvg(value, { revealProgress });
        const raster = new Resvg(svg, { font }).render();
        const rgba = raster.pixels;
        const palette = quantize(rgba, 256);
        encoder.writeFrame(applyPalette(rgba, palette), raster.width, raster.height, { palette, delay: 500 });
      }
      encoder.finish();
      return Buffer.from(encoder.bytes());
    });
    const actual = renderAnimatedGif(value, { preset: 'reveal', frames: 2, fps: 2 });
    expect(actual.gif.equals(expected), 'GIF rasterization must use the same real font carrier').toBe(true);
  });
});
