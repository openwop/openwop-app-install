/**
 * ADR 1105 P1 — the margin and allowance worksheets.
 *
 *   - D7: the backend and frontend arithmetic agree on one case table (both
 *     modules imported here), and the rules hold: margin is on price, a target
 *     of 0 needs no markup, overruns are never netted, a missing figure is left
 *     out rather than read as 0;
 *   - D3/D4: the validators are closed (numbers only where a number is
 *     expected, bounded, a currency the ISO 4217 table knows, `lines` required);
 *   - D5: numbers are the base's. A locale overlay's top-level figures and
 *     currency are dropped, and a translated `lines` list keeps the base's
 *     figures (ITEM_BASE_KEYS), as does a columns stat tile's `count`;
 *   - D6: the prerender and markdown carry the worked answer.
 *
 * Red when: either arithmetic copy changes alone; lines under are netted; a
 * string or out-of-range figure is kept; an overlay can change a number; the
 * crawler view loses the computed price or the overrun total.
 */
import { describe, expect, it } from 'vitest';
import * as be from '../src/features/cms/worksheetMath.js';
import * as fe from '../../../frontend/react/src/features/cms/worksheetMath.js';
import { validateSection } from '../src/features/cms/cmsService.js';
import { designSectionHtml, designSectionMarkdown } from '../src/features/cms/designSections.js';

const v = (type: string, data: Record<string, unknown>) => validateSection({ type, data }, 'en', 't1');
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const MARGIN_CASES: { input: be.MarginInput; want: be.MarginResult }[] = [
  { input: { cost: 4000, markup: 25 }, want: { price: 5000, margin: 20 } },
  { input: { cost: 100, markup: 0, target: 0 }, want: { price: 100, margin: 0, markupForTarget: 0 } },
  { input: { cost: 0, markup: 50 }, want: { price: 0 } }, // no margin on a zero price
  { input: { target: 30 }, want: { markupForTarget: (30 / 70) * 100 } },
  { input: { cost: 1000, markup: 100, target: 99 }, want: { price: 2000, margin: 50, markupForTarget: 9900 } },
  { input: { target: 100 }, want: {} }, // a 100% margin needs an infinite markup
  { input: {}, want: {} },
];

const GAP_CASES: { lines: be.GapLine[]; totalOver: number; linesOver: number; linesMissing: number }[] = [
  { lines: [{ name: 'Tile', allowance: 8000, specified: 9500 }, { name: 'Lighting', allowance: 6000, specified: 5200 }], totalOver: 1500, linesOver: 1, linesMissing: 0 },
  { lines: [{ name: 'A', allowance: 10, specified: 10 }], totalOver: 0, linesOver: 0, linesMissing: 0 },
  { lines: [{ name: 'A', allowance: 10 }, { name: 'B', specified: 5 }, { name: 'C', allowance: 1, specified: 3 }], totalOver: 2, linesOver: 1, linesMissing: 2 },
  { lines: [], totalOver: 0, linesOver: 0, linesMissing: 0 },
];

describe('worksheet arithmetic (ADR 1105 D7)', () => {
  it('both halves agree on every margin case', () => {
    for (const c of MARGIN_CASES) {
      expect(be.computeMargin(c.input), JSON.stringify(c.input)).toEqual(c.want);
      expect(fe.computeMargin(c.input), `frontend ${JSON.stringify(c.input)}`).toEqual(c.want);
    }
  });

  it('both halves agree on every gap case, and never net a line under against one over', () => {
    for (const c of GAP_CASES) {
      for (const m of [be, fe]) {
        expect(m.computeGaps(c.lines)).toMatchObject({ totalOver: c.totalOver, linesOver: c.linesOver, linesMissing: c.linesMissing });
      }
    }
    // A missing figure has no `over` (the page shows "No figure"), never 0.
    expect(be.computeGaps([{ name: 'A', allowance: 10 }]).rows[0]).not.toHaveProperty('over');
  });
});

