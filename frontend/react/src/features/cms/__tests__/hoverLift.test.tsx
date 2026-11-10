/**
 * ADR 1038 P7 — the public hover lift is a brand token, keyboard focus gets it
 * too, and both reduced-motion signals stop it.
 * Guards (CSS, which jsdom cannot run):
 * - a LINKED card lifts by `--hover-lift` (3px stock; the presets set 5px / 0)
 *   on hover AND on `:focus-visible`; a card that is not a link never lifts
 *   (hover promises a click; ADR 1038 D7 correction, 2026-11-04);
 * - the showcase card lifts by the same token, the prompt card by two thirds
 *   of it;
 * - the OS setting and the in-app "Reduce motion" setting both cancel it, for
 *   the card, the showcase card and the prompt card;
 * - the lift is `translate`, so a `stagger` reveal (which animates `transform`
 *   with fill-mode both) cannot cancel it;
 * - the token exists in both token sources.
 *
 * Sabotage-witnessed (grade-tests w97, r1): lifting every `.fp-card`, dropping
 * `:focus-visible` from the lift, hard-coding the card or showcase lift,
 * lifting with `transform`, dropping the OS or the in-app reduced-motion rule,
 * and changing either token source each turn a case red. Added in r2 (the r1
 * probes were vacuous): hard-coding the prompt lift, dropping the prompt
 * card's OS reduced-motion rule, and renaming the stagger rule.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = join(__dirname, '..', '..', '..', 'styles');
const css = readFileSync(join(styles, 'global.css'), 'utf8');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The design-token object whose `$extensions.openwop.cssName` is `name`. */
function findToken(node: unknown, name: string): Record<string, unknown> | null {
  if (!isRecord(node)) return null;
  const ext = node.$extensions;
  if (isRecord(ext) && isRecord(ext.openwop) && ext.openwop.cssName === name) return node;
  for (const child of Object.values(node)) {
    const hit = findToken(child, name);
    if (hit) return hit;
  }
  return null;
}

describe('the hover lift', () => {
  it('lifts by the token on hover and on keyboard focus', () => {
    expect(css).toMatch(/\.fp-card--link:hover,\n\.fp-card--link:focus-visible \{ translate: 0 calc\(var\(--hover-lift\) \* -1\);/);
    // A card that is not a link never lifts: hover would promise a click it cannot keep.
    expect(css).not.toMatch(/\.fp-card:hover[,{ ]/);
    expect(css).toMatch(/\.fp-showcase-card--link:hover, \.fp-showcase-card--link:focus-visible \{ translate: 0 calc\(var\(--hover-lift\) \* -1\);/);
    // The prompt card shares the token: two thirds of the card lift.
    expect(css).toMatch(/\.fp-prompt--link:hover, \.fp-prompt--link:focus-visible \{ translate: 0 calc\(var\(--hover-lift\) \* -2 \/ 3\);/);
    expect(css).not.toMatch(/\.fp-(card|showcase-card--link|prompt--link):hover \{ transform: translateY\(-\dpx\)/);
  });

  it('uses translate, which a stagger reveal (it animates transform with fill both) cannot cancel', () => {
    expect(css).toMatch(/@keyframes fp-reveal \{[^}]*transform/);
    const at = css.indexOf('.fp-motion--stagger .fp-stagger > * {');
    expect(at).toBeGreaterThan(-1);
    const staggerRule = css.slice(at, css.indexOf('}', at));
    expect(staggerRule).toContain('animation-name: fp-reveal;');
    expect(staggerRule).toContain('animation-fill-mode: both;');
    const lift = /\.fp-card--link:focus-visible \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(lift).toContain('translate:');
    expect(lift).not.toContain('transform:');
  });

  it('stops under both reduced-motion signals', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^\n]*\.fp-card--link:hover, \.fp-card--link:focus-visible, \.fp-showcase-card--link:is\(:hover, :focus-visible\) \{ translate: none; \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^\n]*\.fp-prompt--link:hover, \.fp-prompt--link:focus-visible \{ translate: none; \}/);
    expect(css).toContain(':root[data-reduce-motion="reduce"] :is(.fp-card--link:hover, .fp-card--link:focus-visible, .fp-showcase-card--link:hover, .fp-showcase-card--link:focus-visible, .fp-prompt--link:hover, .fp-prompt--link:focus-visible) { translate: none; }');
    expect(css).toContain(':root[data-reduce-motion="reduce"] .fp-btn:hover { transform: none; }');
  });

  it('is a token in both sources, stock 3px', () => {
    expect(readFileSync(join(styles, 'foundations', 'tokens.css'), 'utf8')).toMatch(/--hover-lift: 3px;/);
    const tokens: unknown = JSON.parse(readFileSync(join(styles, 'tokens.json'), 'utf8'));
    const token = findToken(tokens, '--hover-lift');
    expect(token).not.toBeNull();
    expect(token?.$value).toBe('3px');
  });
});
