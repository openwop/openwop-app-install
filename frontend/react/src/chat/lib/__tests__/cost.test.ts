/**
 * formatUsd — the one money formatter for builder, runs and chat (ux-11; moved
 * to `i18n/format.ts`, re-exported from `chat/lib/cost.ts`). This file is its
 * only test. Breaks it: a wrong precision band, e.g. a real sub-cent turn cost
 * rendering as "$0.00", or a dollar total with four decimals.
 * Bands: exactly 0 → "$0"; < 0.001 → 6 decimals; < 1 → 4 decimals; else 2.
 */
import { describe, it, expect } from 'vitest';
import { formatUsd } from '../cost.js';

describe('formatUsd', () => {
  it('renders exact zero as $0', () => {
    expect(formatUsd(0)).toBe('$0');
  });

  it('gives tiny amounts six decimals', () => {
    expect(formatUsd(0.0000123)).toBe('$0.000012');
  });

  it('gives sub-dollar amounts four decimals', () => {
    // The cost.ts doc example: (200*0.003 + 80*0.015)/1000 = 0.0018.
    expect(formatUsd(0.0018)).toBe('$0.0018');
    expect(formatUsd(0.29)).toBe('$0.2900');
    // Boundary: 0.001 is no longer "tiny".
    expect(formatUsd(0.001)).toBe('$0.0010');
  });

  it('rounds dollar+ amounts to two decimals', () => {
    expect(formatUsd(12.3456)).toBe('$12.35');
    // Boundary: exactly one dollar is in the two-decimal band.
    expect(formatUsd(1)).toBe('$1.00');
  });
});
