/**
 * PROD2-R2 — `formatCurrency` must not throw a render down.
 *
 * `Intl.NumberFormat` raises `RangeError` for any `currency` that is not a
 * well-formed ISO-4217 code. That was harmless while every caller passed a
 * host-authored constant — and became a white-screen the moment a caller passed
 * MODEL-EMITTED text (production plan budgets, validated only as a <=8-char
 * string). `guardDate` in the same module already documents the rule: "a throw
 * inside a render unmounts the React tree… a white screen is not recoverable".
 */
import { describe, it, expect } from 'vitest';
import { formatCurrency } from '../format.js';

describe('formatCurrency is guarded', () => {
  it('falls back to a plain amount + code instead of throwing', () => {
    for (const bad of ['dollars', '$', 'US$', 'EUROS', '']) {
      expect(() => formatCurrency(6000, bad)).not.toThrow();
      expect(formatCurrency(6000, bad)).toContain('6,000');
    }
  });

  it('still formats a REAL currency properly (the control)', () => {
    // Without this, "never throws" is satisfied by a function that always
    // returns the fallback and never localizes anything.
    const usd = formatCurrency(6000, 'USD');
    expect(usd).toContain('$');
    expect(usd).not.toBe('6,000 USD');
  });
});
