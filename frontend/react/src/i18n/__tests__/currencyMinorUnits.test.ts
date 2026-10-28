/**
 * The budget editor and `formatCurrencyMinor` use ISO 4217 exponents, not `Intl`.
 *
 * `Intl`'s `maximumFractionDigits` is display precision and drifts by ICU release
 * (ICU 78.3 reports HUF as 0 decimals; ISO says 2). The editor WRITES
 * `campaign.budget.totalMinor` and the backend reads it with the ISO table, so a
 * browser on that ICU stored 5,000 Ft as 5000 and the ads path read it as 50 Ft.
 * Here every `Intl` precision lookup is forced to 0: the answers must not move.
 * The backend test `currency-iso-table-parity` holds this table equal to the
 * backend's.
 *
 * Sabotage: reading `resolvedOptions()` in `currencyExponent` or in
 * `formatCurrencyMinor` again reds this file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isoMinorUnits } from '../currencyCodes.js';
import { minorUnitsFor } from '../currencyMinorUnits.js';
import { formatCurrencyMinor, setFormatLocale } from '../format.js';
import { currencyExponent, isIsoCurrency, majorToMinor, minorToMajorString } from '../../features/campaign-brief/budgetUnits.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('ISO 4217 money exponents, independent of the runtime ICU', () => {
  it('the budget editor converts HUF/IQD/JPY by ISO even when Intl says 0 decimals', () => {
    vi.spyOn(Intl.NumberFormat.prototype, 'resolvedOptions').mockReturnValue({ maximumFractionDigits: 0 } as Intl.ResolvedNumberFormatOptions);
    expect(currencyExponent('HUF')).toBe(2);
    expect(currencyExponent('IQD')).toBe(3);
    expect(currencyExponent('JPY')).toBe(0);
    expect(majorToMinor('5000', 'HUF')).toBe(500_000);
    expect(minorToMajorString(500_000, 'HUF')).toBe('5000');
    expect(majorToMinor('5000', 'JPY')).toBe(5000);
  });

  it('formatCurrencyMinor divides by the ISO exponent even when Intl says 0 decimals', () => {
    setFormatLocale('en');
    vi.spyOn(Intl.NumberFormat.prototype, 'resolvedOptions').mockReturnValue({ maximumFractionDigits: 0 } as Intl.ResolvedNumberFormatOptions);
    expect(formatCurrencyMinor(500_000, 'HUF')).toMatch(/5,000(?!\d)/);
    expect(formatCurrencyMinor(123_456, 'USD')).toBe('$1,234.56');
  });

  it('only listed codes are currencies; case does not matter; unknown defaults to 2', () => {
    expect(isIsoCurrency('huf')).toBe(true);
    expect(isIsoCurrency('ZZZ')).toBe(false);
    expect(isIsoCurrency('XDR')).toBe(false);
    expect(isoMinorUnits('kwd')).toBe(3);
    expect(minorUnitsFor('huf')).toBe(2);
    expect(minorUnitsFor('IQD')).toBe(3);
    expect(minorUnitsFor('JPY')).toBe(0);
    expect(currencyExponent('ZZZ')).toBe(2);
    expect(currencyExponent(undefined)).toBe(2);
  });
});
