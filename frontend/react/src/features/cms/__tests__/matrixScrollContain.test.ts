/**
 * ADR 0485 (the comparison matrix): the table's scroll box must be the
 * containing block for the cells' `.sr-only` labels.
 *
 * WHY. `.sr-only` is `position: absolute`. When `.fp-matrix__scroll` was
 * `position: static`, those labels' containing block was the `.fp-section`
 * above it, which does not clip, so they escaped the scroll box and widened
 * the page: measured on myndhyve.ai /p/capabilities at 390×844 as
 * `scrollWidth` 930 (an 8-column table, 91 labels). With `position: relative`
 * on the scroll box it clips them and the page is 390 wide again (fix
 * `1778b9c81`, witnessed red without it).
 *
 * This is a CSS-contract test: it reads every top-level `.fp-matrix__scroll`
 * rule (a lookbehind, so a rule written straight after another is not skipped)
 * and asserts that one of them sets `overflow-x: auto` and that the position the
 * cascade ends on is `relative`, so a later override cannot undo it unseen. The
 * 390px check itself is a browser measurement.
 *
 * Sabotage-witnessed (/grade-tests wave 88): `position: static` on the rule,
 * dropping `overflow-x: auto`, or appending a later `position: static` override
 * each turn the case red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'src/styles/global.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));

/** How many blocks are open at `index` (0 = top level). */
function depthAt(index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
  }
  return depth;
}

describe('.fp-matrix__scroll contains its absolutely positioned labels', () => {
  it('declares position: relative on the scroll box that sets overflow-x: auto', () => {
    const rules = [...css.matchAll(/(?<=^|\})\s*\.fp-matrix__scroll\s*\{([^}]*)\}/g)]
      .filter((m) => depthAt(m.index ?? -1) === 0)
      .map((m) => m[1] ?? '');
    const scroll = rules.find((body) => /overflow-x:\s*auto/.test(body));
    expect(scroll, 'the .fp-matrix__scroll rule with overflow-x: auto').toBeDefined();
    expect(scroll).toMatch(/position:\s*relative/);
    // The cascade's last word on `position` across every such rule.
    const positions = rules.flatMap((body) => [...body.matchAll(/(?<![\w-])position:\s*([a-z-]+)/g)].map((m) => m[1]));
    expect(positions[positions.length - 1]).toBe('relative');
  });
});
