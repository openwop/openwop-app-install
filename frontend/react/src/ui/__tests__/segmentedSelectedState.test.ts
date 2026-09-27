/**
 * A `.segmented` control must show its selection in BOTH of its ARIA idioms.
 *
 * WHY (grade-ux `DS-SEG-1`). `.segmented` is used two ways in this app: as a
 * toggle group (`aria-pressed`) and as a tablist (`aria-selected` — see
 * `runs/RunDetailPage.tsx`). Only the pressed arm was styled, so a tablist
 * rendered its selected tab **byte-identically** to the unselected ones; it was
 * measured that way in Chromium before the fix. The `variant` prop cannot
 * rescue it either: `.segmented > button` is (0,1,1) and resets background,
 * colour and border on every variant, so the component looked correct in source
 * and wrong on screen.
 *
 * This is a CSS-contract test, and it is worth saying what that does and does
 * not buy: it asserts the SELECTOR exists, not that the result is legible or
 * that specificity lets it win. Those need a browser — `e2e/token-contrast`
 * covers contrast, and the live check is `DS-SEG-1`'s click-through row.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'src/styles/global.css'), 'utf8')
  // Comments are not rules — the lesson three gates in this repo learned the
  // hard way (a prose mention read as a definition).
  .replace(/\/\*[\s\S]*?\*\//g, '');

describe('.segmented selection is visible in both ARIA idioms', () => {
  it('styles the aria-pressed (toggle-group) selection', () => {
    expect(css).toMatch(/\.segmented\s*>\s*button\[aria-pressed="true"\]/);
  });

  it('styles the aria-selected (tablist) selection — DS-SEG-1', () => {
    expect(css).toMatch(/\.segmented\s*>\s*button\[aria-selected="true"\]/);
  });

  it('both arms carry an actual visual change, not just a selector', () => {
    const rule = /\.segmented\s*>\s*button\[aria-pressed="true"\][^{]*\{([^}]*)\}/.exec(css);
    expect(rule, 'the pressed/selected rule should exist').toBeTruthy();
    expect(rule![1]).toMatch(/background/);
    expect(rule![1]).toMatch(/color/);
  });

  it('SABOTAGE — the segmented base still resets variants, so the rule is load-bearing', () => {
    // If this ever stops being true the selection could come from the variant
    // instead, and the rule above would be redundant rather than required.
    const base = /\.segmented\s*>\s*button\s*\{([^}]*)\}/.exec(css);
    expect(base, '.segmented > button base rule should exist').toBeTruthy();
    expect(base![1]).toMatch(/border:\s*none/);
  });
});
