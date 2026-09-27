/**
 * `.tabs` must reflow instead of overflowing (CRM-UX-5).
 *
 * WHY. `.tabs` was a bare `display: flex` with no wrap, no `overflow-x` and no
 * responsive rule anywhere in `global.css`. Flex items cannot shrink below
 * min-content, so the widest tablist in the app — CRM's eight tabs, ~590px of
 * min-content — pushed a 360px viewport into a horizontal PAGE scroll with the
 * last tabs off-screen, reachable by arrow key but not by touch. VERIFIED at
 * 360px: with `flex-wrap: wrap` the eight tabs lay out on two rows.
 *
 * This is a CSS-contract test and it is worth saying what it does and does not
 * buy. It asserts the DECLARATION is present on the shared rule, which is the
 * thing a later "simplify the tablist" edit would silently drop; it cannot
 * assert that the result is legible or that nothing else clips — those need a
 * browser, and `CT-CRM-1` is the live click-through row that covers them.
 *
 * The negative assertion is the load-bearing half: `overflow-x` other than
 * `visible` computes `overflow-y` to `auto`, which clips at the padding box —
 * and `.tab` carries `margin-bottom: -1px` precisely so its selection underline
 * overlaps the row's `border-bottom`. A scroll container would shave that
 * overlap off EVERY tablist in the app to fix one of them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Comments are not rules — the lesson three gates in this repo learned the hard
// way (a prose mention read as a definition). This file's own docblock names
// both `flex-wrap` and `overflow-x`, so stripping is not optional here.
const css = readFileSync(join(process.cwd(), 'src/styles/global.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** The base `.tabs` rule body (the selector on its own, not `.tabs .x`). */
function tabsRuleBody(): string {
  const match = /(^|\})\s*\.tabs\s*\{([^}]*)\}/.exec(css);
  expect(match, 'a base `.tabs { … }` rule should exist in global.css').toBeTruthy();
  // `noUncheckedIndexedAccess` types a capture group as `string | undefined`. Assert
  // the group rather than coercing with `?? ''`: an empty body would silently satisfy
  // every `toMatch` below as a NON-match, turning this file into a gate that passes
  // when the rule it guards has no declarations at all.
  const body = match![2];
  expect(body, 'the `.tabs` rule should have a body').toBeTruthy();
  return body!;
}

describe('.tabs reflows on a narrow viewport — CRM-UX-5', () => {
  it('declares flex-wrap: wrap so an over-wide tablist reflows instead of overflowing', () => {
    expect(tabsRuleBody()).toMatch(/flex-wrap:\s*wrap/);
  });

  it('separates wrapped rows so a second row does not sit on the first row underline', () => {
    expect(tabsRuleBody()).toMatch(/row-gap:\s*var\(--space-/);
  });

  it('does NOT become a scroll container (that would clip .tab margin-bottom: -1px)', () => {
    expect(tabsRuleBody()).not.toMatch(/overflow/);
  });

  it('keeps the row rule and the flex layout it always had', () => {
    const body = tabsRuleBody();
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/border-bottom:\s*1px solid var\(--rule\)/);
  });
});
