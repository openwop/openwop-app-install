/**
 * R2 CB-SP-3 — exponent-aware minor⇄major conversion for the budget editor.
 *
 * The editor used a hard-coded ×100/÷100, which assumes every currency has two
 * decimals: a JPY user entering 5000 stored ¥500,000 (100× the intent), and a
 * stored ¥5000 rendered as "50". The exponent belongs to the CURRENCY — read
 * from the ISO 4217 table (JPY→0, KWD/BHD→3), defaulting to 2 when the currency
 * is absent or unknown. Not from `Intl`: its display precision drifts by ICU
 * release (ICU 78.3 says HUF has 0 decimals; ISO says 2), and the backend reads
 * these minor units with the ISO table, so the writer must too.
 */

import { isoMinorUnits } from '../../i18n/currencyCodes.js';

export function currencyExponent(currency: string | undefined): number {
  return isoMinorUnits(currency) ?? 2;
}

/** Three ASCII letters naming a currency in the ISO 4217 table (any case). */
export function isIsoCurrency(code: string): boolean {
  return isoMinorUnits(code) !== undefined;
}

/** Stored minor units → the major-unit string the editor field shows. */
export function minorToMajorString(minor: number, currency: string | undefined): string {
  const exp = currencyExponent(currency);
  return String(minor / 10 ** exp);
}

/** The editor field's major-unit input → stored minor units (integer). */
export function majorToMinor(input: string, currency: string | undefined): number {
  const exp = currencyExponent(currency);
  return Math.round(Number(input) * 10 ** exp);
}