describe('the worksheet validators (ADR 1105 D3/D4)', () => {
  it('marginCalc keeps bounded numbers and a known currency only', () => {
    expect(v('marginCalc', { cost: 4000, markup: 25, target: 30, currency: 'EUR', costLabel: 'Trade price' }).data)
      .toMatchObject({ cost: 4000, markup: 25, target: 30, currency: 'EUR', costLabel: 'Trade price' });
    const junk = v('marginCalc', { cost: '4000', markup: -5, target: 100, currency: 'XYZ' }).data;
    for (const k of ['cost', 'markup', 'target', 'currency']) expect(junk).not.toHaveProperty(k);
  });

  it('allowanceGap needs a named line, and keeps each figure only when it is a number in range', () => {
    expect(() => v('allowanceGap', { lines: [{ allowance: 5 }] })).toThrow(/allowanceGap\.lines is required/);
    const s = v('allowanceGap', { lines: [{ name: 'Tile', allowance: 8000, specified: 'lots' }, { name: 'Lighting', specified: 2e9 }] }).data;
    expect(s.lines).toEqual([{ name: 'Tile', allowance: 8000 }, { name: 'Lighting' }]);
  });
});

describe('numbers are the base\'s (ADR 1105 D5)', () => {
  it('a locale overlay drops the top-level figures and currency', () => {
    const s = validateSection({ type: 'marginCalc', data: { cost: 4000, markup: 25 }, localizations: { es: { costLabel: 'Tu costo', cost: 1, markup: 99, currency: 'EUR' } } }, 'en', 't1');
    expect(s.localizations?.es).toEqual({ costLabel: 'Tu costo' });
  });

  it('a translated lines list keeps the base\'s figures', () => {
    const s = validateSection({
      type: 'allowanceGap',
      data: { lines: [{ name: 'Tile', allowance: 8000, specified: 9500 }, { name: 'Lighting', allowance: 6000 }] },
      localizations: { es: { lines: [{ name: 'Azulejo', allowance: 1, specified: 2 }, { name: 'Iluminación', specified: 7 }] } },
    }, 'en', 't1');
    expect(s.localizations?.es).toEqual({ lines: [{ name: 'Azulejo', allowance: 8000, specified: 9500 }, { name: 'Iluminación', allowance: 6000 }] });
  });

  it('a columns stat tile\'s count follows the base too', () => {
    const s = validateSection({
      type: 'columns',
      data: { layout: 'bento', columns: [{ title: 'Built', text: 'features', count: 140 }] },
      localizations: { fr: { columns: [{ title: 'Construit', text: 'fonctions', count: 9 }] } },
    }, 'en', 't1');
    const col = (s.localizations?.fr as { columns: { count?: number; title: string }[] }).columns[0]!;
    expect(col).toMatchObject({ title: 'Construit', count: 140 });
  });
});

describe('crawlers get the worked answer (ADR 1105 D6)', () => {
  it('marginCalc prints the price and margin for the authored figures', () => {
    const d = v('marginCalc', { cost: 4000, markup: 25, currency: 'USD' }).data;
    const html = designSectionHtml('marginCalc', d, '', esc)!;
    expect(html).toContain('<dt>Client price</dt><dd>$5,000.00</dd>');
    expect(html).toContain('<dt>Gross margin</dt><dd>20%</dd>');
    expect(designSectionMarkdown('marginCalc', d, '')).toContain('- Client price: $5,000.00');
  });

  it('allowanceGap prints each line and the un-netted overrun', () => {
    const d = v('allowanceGap', { currency: 'USD', lines: [{ name: 'Tile', allowance: 8000, specified: 9500 }, { name: 'Lighting', allowance: 6000, specified: 5200 }, { name: 'Fixtures', allowance: 4000 }] }).data;
    const html = designSectionHtml('allowanceGap', d, '', esc)!;
    expect(html).toContain('<tr><td>Tile</td><td>$8,000.00</td><td>$9,500.00</td><td>$1,500.00</td></tr>');
    expect(html).toContain('<td>Fixtures</td><td>$4,000.00</td><td>No figure</td><td>No figure</td>');
    expect(html).toContain('Over the allowance: $1,500.00 on 1 of 3 lines (1 without a figure).');
    expect(designSectionMarkdown('allowanceGap', d, '')).toContain('| Tile | $8,000.00 | $9,500.00 | $1,500.00 |');
  });
});
