/**
 * ADR 1032 — the try-it switch must look like a switch (found live 2026-11-03).
 *
 * WHY. The switch is an `<input type="checkbox">` inside a `<label>` row, so two
 * app-wide form rules reach it:
 * - `input, textarea, select { padding: var(--space-2) var(--space-3); border: … }`
 *   under `* { box-sizing: border-box }` ate the 44px width: the switch computed
 *   to 2px wide and drew as a thin bar;
 * - `label { font-family: var(--mono); text-transform: uppercase; … }` turned the
 *   step names into tiny uppercase mono form labels.
 * - `input[type="checkbox"], input[type="radio"] { width: auto }` is (0,1,1) and
 *   beat `.fp-try__switch { inline-size: 44px }` (0,1,0) — width and inline-size
 *   are the same property — so the appearance:none switch collapsed to 0px wide
 *   even after the padding fix (found live on 76a6e51f3).
 * jsdom never computed either, so the markup tests in canvasLayouts.test.tsx
 * stayed green. This CSS-contract test pins the resets on the two rules; what it
 * cannot see (the rendered pill) is checked in the browser. The width contest
 * scans every rule, including those nested in @media/@supports blocks.
 *
 * Sabotage-witnessed (w85): `padding: 2px` or `border: 1px solid` on the switch
 * rule reds case 1. Dropping the `.fp-try__row` qualifier reds cases 1 and 2. A
 * stronger global `input[type="checkbox"]:hover:focus { width: auto }` reds case 2,
 * at top level and as the first rule in an @media block. Dropping the row's
 * `text-transform: none`, or making its font `var(--mono)`, reds case 3.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'src/styles/global.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `a base \`${selector} { … }\` rule should exist in global.css`).toBeTruthy();
  const body = match![2];
  expect(body, `${selector} should declare something`).toBeTruthy();
  return body as string;
}

/** CSS specificity (a,b,c) for a simple selector without :is/:not/:where. */
function specificity(sel: string): [number, number, number] {
  const ids = (sel.match(/#[\w-]+/g) ?? []).length;
  const pseudoEls = (sel.match(/::[\w-]+/g) ?? []).length;
  const noPseudoEls = sel.replace(/::[\w-]+/g, '');
  const classes = (noPseudoEls.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []).length;
  const types = (noPseudoEls.replace(/\[[^\]]+\]/g, '').match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return [ids, classes, types + pseudoEls];
}
const compare = (x: number[], y: number[]) => x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;

describe('ADR 1032 try-it switch CSS', () => {
  it('the switch drops the global input padding and border, so it keeps its 44px pill', () => {
    const body = ruleBody('.fp-try__row .fp-try__switch');
    expect(body).toMatch(/(^|;)\s*padding:\s*0\s*(;|$)/);
    expect(body).toMatch(/(^|;)\s*border:\s*0\s*(;|$)/);
    expect(body).toMatch(/inline-size:\s*44px/);
  });

  it('the switch sizing rule wins on width over every global rule that can reach the switch', () => {
    // A rule starts after `}` OR `{`: the first rule inside an @media/@supports
    // block follows its `{` (206 such rules were invisible to a `}`-only scan).
    // `[^{}@]` still refuses an at-rule header as a selector.
    const rules = [...css.matchAll(/(?<=^|[{}])\s*([^{}@]+?)\s*\{([^{}]*)\}/g)].map((m, order) => ({
      selectors: (m[1] as string).split(',').map((x) => x.trim()).filter(Boolean),
      body: m[2] as string,
      order,
    }));
    const setsWidth = (body: string) => /(^|;)\s*(width|inline-size)\s*:/.test(body);
    // Unqualified global input rules: no class, id or combinator, so they reach
    // every <input type="checkbox"> on the page, the switch included.
    const reachesSwitch = (sel: string) =>
      /^input(\[type=("|')?checkbox\2?\])?(:[\w-]+(\([^)]*\))?)*$/.test(sel);
    const globals = rules.flatMap((r) =>
      setsWidth(r.body) ? r.selectors.filter(reachesSwitch).map((sel) => ({ sel, order: r.order })) : [],
    );
    expect(globals.map((g) => g.sel), 'the global checkbox width rule is still there to beat').toContain(
      'input[type="checkbox"]',
    );
    const sizing = rules.filter(
      (r) => /inline-size:\s*44px/.test(r.body) && r.selectors.some((x) => /fp-try__switch$/.test(x)),
    );
    expect(sizing.length, 'exactly one rule sizes the switch to 44px').toBe(1);
    const own = sizing[0]!;
    const ownSel = own.selectors.find((x) => /fp-try__switch$/.test(x))!;
    for (const g of globals) {
      const cmp = compare(specificity(ownSel), specificity(g.sel));
      expect(
        cmp > 0 || (cmp === 0 && own.order > g.order),
        `\`${ownSel}\` ${specificity(ownSel).join(',')} must beat \`${g.sel}\` ${specificity(g.sel).join(',')}`,
      ).toBe(true);
    }
  });

  it('the row (a <label>) resets the global form-label type', () => {
    const body = ruleBody('.fp-try__row');
    expect(body).toMatch(/text-transform:\s*none/);
    expect(body).toMatch(/font-family:\s*var\(--sans\)/);
    expect(body).toMatch(/letter-spacing:\s*normal/);
    expect(body).toMatch(/(^|;)\s*margin:\s*0\s*(;|$)/);
  });
});
