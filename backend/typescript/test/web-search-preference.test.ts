/**
 * WSRCH-4 (grade-code 2026-06-22) — the per-exchange `webSearch` override BEATS
 * the run-input open-time default (`run.inputs.webSearch`), and the run-input
 * default applies only on the strict boolean `true`. This pins the precedence
 * shared by the single-completion reply path and the agent tool loop (ADR 0101).
 */
import { describe, expect, it } from 'vitest';
import { resolveWebSearchPreference } from '../src/host/webSearchPreference.js';

describe('resolveWebSearchPreference (ADR 0101 precedence)', () => {
  it('a per-exchange override of TRUE beats a run-input default of false/absent', () => {
    expect(resolveWebSearchPreference(true, false)).toBe(true);
    expect(resolveWebSearchPreference(true, undefined)).toBe(true);
  });

  it('a per-exchange override of FALSE beats a run-input default of true', () => {
    expect(resolveWebSearchPreference(false, true)).toBe(false);
  });

  it('with no override, the run-input default applies — but ONLY for strict true', () => {
    expect(resolveWebSearchPreference(undefined, true)).toBe(true);
    expect(resolveWebSearchPreference(undefined, false)).toBe(false);
    expect(resolveWebSearchPreference(undefined, undefined)).toBe(false);
    // any non-true shape (truthy string, 1, object) is NOT a valid enable
    expect(resolveWebSearchPreference(undefined, 'true')).toBe(false);
    expect(resolveWebSearchPreference(undefined, 1)).toBe(false);
  });
});
