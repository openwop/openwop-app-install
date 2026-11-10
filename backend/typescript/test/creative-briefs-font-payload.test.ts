import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bundledFontBuffers, BUNDLED_FONT_FAMILIES, BUNDLED_FONTS_VERSION } from '../src/features/creative-briefs/render/fonts.js';

// Independent byte pins from the four embedded faces before the representation
// change. Reformatting opaque base64 must not silently change replayed pixels
// while retaining the same renderer version (ADR 0399).
// Sabotage-witnessed (wave 92): dropping or duplicating a face, changing one base64
// byte, truncating the decode, bumping BUNDLED_FONTS_VERSION, or renaming a family all
// turn this case red. Order is pinned on purpose: brand-fonts and creative-briefs-render
// tests read the array by position ([0] Inter, [2] PT Serif).
const FACES = [
  { bytes: 411640, sha256: '40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82' },
  { bytes: 420428, sha256: '288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f' },
  { bytes: 359048, sha256: 'a4951fade06ff8f09b7673aa81ffb65a8cd409e24d3289a6dc670bc4dda2557a' },
  { bytes: 339996, sha256: '038ba7336bd7ea14f12ad155bed51a4345cac5153275d521dec3ba04021c526e' },
];

describe('bundled render font payloads (ADR 0399)', () => {
  it('keeps every decoded face byte-identical under the existing replay version', () => {
    const fonts = bundledFontBuffers();
    expect(fonts).toHaveLength(FACES.length);
    expect(fonts.map((font) => ({ bytes: font.byteLength, sha256: createHash('sha256').update(font).digest('hex') }))).toEqual(FACES);
    expect(BUNDLED_FONTS_VERSION).toBe('inter-4.1+ptserif-2010');
    expect(BUNDLED_FONT_FAMILIES).toEqual({ sans: 'Inter', serif: 'PT Serif' });
  });
});
