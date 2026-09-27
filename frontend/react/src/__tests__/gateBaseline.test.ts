/**
 * ADR 0598 §Correction 3 — the probe that found the defect, kept as assertions.
 *
 * `const BASELINE = Number(process.env.X ?? '190')` reads a typo as `NaN`, and
 * `count > NaN` is false, so an unreadable override did not raise the bar or
 * lower it — it REMOVED it, and the run still printed a tick. MEASURED on the
 * real gate before this fix:
 *
 *     OPENWOP_SILENT_READ_NOTICE_BASELINE_0598=0     → ✗ EXIT=1
 *     OPENWOP_SILENT_READ_NOTICE_BASELINE_0598=zero  → ✓ EXIT=0, "baseline NaN"
 *
 * Eleven of the repo's twelve env-overridable gate baselines had this hole. They
 * now share ONE resolver, and these are the shapes it must refuse.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs gate script, deliberately untyped: it runs under plain
// node with no build step, and a .d.ts would be a second source of truth.
import { resolveGateBaseline } from '../../scripts/gateBaseline.mjs';

describe('resolveGateBaseline — an unreadable override is a MISTAKE, not permission to assert nothing', () => {
  it('refuses a typo instead of silently disabling the gate (the shipped defect)', () => {
    const r = resolveGateBaseline('X', 'zero', 190);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a non-negative integer/);
  });

  it('refuses a negative and a fractional count', () => {
    for (const bad of ['-1', '3.5', 'NaN', 'Infinity']) {
      expect(resolveGateBaseline('X', bad, 190).ok).toBe(false);
    }
  });

  it('refuses the EMPTY string rather than reading it as 0', () => {
    // `Number('')` is 0, which for a `count > BASELINE` gate is the strictest
    // possible baseline — a red run for a reason the operator never asked for,
    // which reads as a real regression.
    const r = resolveGateBaseline('X', '', 190);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/empty/);
  });

  it('refuses an override that LOOSENS the ratchet', () => {
    const r = resolveGateBaseline('X', '99999', 190);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/HIGHER/);
  });

  it('accepts an override that TIGHTENS it — "would we pass at 0?" is a real question', () => {
    expect(resolveGateBaseline('X', '0', 190)).toMatchObject({ ok: true, baseline: 0 });
  });

  it('accepts the committed baseline itself, and falls back to it when unset', () => {
    expect(resolveGateBaseline('X', '190', 190)).toMatchObject({ ok: true, baseline: 190 });
    expect(resolveGateBaseline('X', undefined, 190)).toEqual({ ok: true, baseline: 190 });
  });
});
