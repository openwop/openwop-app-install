/**
 * The footer lockup must follow the light/dark switch. A `display` on
 * `.public-shell .app-footer__lockup` outranks `.brandlogo--dark { display: none }`
 * (adr0510.css), so a brand with a dark lockup showed both in the footer.
 * Sabotage: put `display: block` back on that rule.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', '..', 'styles', 'global.css'), 'utf8');

describe('footer lockup theme switch', () => {
  it('sets no display on the footer lockup, so the theme switch decides', () => {
    const rules = [...css.matchAll(/(^|\n)([^{}\n]*\.app-footer__lockup[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, , selector = '', body = ''] of rules) {
      if (/brandlogo--/.test(selector)) continue;
      expect(body, selector).not.toMatch(/(^|;)\s*display\s*:/);
    }
  });
});
