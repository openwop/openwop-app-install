/**
 * Money exponents come from ONE ISO 4217 table, on both sides, never from `Intl`.
 *
 * Why: `Intl.NumberFormat(…).resolvedOptions().maximumFractionDigits` is CLDR's
 * display precision and drifts by ICU release. On Node 22.23.4 (ICU 78.3, the prod
 * image) it reports HUF, COP, IDR, PKR and eleven more as 0 decimals (ISO: 2) and
 * IQD as 0 (ISO: 3). The ads writers moved to the table in #5211. This file holds
 * the rest of the money path to it:
 *   1. the permissive backend helper (`currencyExponent`, and through it
 *      `minorToMajor` / `quantizeMajor`, which pacing, spend caps, quotas,
 *      commission statements and strategy metrics use) ignores a disagreeing ICU;
 *   2. the frontend copy (`frontend/react/src/i18n/currencyMinorUnits.ts` for the
 *      non-2 codes `formatCurrencyMinor` reads, plus `currencyCodes.ts` for the full
 *      list the budget editor that WRITES `campaign.budget.totalMinor` reads) is the
 *      same table, entry for entry.
 *
 * Sabotage: adding HUF to the zero list of the frontend copy reds case 2 (it is then
 * listed twice, which a Map would hide); restoring the `Intl` lookup in
 * `currencyExponent` reds case 1.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ISO_4217_MINOR_UNITS, currencyExponent, minorToMajor, quantizeMajor, strictCurrencyExponent } from '../src/host/currencyUnits.js';

const FRONTEND_I18N = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend', 'react', 'src', 'i18n');
const FRONTEND_TABLE = ['currencyMinorUnits.ts', 'currencyCodes.ts'].map((f) => join(FRONTEND_I18N, f));
const BACKEND_TABLE = [join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'host', 'currencyUnits.ts')];

/** The frontend table, read as source: every (code, exponent) entry of the three
 *  `ISO_4217_*` lists across its two files. A list of entries, not a Map: a code in
 *  two lists must show up as a duplicate, not have one entry silently overwrite the
 *  other (the Map version passed with HUF in both the zero and the two list). */
function tableEntries(files: readonly string[]): Array<[string, number]> {
  const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const list = (name: string): string[] => {
    const m = new RegExp(`const ${name} =([\\s\\S]*?);`).exec(src);
    if (!m) throw new Error(`${name} not found in ${files.join(', ')}`);
    return [...m[1]!.matchAll(/'([^']*)'/g)].map((s) => s[1]!).join('').trim().split(/\s+/);
  };
  return [
    ...list('ISO_4217_ZERO').map((c) => [c, 0] as [string, number]),
    ...list('ISO_4217_TWO').map((c) => [c, 2] as [string, number]),
    ...list('ISO_4217_THREE').map((c) => [c, 3] as [string, number]),
  ];
}

afterEach(() => { vi.restoreAllMocks(); });

describe('money exponents: one ISO 4217 table', () => {
  it('1. the permissive backend helper reads the table, whatever the runtime ICU says', () => {
    vi.spyOn(Intl.NumberFormat.prototype, 'resolvedOptions').mockReturnValue({ maximumFractionDigits: 0 } as Intl.ResolvedNumberFormatOptions);
    expect(currencyExponent('HUF')).toBe(2);
    expect(currencyExponent('huf')).toBe(2);
    expect(currencyExponent('IQD')).toBe(3);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent(undefined)).toBe(2);
    expect(currencyExponent('ZZZ')).toBe(2);
    expect(minorToMajor(500_000, 'HUF')).toBe(5000);
    expect(minorToMajor(5005, 'KWD')).toBe(5.005);
    expect(quantizeMajor(1234.567, 'HUF')).toBe(1234.57);
    expect(quantizeMajor(1234.567, 'JPY')).toBe(1235);
    // Permissive and strict agree on every listed code.
    for (const [code, exp] of ISO_4217_MINOR_UNITS) {
      expect(currencyExponent(code), code).toBe(exp);
      expect(strictCurrencyExponent(code), code).toBe(exp);
    }
  });

  it('2. the frontend copy is the same table, entry for entry', () => {
    const fe = tableEntries(FRONTEND_TABLE);
    expect(fe.map(([c, e]) => `${c}=${e}`).sort()).toEqual([...ISO_4217_MINOR_UNITS.entries()].map(([c, e]) => `${c}=${e}`).sort());
    expect(new Set(fe.map(([c]) => c)).size, 'a code listed twice').toBe(fe.length);
    expect(fe.length).toBeGreaterThan(150);
    // The backend Map hides a duplicate the same way; check its source lists too.
    const be = tableEntries(BACKEND_TABLE);
    expect(new Set(be.map(([c]) => c)).size, 'a backend code listed twice').toBe(be.length);
    expect(be.length).toBe(ISO_4217_MINOR_UNITS.size);
  });
});
