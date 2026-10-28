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

/** Permissive exponent for readers and display: the ISO 4217 table below, any
 *  letter case, defaulting to 2 when the currency is absent or not listed. Never
 *  `Intl` — see the table's docblock for why. */
export function currencyExponent(currency: string | undefined): number {
  if (!currency || !/^[A-Za-z]{3}$/.test(currency)) return 2;
  return ISO_4217_MINOR_UNITS.get(currency.toUpperCase()) ?? 2;
}

/**
 * ISO 4217 minor units for every currency a money writer accepts.
 *
 * A FIXED TABLE, not `Intl`, on purpose. `Intl.NumberFormat(…).resolvedOptions()
 * .maximumFractionDigits` is CLDR's DISPLAY precision, which drifts by ICU release:
 * MEASURED on Node v22.23.4 (ICU 78.3, CLDR 48 — the prod image) it returns 0 for
 * HUF, COP, IDR, PKR and eleven more whose ISO exponent is 2, and 0 for IQD (ISO 3),
 * while older ICU returned 0 for TWD. A writer that reads it converts the same stored
 * minor units differently on different runtimes — HUF budgets went to Meta 100× too
 * large (main red at aa357c36f, after #5175).
 *
 * Membership: the codes this runtime's ICU recognised when the table was written,
 * minus XDR and XSU (not national currencies; ISO minor unit N.A.), plus VED (ISO
 * active, absent from that ICU). Withdrawn codes ICU still accepts (CUC, HRK, SLL,
 * ZWL) keep their ISO exponent so an existing account is not newly refused.
 */
const ISO_4217_ZERO = 'BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX VND VUV XAF XOF XPF';
const ISO_4217_THREE = 'BHD IQD JOD KWD LYD OMR TND';
const ISO_4217_TWO =
  'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CNY COP CRC CUC '
  + 'CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IRR JMD KES '
  + 'KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD '
  + 'PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TOP '
  + 'TRY TTD TWD TZS UAH USD UYU UZS VED VES WST XCD XCG YER ZAR ZMW ZWG ZWL';

export const ISO_4217_MINOR_UNITS: ReadonlyMap<string, number> = new Map([
  ...ISO_4217_ZERO.split(' ').map((c) => [c, 0] as const),
  ...ISO_4217_TWO.split(' ').map((c) => [c, 2] as const),
  ...ISO_4217_THREE.split(' ').map((c) => [c, 3] as const),
]);

/** Money writers require a recognized, canonical currency and never guess its
 * precision: the ISO 4217 table above, `null` for anything not in it (never a
 * default). Keep the permissive display helper above for its existing callers. */
export function strictCurrencyExponent(currency: string | undefined): number | null {
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return null;
  return ISO_4217_MINOR_UNITS.get(currency) ?? null;
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
