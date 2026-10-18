/**
 * ADR 0889 grade remediation (AE-1) — es, fr and pt-BR write decimals with a
 * comma. `Number('0,5')` is NaN; `parseDecimal` must read the locale's own
 * separator, still accept a pasted `.`, and drop grouping.
 */
import { describe, it, expect } from 'vitest';
import { parseDecimal, showDecimal } from '../agent/localeNumber.js';

describe('parseDecimal / showDecimal', () => {
  it.each([
    ['0,5', 'fr', 0.5], ['0,5', 'es', 0.5], ['0,5', 'pt-BR', 0.5],
    ['0.5', 'fr', 0.5], ['0.5', 'es', 0.5], ['0.5', 'en', 0.5],
    ['1 000,25', 'fr', 1000.25], ['1.000,25', 'es', 1000.25], ['1,000.25', 'en', 1000.25],
    [' 7 ', 'en', 7], ['-0,25', 'pt-BR', -0.25],
  ])('%s in %s → %s', (text, locale, expected) => {
    expect(parseDecimal(text, locale)).toBe(expected);
  });

  it('reads blank as absent and junk as NaN', () => {
    expect(parseDecimal('  ', 'fr')).toBeUndefined();
    expect(parseDecimal('0,5,5', 'fr')).toBeNaN();
    expect(parseDecimal('half', 'en')).toBeNaN();
  });

  it('shows a number back with the locale decimal and no grouping', () => {
    expect(showDecimal(0.7, 'fr')).toBe('0,7');
    expect(showDecimal(9000, 'fr')).toBe('9000');
    expect(showDecimal(0.7, 'en')).toBe('0.7');
    expect(showDecimal(undefined, 'en')).toBe('');
  });
});
