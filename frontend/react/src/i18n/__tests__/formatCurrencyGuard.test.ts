/**
 * PROD2-R2 — `formatCurrency` must not throw a render down.
 *
 * `Intl.NumberFormat` raises `RangeError` for any `currency` that is not a
 * well-formed ISO-4217 code. That was harmless while every caller passed a
 * host-authored constant — and became a white-screen the moment a caller passed
 * MODEL-EMITTED text (production plan budgets, validated only as a <=8-char
 * string). `guardDate` in the same module already documents the rule: "a throw
 * inside a render unmounts the React tree… a white screen is not recoverable".
 *
 * Sabotage (wave 51 probes): rethrowing from the fallback, dropping the code from it,
 * or always falling back each red a case. Expectations are literals (en default
 * locale), never computed with the formatter under test.
 */
import { describe, it, expect } from 'vitest';
import { formatCurrency } from '../format.js';

describe('formatCurrency is guarded', () => {
  it('falls back to a plain amount + code instead of throwing', () => {
    for (const bad of ['dollars', '$', 'US$', 'EUROS', '']) {
      expect(() => formatCurrency(6000, bad)).not.toThrow();
      // The amount AND the code the caller passed — "dollars" must still say dollars.
      expect(formatCurrency(6000, bad)).toBe(`6,000 ${bad}`);
    }
  });

  it('still formats a REAL currency properly (the control)', () => {
    // Without this, "never throws" is satisfied by a function that always
    // returns the fallback and never localizes anything.
    expect(formatCurrency(6000, 'USD')).toBe('$6,000.00');
  });
});
