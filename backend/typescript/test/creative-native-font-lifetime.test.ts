/** CB-RENDER-1 (ADR 0399 correction 2026-11-06) — private bytes survive synchronous
 * rendering only; overlapping operations own distinct files and clean up on both
 * setup and render failure.
 * Sabotage-witnessed (w93): a 0755 directory; 0644 font files; loadSystemFonts
 * true; no cleanup; cleanup on success only (the failure cases red). Deleting the
 * chmod is an equivalent mutant (mkdtempSync already creates 0700). Distinct
 * directories rest on mkdtempSync (inner ≠ outer is asserted). */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { withNativeFontFiles } from '../src/features/creative-briefs/render/nativeFonts.js';
import { bundledFontBuffers } from '../src/features/creative-briefs/render/fonts.js';

describe('native font file lifetime', () => {
  it('preserves exact bundled/custom bytes privately, honors options and removes files after success', () => {
    const fonts = [...bundledFontBuffers(), Buffer.from('controlled custom fixture bytes')];
    let directory = '';
    withNativeFontFiles(fonts, (font) => {
      const files = font.fontFiles;
      if (!files?.length) throw new Error('Expected native font files');
      directory = dirname(files[0]);
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(font.loadSystemFonts).toBe(false);
      expect(files).toHaveLength(fonts.length);
      files.forEach((file, n) => {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(file).equals(fonts[n])).toBe(true);
      });
      const raster = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="100"><text x="10" y="70" font-family="Inter" font-size="48">HELLO</text></svg>', { font, fitTo: { mode: 'width', value: 250 } }).render();
      expect(raster.width).toBe(250);
      const pixels = raster.pixels;
      expect(pixels.some((_, n) => n % 4 === 3 && pixels[n] > 0), 'real glyph pixels, not transparent PNG').toBe(true);
    });
    expect(directory).not.toBe('');
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('keeps overlapping operations independent and cleans up after native callback failure', () => {
    let outerDirectory = '', innerDirectory = '';
    const failure = new Error('native render failed');
    expect(() => withNativeFontFiles(bundledFontBuffers(), (outer) => {
      if (!outer.fontFiles?.[0]) throw new Error('Expected outer fonts');
      outerDirectory = dirname(outer.fontFiles[0]);
      withNativeFontFiles(bundledFontBuffers(), (inner) => {
        if (!inner.fontFiles?.[0]) throw new Error('Expected inner fonts');
        innerDirectory = dirname(inner.fontFiles[0]);
        expect(innerDirectory).not.toBe(outerDirectory);
        expect(fs.existsSync(outerDirectory)).toBe(true);
      });
      expect(fs.existsSync(innerDirectory)).toBe(false);
      expect(fs.existsSync(outerDirectory)).toBe(true);
      throw failure;
    })).toThrow(failure);
    expect(fs.existsSync(outerDirectory)).toBe(false);
  });

  it('cleans up when setup fails before the native callback', () => {
    const ownedParent = fs.mkdtempSync(join(tmpdir(), 'creative-font-setup-test-'));
    vi.stubEnv('TMPDIR', ownedParent);
    vi.stubEnv('TMP', ownedParent);
    vi.stubEnv('TEMP', ownedParent);
    const fonts = bundledFontBuffers().slice();
    Object.defineProperty(fonts, 1, { get: () => {
      const children = fs.readdirSync(ownedParent);
      expect(children).toHaveLength(1);
      expect(fs.existsSync(join(ownedParent, children[0], '0.ttf'))).toBe(true);
      throw new Error('font bytes unavailable');
    } });
    const callback = vi.fn();
    try {
      expect(() => withNativeFontFiles(fonts, callback)).toThrow('font bytes unavailable');
      expect(callback).not.toHaveBeenCalled();
      expect(fs.readdirSync(ownedParent), 'setup-created child directory must be removed').toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(ownedParent, { recursive: true, force: true });
    }
  });
});
