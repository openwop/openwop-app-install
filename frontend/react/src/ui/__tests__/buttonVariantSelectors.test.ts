/**
 * Every `ui/Button` variant must map to a class the stylesheet ACTUALLY defines.
 *
 * WHY (grade-code `DYNBTN-6`). Three dead classes have now been found by
 * accident, each rendering as an unintended filled-clay primary: `btn--ghost`,
 * `.btn-secondary`, and `link-button`. `check-orphan-classes` was widened with
 * the `btn-` prefix, but that would NOT have caught `link-button` — it carries
 * no registered prefix. The variant vocabulary is small and closed, so pin it
 * directly instead of hoping a prefix heuristic covers it: if someone points a
 * variant at a class that does not exist, the button silently becomes primary,
 * and this fails instead.
 *
 * The classes are read from the REAL component (each variant is rendered with
 * `renderToStaticMarkup`), never from a hand-kept mirror: a mirror passes when
 * `Button.tsx` is pointed at a dead class, which is the exact DYNBTN-6 shape.
 * The variant list is an exhaustive `Record<ButtonVariant, true>`, so `tsc`
 * forces a new variant to be listed here.
 *
 * Scope, stated so a green run is not over-read: this asserts the class NAMES
 * resolve to selectors in the authored stylesheets. It says nothing about what
 * those rules look like, or about specificity — `a.btn` beating bare
 * `.btn-ghost` is a real bug this cannot see (it cost a review round on the
 * Entities export pair).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, type ButtonVariant, type ButtonSize } from '../Button.js';

const CSS_FILES = [
  'src/styles/foundations/tokens.css',
  'src/styles/global.css',
  'src/styles/primitives/adr0510.css',
  'src/brand/brand.css',
];

/** Exhaustive by type: adding a ButtonVariant without listing it fails tsc. */
const ALL_VARIANTS: Record<ButtonVariant, true> = {
  primary: true,
  secondary: true,
  quiet: true,
  danger: true,
  link: true,
  accent: true,
  'accent-solid': true,
};

/** The class tokens the REAL Button renders for a variant/size. */
function renderedClasses(variant: ButtonVariant, size: ButtonSize = 'md'): string[] {
  const html = renderToStaticMarkup(createElement(Button, { variant, size }, 'x'));
  const m = /class="([^"]*)"/.exec(html);
  return m ? m[1]!.split(/\s+/).filter(Boolean) : [];
}

function definedClasses(): Set<string> {
  const out = new Set<string>();
  for (const rel of CSS_FILES) {
    // Comments are not definitions: global.css says "there is deliberately NO
    // .primary/.btn-primary class", and reading that prose as a definition is
    // how a dead class passed a gate before.
    const css = readFileSync(join(process.cwd(), rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) out.add(m[1]!);
  }
  return out;
}

const VARIANTS = Object.keys(ALL_VARIANTS) as ButtonVariant[];

describe('ui/Button variant classes resolve to real selectors', () => {
  const defined = definedClasses();

  it.each(VARIANTS.map((v) => [v, renderedClasses(v).join(' ')] as const))('variant "%s" → %s', (variant) => {
    for (const token of renderedClasses(variant)) {
      expect(defined.has(token), `.${token} is not defined in any authored stylesheet`).toBe(true);
    }
  });

  it('size="sm" → every rendered class is defined (incl. .btn-sm)', () => {
    const tokens = renderedClasses('secondary', 'sm');
    expect(tokens).toContain('btn-sm');
    for (const token of tokens) expect(defined.has(token), `.${token} is not defined`).toBe(true);
  });

  it('SABOTAGE — a class that does not exist is detected', () => {
    expect(defined.has('link-button')).toBe(false); // the third dead class, now unused
    expect(defined.has('btn--ghost')).toBe(false); // the first
  });

  it('primary is deliberately bare — .primary must NOT exist', () => {
    // Behavioural: the real primary Button renders with no class at all.
    expect(renderToStaticMarkup(createElement(Button, { variant: 'primary' }, 'x'))).not.toMatch(/class=/);
    expect(defined.has('primary')).toBe(false);
  });
});
