/**
 * ADR 0130 Phase 3b / ADR 0610 D4 (MRC-2) / ADR 0124 Phase 3 — the dispatch-time
 * READ of `run.metadata.modelRoute` (replayed verbatim on `:fork`) and the
 * per-exchange model override layered over it.
 *
 * Breaks if a stamp naming a NON-routable vendor is dispatched (the exfil
 * read-guard), if a stamp without a usable model overrides the run's own model,
 * or if a partial stamp/override drops the field it did not name.
 */
import { describe, it, expect } from 'vitest';
import { effectiveModelTarget, applyExchangeOverride } from '../src/features/model-router/applyRoute.js';

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
    // A ROUTABLE provider with no / an empty model: the model check is the ONLY
    // guard here (a non-routable provider would also be dropped by the ADR 0610
    // read-guard, which hid this leg's check).
    expect(effectiveModelTarget('anthropic', 'small', { modelRoute: { provider: 'openai' } })).toEqual({ provider: 'anthropic', model: 'small' });
    expect(effectiveModelTarget('anthropic', 'small', { modelRoute: { provider: 'openai', model: '' } })).toEqual({ provider: 'anthropic', model: 'small' });
    // Not an object at all — caught by the object check AND the model check (honest double guard).
    expect(effectiveModelTarget('anthropic', 'small', { modelRoute: 'nope' })).toEqual({ provider: 'anthropic', model: 'small' });
  });
});

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

// ADR 0610 D4 / MRC-2 — the READ-side guard (the defense-in-depth the write-time
// allowlist pairs with). A run stamped BEFORE the allowlist shipped — or a tampered
// / forked stamp — carries `modelRoute.provider` that dispatch reads VERBATIM. It
// must NOT dispatch a non-routable provider; ignore the whole stamp → fall back to
// the run's explicit provider/model. (The write gate blocks NEW bad stamps; this
// guards LEGACY/forked ones — the case resolveModelRoute's stamp-time check misses.)
describe('effectiveModelTarget — non-routable stamped provider is ignored (ADR 0610 D4)', () => {
  it('drops a stamp naming an arbitrary vendor and falls back to the run target', () => {
    // A legacy/tampered stamp → must be IGNORED, not dispatched verbatim.
    expect(effectiveModelTarget('openai', 'gpt', { modelRoute: { provider: 'evil-exfil-vendor', model: 'x' } }))
      .toEqual({ provider: 'openai', model: 'gpt' });
    // `compat` (custom-endpoint) stamp → also ignored.
    expect(effectiveModelTarget('openai', 'gpt', { modelRoute: { provider: 'compat', model: 'x' } }))
      .toEqual({ provider: 'openai', model: 'gpt' });
  });
  it('still honors a ROUTABLE stamped provider (non-vacuous control)', () => {
    expect(effectiveModelTarget('openai', 'gpt', { modelRoute: { provider: 'anthropic', model: 'claude' } }))
      .toEqual({ provider: 'anthropic', model: 'claude' });
    // a provider-less stamp still keeps the run's explicit provider (unchanged).
    expect(effectiveModelTarget('openai', 'gpt', { modelRoute: { model: 'big' } }))
      .toEqual({ provider: 'openai', model: 'big' });
  });
});
