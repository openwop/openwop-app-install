/**
 * ADR 0391 (b) — the `/pricing` matcher is a fixed-path predicate: it matches
 * only `/pricing` (trailing slash tolerated) and nothing nested or adjacent.
 */
import { describe, it, expect } from 'vitest';
import { matchPricingRoute } from '../pricingRoute.js';

describe('matchPricingRoute', () => {
  it('matches /pricing with and without a trailing slash', () => {
    expect(matchPricingRoute('/pricing')).toBe(true);
    expect(matchPricingRoute('/pricing/')).toBe(true);
  });

  it('does not match a nested or adjacent path', () => {
    expect(matchPricingRoute('/pricing/pro')).toBe(false);
    expect(matchPricingRoute('/pricings')).toBe(false);
    expect(matchPricingRoute('/blog')).toBe(false);
    expect(matchPricingRoute('/')).toBe(false);
  });
});
