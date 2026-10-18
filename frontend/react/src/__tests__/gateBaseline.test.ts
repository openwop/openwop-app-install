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
 * now share ONE resolver, and these are the shapes it must refuse. The last case
 * pins the "share ONE resolver" half: a gate that goes back to reading its
 * override with `Number(process.env…)` re-opens the hole, and the resolver's own
 * cases cannot see that (/grade-tests w50 probe `gb-wiring`).
 *
 * Types: `scripts/gateBaseline.d.mts` (declarations only, beside the script).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGateBaseline } from '../../scripts/gateBaseline.mjs';

const NOT_A_COUNT = /not a non-negative integer/;

describe('resolveGateBaseline — an unreadable override is a MISTAKE, not permission to assert nothing', () => {
  it('refuses a typo instead of silently disabling the gate (the shipped defect)', () => {
    expect(resolveGateBaseline('X', 'zero', 190)).toMatchObject({ ok: false, error: expect.stringMatching(NOT_A_COUNT) });
  });

  it('refuses a negative and a fractional count', () => {
    for (const bad of ['-1', '3.5', 'NaN', 'Infinity']) {
      // The message, not just `ok:false`: the ceiling refusal must not stand in for this one.
      expect(resolveGateBaseline('X', bad, 190), bad).toMatchObject({ ok: false, error: expect.stringMatching(NOT_A_COUNT) });
    }
  });

  it('refuses the EMPTY string rather than reading it as 0', () => {
    // `Number('')` is 0, which for a `count > BASELINE` gate is the strictest
    // possible baseline — a red run for a reason the operator never asked for,
    // which reads as a real regression.
    expect(resolveGateBaseline('X', '', 190)).toMatchObject({ ok: false, error: expect.stringMatching(/empty/) });
  });

  it('refuses an override that LOOSENS the ratchet', () => {
    expect(resolveGateBaseline('X', '99999', 190)).toMatchObject({ ok: false, error: expect.stringMatching(/HIGHER/) });
  });

  it('accepts an override that TIGHTENS it — "would we pass at 0?" is a real question', () => {
    expect(resolveGateBaseline('X', '0', 190)).toMatchObject({ ok: true, baseline: 0 });
  });

  it('accepts the committed baseline itself, and falls back to it when unset', () => {
    expect(resolveGateBaseline('X', '190', 190)).toMatchObject({ ok: true, baseline: 190 });
    expect(resolveGateBaseline('X', undefined, 190)).toEqual({ ok: true, baseline: 190 });
  });

  it('every gate script reads its override through the resolver, never Number(process.env…)', () => {
    const dir = join(process.cwd(), 'scripts');
    const scripts = readdirSync(dir).filter((f) => /\.(mjs|cjs|js)$/.test(f) && f !== 'gateBaseline.mjs');
    const code = (f: string): string =>
      readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const raw = scripts.filter((f) => /Number\(\s*process\.env/.test(code(f)));
    expect(raw, 'these scripts coerce an env override with Number(): a typo becomes NaN and disables the gate').toEqual([]);
    // Positive control: the resolver really is in use. MEASURED 2026-10-16: 10 scripts.
    const users = scripts.filter((f) => /readGateBaseline\(/.test(code(f)));
    expect(users.length).toBeGreaterThanOrEqual(10);
  });
});
