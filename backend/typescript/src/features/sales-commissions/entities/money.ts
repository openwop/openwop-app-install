/**
 * Commission money in integer minor units (ADR 1034 D7).
 *
 * The statement path used to multiply major-unit floats and round with `quantizeMajor`
 * (`Math.round(x * f) / f`). That misrounds at the half: `Math.round(1.005 * 100)` is
 * `100`, because `1.005 * 100` is `100.49999999999999`. The conversion itself was the
 * bug, so it cannot be fixed by rounding later. Here a major-unit number becomes a
 * `bigint` of minor units by parsing its DECIMAL STRING, every product and quotient is
 * `bigint`, and the only division rounds half away from zero, explicitly.
 *
 * Feature-local on purpose: `host/currencyUnits.ts` is shared by every money surface, and
 * changing its rounding is a shared-seam decision this ADR does not make.
 */

import { OpenwopError } from '../../../types.js';
import { currencyExponent } from '../../../host/currencyUnits.js';

/** Rates carry six decimal places exactly (`7.5` → 7_500_000 micros). */
const RATE_SCALE_DIGITS = 6;

/** The plain decimal spelling of a finite number, never exponent form. */
function decimalString(n: number, field: string): string {
  if (!Number.isFinite(n) || Math.abs(n) >= 1e21) {
    throw new OpenwopError('validation_error', `\`${field}\` is not an amount this host can compute with exactly.`, 400, { field, value: n });
  }
  const s = String(n);
  // `String` switches to exponent form below 1e-6; `toFixed(20)` spells those out (they
  // round to zero at any currency's precision, but the parse below must still see digits).
  return /e/i.test(s) ? n.toFixed(20) : s;
}

/** Parse a decimal number into `bigint` units of `10^-digits`, rounding the digits past
 *  the scale half away from zero. Pure string arithmetic: no float multiply anywhere. */
export function toScaled(n: number, digits: number, field: string): bigint {
  const s = decimalString(n, field);
  const negative = s.startsWith('-');
  const [intPart, fracPart = ''] = (negative ? s.slice(1) : s).split('.');
  const kept = (fracPart + '0'.repeat(digits)).slice(0, digits);
  let units = BigInt(intPart + kept);
  const next = fracPart.charCodeAt(digits) - 48; // the first dropped digit (NaN when none)
  if (next >= 5) units += 1n; // half away from zero, applied to the magnitude
  return negative ? -units : units;
}

/** A major-unit amount → minor units for `currency` (ISO 4217 exponent). */
export function toMinor(amount: number, currency: string | undefined, field: string): bigint {
  return toScaled(amount, currencyExponent(currency), field);
}

/** Minor units → the major-unit number the row has always stored. A `bigint` divided
 *  through `Number` once, at the end, so the stored float is the nearest double to the
 *  exact decimal (it is never fed back into arithmetic). */
export function minorToMajorNumber(minor: bigint, currency: string | undefined): number {
  return Number(minor) / 10 ** currencyExponent(currency);
}

/** `a / b` for `bigint`, rounding half away from zero (`b > 0`). */
export function divRoundHalfAway(a: bigint, b: bigint): bigint {
  const negative = a < 0n;
  const mag = negative ? -a : a;
  const q = mag / b;
  const r = mag % b;
  const rounded = r * 2n >= b ? q + 1n : q;
  return negative ? -rounded : rounded;
}

/** A rule's rate as exact micros. */
export function rateMicros(rate: number): bigint {
  return toScaled(rate, RATE_SCALE_DIGITS, 'rate');
}

/** One line's commission in minor units. `percentage`: deal × rate / 100; `fixed`: the
 *  rate itself, as a flat amount in the plan currency, per won deal. */
export function lineCommissionMinor(type: 'percentage' | 'fixed', dealMinor: bigint, rate: number, currency: string): bigint {
  if (type === 'fixed') return toMinor(rate, currency, 'rate');
  // dealMinor × (rateMicros / 10^6) / 100
  return divRoundHalfAway(dealMinor * rateMicros(rate), 10n ** BigInt(RATE_SCALE_DIGITS + 2));
}

/**
 * Scale `values` down so they sum to exactly `cap`, by LARGEST REMAINDER: each gets
 * `floor(v × cap / total)`, and the units left over go one each to the largest
 * remainders (ties to the earlier line, so the result is deterministic). The old code
 * scaled each line by a float factor and rounded each, so three capped lines could sum
 * one minor unit past the cap they were scaled to honour.
 *
 * Only called with a positive `total > cap`. Values are the positive per-line amounts.
 */
export function allocateCap(values: readonly bigint[], cap: bigint): bigint[] {
  const total = values.reduce((a, v) => a + v, 0n);
  const shares = values.map((v) => (v * cap) / total);
  const remainders = values.map((v, i) => ({ i, r: (v * cap) % total }));
  let leftover = cap - shares.reduce((a, v) => a + v, 0n);
  remainders.sort((x, y) => (y.r > x.r ? 1 : y.r < x.r ? -1 : x.i - y.i));
  for (const { i } of remainders) {
    if (leftover <= 0n) break;
    shares[i] += 1n;
    leftover -= 1n;
  }
  return shares;
}
