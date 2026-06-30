/**
 * ADR 0130 Phase 3b — effectiveModelTarget (replay-safe stamped-route read).
 */
import { describe, it, expect } from 'vitest';
import { effectiveModelTarget } from '../src/features/model-router/applyRoute.js';

describe('effectiveModelTarget', () => {
  it('returns the run target when no stamp', () => {
    expect(effectiveModelTarget('anthropic', 'claude-x', undefined)).toEqual({ provider: 'anthropic', model: 'claude-x' });
    expect(effectiveModelTarget('anthropic', 'claude-x', {})).toEqual({ provider: 'anthropic', model: 'claude-x' });
  });
  it('a stamped route overrides provider+model (deterministic on fork)', () => {
    expect(effectiveModelTarget('anthropic', 'small', { modelRoute: { provider: 'openai', model: 'big' } }))
      .toEqual({ provider: 'openai', model: 'big' });
  });
  it('a stamp with only a model keeps the run provider', () => {
    expect(effectiveModelTarget('anthropic', 'small', { modelRoute: { model: 'big' } }))
      .toEqual({ provider: 'anthropic', model: 'big' });
  });
  it('ignores a malformed stamp', () => {
    expect(effectiveModelTarget('anthropic', 'small', { modelRoute: { provider: 'x' } })).toEqual({ provider: 'anthropic', model: 'small' });
    expect(effectiveModelTarget('anthropic', 'small', { modelRoute: 'nope' })).toEqual({ provider: 'anthropic', model: 'small' });
  });
});

import { applyExchangeOverride } from '../src/features/model-router/applyRoute.js';
describe('applyExchangeOverride (ADR 0124 Phase 3 per-exchange switch)', () => {
  const base = { provider: 'anthropic', model: 'small' };
  it('no override → base unchanged', () => {
    expect(applyExchangeOverride(base, undefined)).toEqual(base);
  });
  it('full override wins', () => {
    expect(applyExchangeOverride(base, { provider: 'openai', model: 'big' })).toEqual({ provider: 'openai', model: 'big' });
  });
  it('partial override keeps the other field', () => {
    expect(applyExchangeOverride(base, { model: 'big' })).toEqual({ provider: 'anthropic', model: 'big' });
    expect(applyExchangeOverride(base, { provider: 'openai' })).toEqual({ provider: 'openai', model: 'small' });
  });
});
