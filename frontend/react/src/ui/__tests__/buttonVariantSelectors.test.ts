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
 * Scope, stated so a green run is not over-read: this asserts the class NAMES
 * resolve to selectors in the authored stylesheets. It says nothing about what
 * those rules look like, or about specificity — `a.btn` beating bare
 * `.btn-ghost` is a real bug this cannot see (it cost a review round on the
 * Entities export pair).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS_FILES = [
  'src/styles/foundations/tokens.css',
  'src/styles/global.css',
  'src/styles/primitives/adr0510.css',
  'src/brand/brand.css',
];

/** Mirrors VARIANT_CLASS + the size modifier in ui/Button.tsx. */
const VARIANT_CLASSES: Record<string, string> = {
  primary: '', // bare IS primary — there is deliberately no .primary class
  secondary: 'secondary',
  quiet: 'btn-ghost',
  danger: 'secondary u-text-danger',
  link: 'btn-link',
  accent: 'btn-accent',
  'accent-solid': 'btn-accent-solid',
};
const SIZE_SM = 'btn-sm';

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

describe('ui/Button variant classes resolve to real selectors', () => {
  const defined = definedClasses();

  it.each(Object.entries(VARIANT_CLASSES))('variant "%s" → %s', (_variant, classes) => {
    for (const token of classes.split(/\s+/).filter(Boolean)) {
      expect(defined.has(token), `.${token} is not defined in any authored stylesheet`).toBe(true);
    }
  });

  it(`size="sm" → .${SIZE_SM}`, () => {
    expect(defined.has(SIZE_SM)).toBe(true);
  });

  it('SABOTAGE — a class that does not exist is detected', () => {
    expect(defined.has('link-button')).toBe(false); // the third dead class, now unused
    expect(defined.has('btn--ghost')).toBe(false); // the first
  });

  it('primary is deliberately bare — .primary must NOT exist', () => {
    expect(VARIANT_CLASSES.primary).toBe('');
    expect(defined.has('primary')).toBe(false);
  });
});
