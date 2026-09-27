/**
 * R2 CB-SP-3 — exponent-aware minor⇄major conversion for the budget editor.
 *
 * The editor used a hard-coded ×100/÷100, which assumes every currency has two
 * decimals: a JPY user entering 5000 stored ¥500,000 (100× the intent), and a
 * stored ¥5000 rendered as "50". The exponent belongs to the CURRENCY — derive
 * it from Intl (JPY→0, KWD/BHD→3), defaulting to 2 when the currency is absent
 * or unknown. The backend stores integers and is exponent-agnostic; this
 * boundary is the only place the assumption lived.
 */

export function currencyExponent(currency: string | undefined): number {
  if (!currency || !isIsoCurrency(currency)) return 2;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() })
      .resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Three ASCII letters that Intl accepts as a currency code. */
export function isIsoCurrency(code: string): boolean {
  if (!/^[A-Za-z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code.toUpperCase() });
    return true;
  } catch {
    return false;
  }
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
