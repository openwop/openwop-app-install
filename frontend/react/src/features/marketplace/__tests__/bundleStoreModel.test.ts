/**
 * ADR 0820 §7 UI — the store's figures come from the operator's display strings
 * and are never fabricated: an ambiguous string parses to null and hides the
 * derived figure instead of guessing.
 *
 * Sabotage-witnessed (/grade-tests wave 10): dropping the plain/grouped token check,
 * the one-number rule, the `> 0` floor or the comma strip reds a parseAmount case;
 * keeping a zero saving or dropping the template's currency shape reds a saving case.
 */
import { describe, it, expect } from 'vitest';
import { annualSaving, formatLike, parseAmount } from '../bundleStoreModel.js';

describe('parseAmount', () => {
  it('reads plain and US-grouped amounts with any currency affix', () => {
    expect(parseAmount('$29')).toBe(29);
    expect(parseAmount('$1,290')).toBe(1290);
    expect(parseAmount('$65.83')).toBe(65.83);
    expect(parseAmount('29 €')).toBe(29);
  });
  it('refuses what it cannot read unambiguously', () => {
    expect(parseAmount(undefined)).toBeNull();
    expect(parseAmount('Ask us')).toBeNull();
    expect(parseAmount('1.290,00 €')).toBeNull(); // European grouping — ambiguous here
    expect(parseAmount('$29–$49')).toBeNull(); // two numbers
    expect(parseAmount('$0')).toBeNull(); // nothing to save against
  });
});

describe('annualSaving / formatLike', () => {
  it('computes the real saving in the template’s currency shape', () => {
    expect(annualSaving('$29', '$290')).toEqual({ amount: '$58', pct: 17 });
    expect(formatLike('29 €', 58)).toBe('58 €');
  });
  it('is null when there is no saving or a price does not parse', () => {
    expect(annualSaving('$49', '$588')).toBeNull();
    expect(annualSaving('$49', '$600')).toBeNull();
    expect(annualSaving('$49', 'call us')).toBeNull();
  });
});
