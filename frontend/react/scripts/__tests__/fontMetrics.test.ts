/**
 * DSYS-3 — the metric-fallback overrides are MEASURED, and this is the pin.
 *
 * `tokens.css` used to carry hand-tuned approximations ("tuned for CLS, not
 * lookalikes"). They are now computed from the vendored webfont subsets with
 * fontkit, honoring `OS/2.fsSelection` USE_TYPO_METRICS (both faces set it),
 * and per CSS Fonts 5 the overrides apply BEFORE `size-adjust`, so:
 *
 *   override% = (metric / unitsPerEm) ÷ (size-adjust / 100) × 100
 *
 * This test re-measures the SAME woff2 files and re-derives the expected
 * values from the size-adjust actually written in tokens.css — so it goes red
 * if the fonts are re-subsetted, if size-adjust changes without re-deriving
 * the overrides, or if the pinned numbers drift by hand.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// fontkit is CJS; vitest's ESM default-interop hands back undefined here.
const fontkit = createRequire(import.meta.url)('fontkit') as { openSync: (p: string) => unknown };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKENS = readFileSync(join(ROOT, 'src/styles/foundations/tokens.css'), 'utf8');

interface Face { family: string; woff2: string }
const FACES: Face[] = [
  { family: 'Geist Fallback', woff2: 'e2e/assets/fonts/gyByhwUxId8gMEwcGFWNOITd.woff2' },
  { family: 'Instrument Serif Fallback', woff2: 'e2e/assets/fonts/jizBRFtNs2ka5fXjeivQ4LroWlx-6zUTjnTLgNs.woff2' },
];

/** The @font-face block for one family, parsed for its descriptor values. */
function faceBlock(family: string): Record<string, string> {
  const m = TOKENS.match(new RegExp(`@font-face\\s*\\{[^}]*font-family:\\s*'${family}'[^}]*\\}`));
  expect(m, `@font-face for '${family}' present in tokens.css`).toBeTruthy();
  const out: Record<string, string> = {};
  for (const d of m![0].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) out[d[1]!] = d[2]!.trim();
  return out;
}

const pct = (v: string): number => Number(v.replace('%', ''));

describe('DSYS-3 — metric-fallback overrides match the measured webfonts', () => {
  for (const face of FACES) {
    it(`${face.family}: ascent/descent/line-gap match the woff2, USE_TYPO_METRICS honored`, () => {
      const font = fontkit.openSync(join(ROOT, face.woff2)) as unknown as {
        unitsPerEm: number; ascent: number; descent: number; lineGap: number;
        'OS/2': { typoAscender: number; typoDescender: number; typoLineGap: number; fsSelection: { useTypoMetrics?: boolean } };
      };
      const os2 = font['OS/2'];
      // Both vendored faces set the bit; if a re-subset ever clears it the
      // formula's inputs change — fail loudly rather than silently mis-pin.
      expect(os2.fsSelection.useTypoMetrics, 'USE_TYPO_METRICS set').toBe(true);
      const upem = font.unitsPerEm;
      const asc = os2.typoAscender;
      const desc = Math.abs(os2.typoDescender);
      const gap = os2.typoLineGap;

      const block = faceBlock(face.family);
      const sizeAdjust = pct(block['size-adjust']!) / 100;
      const expected = (metric: number): number => Math.round((metric / upem / sizeAdjust) * 10000) / 100;

      expect(pct(block['ascent-override']!), 'ascent-override').toBeCloseTo(expected(asc), 2);
      expect(pct(block['descent-override']!), 'descent-override').toBeCloseTo(expected(desc), 2);
      expect(pct(block['line-gap-override']!), 'line-gap-override').toBeCloseTo(expected(gap), 2);
    });
  }
});
