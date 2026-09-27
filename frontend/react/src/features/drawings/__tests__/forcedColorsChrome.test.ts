/**
 * DRU-1 — the drawing selection chrome must survive `forced-colors: active`
 * (Windows High Contrast Mode).
 *
 * THE DEFECT. The selection outline, resize handles, rotate knob, marquee, and
 * the two-colour snap/space guides are all authored with custom color tokens
 * (`--clay-text`, `--guide-align`, `--guide-space`, `--color-info`) and some
 * with low opacity (sym-axis 0.6, rotate-stalk 0.7). Under forced-colors the UA
 * replaces author colors with a small system palette, so the distinct
 * affordances collapse to one colour and the faint ones can wash out — an HCM
 * user loses the selection affordances entirely. `global.css` had ZERO
 * `@media (forced-colors: active)` blocks (an app-wide gap; this closes it for
 * the drawing chrome).
 *
 * WHY A CSS-CONTENT RATCHET. There is no headless browser here, so the actual
 * HCM RENDER is a human click-through (CT-DRU-1). What this test CAN pin, and
 * what actually regressed, is that the chrome is (a) covered by a forced-colors
 * block, (b) remapped to real system colours (not an empty block), and (c) the
 * two-colour guide language stays DISTINGUISHABLE (align ≠ space) rather than
 * collapsing to a single system colour. Mirrors the global.css ratchet idiom
 * (anchorHoverSpecificity / buttonVariantSelectors).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(process.cwd(), 'src/styles/global.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

const SYSTEM_COLOR = 'Highlight|HighlightText|CanvasText|Canvas|LinkText|ButtonText|GrayText|Mark|MarkText';

/** Body of the first `@media (forced-colors: active)` block, brace-balanced
 *  (the flat rule matcher used elsewhere can't see nested at-rules). '' if absent. */
function forcedColorsBlock(): string {
  const m = CSS.match(/@media\s*\(\s*forced-colors\s*:\s*active\s*\)\s*\{/);
  if (!m || m.index === undefined) return '';
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  for (; i < CSS.length && depth > 0; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}') depth--;
  }
  return CSS.slice(start, i - 1);
}

/** The system colour a chrome selector sets on `stroke` inside the block, or null. */
function strokeColorFor(block: string, sel: string): string | null {
  const re = new RegExp(`[^{}]*cv-draw-interactive__${sel}[^{}]*\\{([^{}]*)\\}`, 'g');
  let found: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block))) {
    const c = match[1]!.match(new RegExp(`stroke:\\s*(${SYSTEM_COLOR})`));
    if (c) found = c[1]!;
  }
  return found;
}

describe('DRU-1 — drawing selection chrome survives forced-colors (Windows High Contrast)', () => {
  const block = forcedColorsBlock();

  it('global.css has a forced-colors block (author colours collapse to the system palette in HCM)', () => {
    expect(
      block,
      'no `@media (forced-colors: active)` block in global.css — HCM users lose the drawing selection affordances',
    ).not.toBe('');
  });

  it('remaps the selection outline, handles and marquee to real system colours', () => {
    for (const sel of ['__outline-top', '__handle', '__vertex', '__marquee']) {
      expect(block, `the forced-colors block does not cover .cv-draw-interactive${sel}`).toContain(
        `cv-draw-interactive${sel}`,
      );
    }
    expect(
      block,
      'the forced-colors block sets no system colour — an empty/opacity-only block does not restore HCM affordances',
    ).toMatch(new RegExp(`\\b(${SYSTEM_COLOR})\\b`));
  });

  it('keeps the two-colour guide language distinguishable — align and space guides use DIFFERENT system colours', () => {
    const align = strokeColorFor(block, 'snap-guide');
    const space = strokeColorFor(block, 'space-span');
    expect(align, 'align guide (snap-guide) has no system-colour stroke in the forced-colors block').toBeTruthy();
    expect(space, 'space guide (space-span) has no system-colour stroke in the forced-colors block').toBeTruthy();
    expect(align, 'the two-colour guide language collapsed to a single HCM colour').not.toBe(space);
  });
});
