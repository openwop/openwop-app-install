/**
 * PROBE for the date-bomb sweep's non-vacuity floor (H74).
 *
 * Asserts what the sweep's step name claims: with `OPENWOP_CI_CLOCKSHIFT=1`
 * the FRONTEND workspace really runs with an advanced clock.
 * `scripts/check-clockshift-armed.mjs` runs this file explicitly and fails if it
 * reports ZERO tests, so deleting or renaming it is caught rather than read as
 * an absence of failures.
 *
 * THE REFERENCE CLOCK MATTERS, and the first draft of this file got it wrong.
 * It compared `Date.now()` against `Date.now()` and asserted things like
 * `DAYS > 0` — all true with or without the shim, so removing the setup file
 * from `setupFiles` left it green. A probe for a gate that cannot fail, which
 * could not fail. `performance.timeOrigin + performance.now()` is a real epoch
 * reading that the `globalThis.Date` override does not touch, so the comparison
 * has something honest on the other side.
 *
 * Inert outside the lane — the sweep is opt-in, and a probe that failed on a
 * normal run would just be a second date bomb.
 */
import { describe, expect, it } from 'vitest';

const ARMED = process.env.OPENWOP_CI_CLOCKSHIFT === '1';
const DAYS = Number(process.env.OPENWOP_CLOCKSHIFT_DAYS ?? '365');

/** Epoch ms from a source the Date shim cannot rewrite. */
function realEpochMs(): number {
  return performance.timeOrigin + performance.now();
}

describe('date-bomb sweep — the clock is really shifted', () => {
  it.runIf(ARMED)('Date.now() runs ~DAYS ahead of the real clock', () => {
    const skewDays = (Date.now() - realEpochMs()) / 86_400_000;
    // Within a day of the horizon: this asserts the shim is INSTALLED, not its
    // precision. Drop `clock-shift.ts` from `setupFiles` and skew is ~0 -> red.
    expect(skewDays).toBeGreaterThan(DAYS - 1);
    expect(skewDays).toBeLessThan(DAYS + 1);
  });

  it.runIf(ARMED)('`new Date()` is shifted too, not only `Date.now()`', () => {
    // A partial override is how half a suite keeps a real clock: code reading
    // `new Date()` would sail past a sweep that only patched the static.
    const skewDays = (new Date().getTime() - realEpochMs()) / 86_400_000;
    expect(skewDays).toBeGreaterThan(DAYS - 1);
  });

  it.skipIf(ARMED)('is inert outside the sweep', () => {
    expect(ARMED).toBe(false);
  });
});
