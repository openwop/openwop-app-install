/**
 * The full ISO 4217 code list for money WRITERS that must refuse an unknown code
 * (the campaign budget editor). Kept out of `currencyMinorUnits.ts` so the entry
 * bundle does not carry it; see that file for why the table exists at all.
 */
import { ISO_4217_THREE, ISO_4217_ZERO } from './currencyMinorUnits.js';

export const ISO_4217_TWO =
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

/** ISO exponent of a currency code (any case); `undefined` when it is not listed. */
export function isoMinorUnits(currency: string | undefined): number | undefined {
  return currency && /^[A-Za-z]{3}$/.test(currency) ? ISO_4217_MINOR_UNITS.get(currency.toUpperCase()) : undefined;
}
