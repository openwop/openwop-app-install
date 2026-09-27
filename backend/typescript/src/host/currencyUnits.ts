/**
 * R2 CI-SP-5 — exponent-aware ISO-4217 minor-unit conversion.
 *
 * `campaign.budget.totalMinor` is written by the brief editor in TRUE ISO minor
 * units (exponent derived from the currency — #3094): JPY stores yen (exp 0),
 * KWD stores fils-thousandths (exp 3). Every consumer that divides by a literal
 * 100 misreads those by 100×/10× — pacing read a ¥500,000 plan as ¥5,000 and
 * banded the campaign "over" instantly. One shared helper; the frontend twin is
 * `features/campaign-brief/budgetUnits.ts`, and billing's Stripe-specific
 * ZERO_DECIMAL table remains separate deliberately (Stripe's list is Stripe's).
 */

export function currencyExponent(currency: string | undefined): number {
  if (!currency || !/^[A-Za-z]{3}$/.test(currency)) return 2;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() })
      .resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Stored ISO minor units → major units, per the currency's own exponent. */
export function minorToMajor(minor: number, currency: string | undefined): number {
  return minor / 10 ** currencyExponent(currency);
}

/**
 * Round a MAJOR-unit amount to the precision its currency actually has.
 *
 * R2 (territories) — the hardcoded `Math.round(n * 100) / 100` is the recurring
 * shape in this codebase: it invents two decimals for JPY (which has none, so
 * `¥1234.56` is not a representable amount) and silently drops the third for
 * KWD/BHD/OMR. Commerce solved this for its own layer with `quantizeMoney`
 * (minor-units round-trip through the Stripe table); this is the host-level twin
 * for surfaces that never touch Stripe, so a feature does not have to import
 * commerce to round money correctly.
 *
 * An unknown/absent currency keeps the 2dp default — the same fallback
 * `currencyExponent` already applies, so behaviour is unchanged where the
 * currency is genuinely unknown.
 */
export function quantizeMajor(amount: number, currency: string | undefined): number {
  const f = 10 ** currencyExponent(currency);
  return Math.round(amount * f) / f;
}
