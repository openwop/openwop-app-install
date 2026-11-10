/**
 * ADR 1066 AGEN-01 (decided 2026-11-07) — the apps picture's still state fans
 * the cards instead of stacking all of them in full.
 *
 *   - still (reduced motion, motion off, or no motion path): every card shares
 *     one grid cell, the first in front; each later card is raised by one bar
 *     height so its name shows, and the stack reserves that room on top;
 *   - on the motion path the fan is undone (no offset, no reserved room), so
 *     the cross-fade is unchanged. The reset is scoped to the motion path, so
 *     the in-app "Reduce motion" setting and `fp-motion--none` keep the fan.
 *
 * jsdom does not evaluate media queries, so this reads the stylesheet: the
 * still rules sit OUTSIDE the motion block, and the motion block resets them.
 * The motion block is found by any `@media` prelude carrying
 * `(prefers-reduced-motion: no-preference)`, with or without `screen and`.
 *
 * Sabotage-witnessed (grade-tests w97, r1): dropping the shared cell, flipping
 * the z-order, shrinking the raise back to 44px, dropping the reserved room,
 * dropping the chip's z-index, moving the chip rule into the motion block, and
 * dropping either motion-path reset each turn a case red. Added in r2 (the r1
 * probe was vacuous): dropping the reset's motion-path scope.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');
// 48px. The first cut (--space-3, 44px) clipped the back cards' names (screenshot 2026-11-08).
const PEEK = '(var(--space-6) + var(--space-4))';
const SCOPE = ':root:not([data-reduce-motion="reduce"]) .fp-hero:not(.fp-motion--none) ';

/** The still rules (marker → motion block) and the motion block itself. */
function regions(): { still: string; motion: string } {
  const start = css.indexOf('ADR 1066 AGEN-01');
  if (start < 0) throw new Error('AGEN-01 region not found: marker missing');
  const guard = /@media\b[^{]*\(prefers-reduced-motion:\s*no-preference\)[^{]*\{/g;
  guard.lastIndex = start;
  const motionAt = guard.exec(css)?.index ?? -1;
  if (motionAt < 0) throw new Error('AGEN-01 region not found: motion block missing');
  const motionEnd = css.indexOf('\n}\n', motionAt);
  if (motionEnd < 0) throw new Error('AGEN-01 region not found: motion block unterminated');
  return { still: css.slice(start, motionAt), motion: css.slice(motionAt, motionEnd) };
}

describe('apps picture still state (ADR 1066 AGEN-01)', () => {
  it('fans the cards in one cell, the first in front and each later one raised by a bar', () => {
    const { still } = regions();
    const app = still.match(/\.fp-apps--loop \.fp-apps__app \{([^}]*)\}/)?.[1] ?? '';
    expect(app).toContain('grid-area: 1 / 1;');
    expect(app).toContain('z-index: calc(var(--n, 1) - var(--i, 0));');
    expect(app).toContain(`translateY(calc(var(--i, 0) * -1 * ${PEEK}))`);
    const stack = still.match(/\.fp-apps--loop \.fp-apps__stack \{([^}]*)\}/)?.[1] ?? '';
    expect(stack).toContain(`padding-block-start: calc((var(--n, 1) - 1) * ${PEEK});`);
  });

  it('keeps the chip above the fanned cards (the front card is z-index --n)', () => {
    const { still } = regions();
    expect(still).toMatch(/\.fp-apps--loop \.fp-apps__chip \{ z-index: calc\(var\(--n, 1\) \+ 1\); \}/);
  });

  it('undoes the fan on the motion path, so the cross-fade is unchanged', () => {
    const { motion } = regions();
    expect(motion).toContain(`${SCOPE}.fp-apps--loop .fp-apps__stack { gap: 0; padding-block-start: 0; }`);
    expect(motion).toContain(`${SCOPE}.fp-apps--loop .fp-apps__app { z-index: auto; transform: none; }`);
  });
});
