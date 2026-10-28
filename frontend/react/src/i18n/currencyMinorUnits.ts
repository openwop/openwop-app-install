/**
 * ISO 4217 minor units — the frontend copy of the backend table
 * (`backend/typescript/src/host/currencyUnits.ts` `ISO_4217_MINOR_UNITS`).
 *
 * A FIXED TABLE, not `Intl`: `resolvedOptions().maximumFractionDigits` is CLDR's
 * DISPLAY precision and drifts by ICU release (ICU 78.3 reports HUF, COP, IDR, PKR
 * and eleven more as 0 though ISO says 2, and IQD as 0 though ISO says 3). Stored
 * money is ISO minor units, so the budget editor that WRITES them and every
 * renderer that READS them must use the same exponent the backend does.
 *
 * Split in two so the entry bundle carries only what display needs: this file
 * holds the codes whose exponent is NOT 2 (every other ISO code has 2), and
 * `currencyCodes.ts` holds the full list of 2-decimal codes plus the membership
 * lookup the budget editor uses (it loads with that feature, not the entry).
 * The backend test `currency-iso-table-parity.test.ts` holds the union of the two
 * files equal to the backend table; edit them together.
 */
export const ISO_4217_ZERO = 'BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX VND VUV XAF XOF XPF';
export const ISO_4217_THREE = 'BHD IQD JOD KWD LYD OMR TND';

/** ISO exponent of a currency code (any case): 0 or 3 for the codes above, else 2.
 *  For display; it does not say whether a code is a currency (`isoMinorUnits` does). */
export function minorUnitsFor(currency: string | undefined): number {
  const code = (currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return 2;
  return ISO_4217_ZERO.includes(code) ? 0 : ISO_4217_THREE.includes(code) ? 3 : 2;
}
