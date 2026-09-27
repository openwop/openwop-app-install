// DEF-1 (ADR 0238) + ADR 0250 — the tax + shipping seam.
//
// Checkout needs a tax and shipping figure once a shipping address is known. This is a
// SEAM, not a hard dependency on any provider:
//
//   • DEFAULT (no provider connection configured) ⇒ flat/manual: a governance-policy
//     flat tax rate (% of goods-after-discount) + a flat shipping charge. Both unset ⇒
//     zero tax / zero shipping — byte-identical to the pre-0237 posture. Fully CI-tested.
//
//   • PROVIDER (an RFC 0095 tax/shipping connection pack is configured for the tenant) ⇒
//     a bounded, best-effort call to the provider's PINNED host through the Connections
//     authorization choke point (`resolveConnectionCredential` runs the allowlist + org
//     `connections:use` scope). Tax: TaxJar → Avalara (first configured wins). Shipping:
//     Shippo carrier rate-shopping (cheapest rate), which needs the org's ship-FROM origin
//     (governance `commerce.shipFrom`) + a per-order parcel (summed product weights). ANY
//     provider error/timeout/missing-input falls back to flat/manual — a provider hiccup
//     must NEVER block a sale (the public guest-checkout hot path).
//
// These are READ quotes (quote tax, quote a rate), not money movement, so they do NOT go
// through the `commerce-spend` approval gate. Credentials stay host-side (resolved
// per-call, never logged, never in the payload); the request carries only the address +
// parcel a quote needs — never the customer's contact details or internal ids.

import { resolveConnectionCredential } from '../connections/connectionsService.js';
import { toStripeMinorUnits } from '../billing/stripeApi.js';
import { getGovernancePolicy } from '../../host/governanceService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('commerce.tax-shipping');

/** Pinned provider hosts (SSRF guard — the outbound URL host MUST be one of these).
 *  Mirrors the `apiHosts` in each connection-pack manifest. */
const PROVIDER_HOSTS: Record<string, string> = {
  taxjar: 'api.taxjar.com',
  avalara: 'rest.avatax.com',
  shippo: 'api.goshippo.com',
  easypost: 'api.easypost.com',
};

/** The base URL for a provider. Defaults to its pinned `https://<host>`; an operator/test
 *  may override ALL providers to a single base via `OPENWOP_COMMERCE_PROVIDER_BASE` (the
 *  `OPENWOP_STRIPE_API_BASE` precedent — an env/ops trust boundary, not user input, so no
 *  SSRF surface). */
function providerBase(provider: string): string {
  const override = process.env.OPENWOP_COMMERCE_PROVIDER_BASE;
  if (override) return override.replace(/\/+$/, '');
  return `https://${PROVIDER_HOSTS[provider]}`;
}

const QUOTE_TIMEOUT_MS = 4000;

export interface TaxShippingAddress {
  line1?: string; line2?: string; city?: string; region?: string; postalCode?: string; country?: string;
}
export interface TaxShippingParcel { weightGrams: number; dims?: { l: number; w: number; h: number } }
export interface TaxShippingQuote {
  taxLines: { name: string; amount: number }[];
  taxTotal: number;      // MAJOR units (same convention as Order.total)
  shippingCost: number;  // MAJOR units
  taxSource: 'provider' | 'flat' | 'none';
  shippingSource: 'provider' | 'flat' | 'none';
}

function minorToMajor(minor: number, currency: string): number {
  const zeroDecimal = toStripeMinorUnits(1, currency) === 1;
  return zeroDecimal ? minor : Math.round(minor) / 100;
}
function round2(n: number): number { return Math.round(n * 100) / 100; }

/** Quote tax + shipping for a checkout. Never throws — always returns a usable quote
 *  (flat/manual fallback), so a caller can fold it into the order unconditionally. */
export async function quoteTaxAndShipping(input: {
  tenantId: string; orgId: string;
  currency: string;
  subtotalAfterDiscount: number; // MAJOR units — the taxable base
  address?: TaxShippingAddress;
  parcel?: TaxShippingParcel;    // summed cart weight/dims — enables carrier rate-shopping
  actingUserId?: string;
}): Promise<TaxShippingQuote> {
  const { tenantId, orgId, currency, subtotalAfterDiscount } = input;

  // Flat/manual baseline + the ship-from origin from governance policy.
  let flatTaxRatePercent = 0;
  let flatShippingMinor = 0;
  let shipFrom: { postalCode: string; country: string; region?: string; city?: string } | undefined;
  try {
    const policy = await getGovernancePolicy(tenantId);
    flatTaxRatePercent = Math.max(0, Math.min(100, policy?.commerce?.flatTaxRatePercent ?? 0));
    flatShippingMinor = Math.max(0, policy?.commerce?.flatShippingMinor ?? 0);
    shipFrom = policy?.commerce?.shipFrom;
  } catch (e) {
    log.warn('tax/shipping policy read failed — flat-zero fallback', { tenantId, error: e instanceof Error ? e.message : String(e) });
  }

  const flatShipping = round2(minorToMajor(flatShippingMinor, currency));

  // Run the (independent) shipping-rate and tax provider quotes CONCURRENTLY so a slow
  // carrier + a slow tax provider don't serialize into ~2× latency on the guest-checkout
  // hot path. Both are best-effort (never throw) — flat/none on any failure.
  const [rate, providerTax] = await Promise.all([
    tryProviderShipping({ tenantId, orgId, currency, shipFrom, address: input.address, parcel: input.parcel, actingUserId: input.actingUserId }),
    tryProviderTax({ tenantId, orgId, currency, subtotalAfterDiscount, address: input.address, actingUserId: input.actingUserId }),
  ]);

  // Shipping — a carrier rate (needs origin + destination + parcel) else flat.
  let shippingCost = flatShipping;
  let shippingSource: TaxShippingQuote['shippingSource'] = flatShipping > 0 ? 'flat' : 'none';
  if (rate !== null) { shippingCost = rate; shippingSource = 'provider'; }

  // Tax — a configured tax provider (TaxJar → Avalara), else flat, else none.
  if (providerTax) {
    return { taxLines: providerTax.taxLines, taxTotal: providerTax.taxTotal, shippingCost, taxSource: 'provider', shippingSource };
  }
  if (flatTaxRatePercent > 0 && subtotalAfterDiscount > 0) {
    const taxTotal = round2(subtotalAfterDiscount * (flatTaxRatePercent / 100));
    return { taxLines: [{ name: `Tax (${flatTaxRatePercent}%)`, amount: taxTotal }], taxTotal, shippingCost, taxSource: 'flat', shippingSource };
  }
  return { taxLines: [], taxTotal: 0, shippingCost, taxSource: 'none', shippingSource };
}

// ── Tax providers (TaxJar → Avalara) ─────────────────────────────────────────

async function tryProviderTax(input: {
  tenantId: string; orgId: string; currency: string; subtotalAfterDiscount: number;
  address?: TaxShippingAddress; actingUserId?: string;
}): Promise<{ taxLines: { name: string; amount: number }[]; taxTotal: number } | null> {
  const addr = input.address;
  if (!addr || !addr.country || input.subtotalAfterDiscount <= 0) return null; // need a destination + a base
  const scope = { tenantId: input.tenantId, actingUserId: input.actingUserId, orgId: input.orgId };
  const taxjar = await resolveCred('taxjar', scope);
  if (taxjar) return taxjarTax(taxjar, addr, input.subtotalAfterDiscount);
  const avalara = await resolveCred('avalara', scope);
  if (avalara) return avalaraTax(avalara, addr, input.subtotalAfterDiscount);
  return null;
}

async function taxjarTax(secret: string, addr: TaxShippingAddress, amount: number): Promise<{ taxLines: { name: string; amount: number }[]; taxTotal: number } | null> {
  const body = { to_country: addr.country, to_zip: addr.postalCode ?? '', to_state: addr.region ?? '', to_city: addr.city ?? '', amount, shipping: 0 };
  const json = await postJson('taxjar', '/v2/taxes', { authorization: `Bearer ${secret}` }, body);
  const collected = (json as { tax?: { amount_to_collect?: number } })?.tax?.amount_to_collect;
  return normalizeTax(collected);
}

async function avalaraTax(secret: string, addr: TaxShippingAddress, amount: number): Promise<{ taxLines: { name: string; amount: number }[]; taxTotal: number } | null> {
  // AvaTax createTransaction (simplified): Basic auth over the account:licenseKey secret;
  // one line at the destination; read `totalTax`.
  const body = {
    // AvaTax rates are effective-DATED — use today, not the epoch (a 1970 date returns a
    // wrong-era rate or is rejected). Runtime clock is fine here (not the replay sandbox).
    type: 'SalesOrder', companyCode: 'DEFAULT', date: new Date().toISOString().slice(0, 10),
    customerCode: 'guest', addresses: { shipTo: { country: addr.country, region: addr.region ?? '', postalCode: addr.postalCode ?? '', city: addr.city ?? '' } },
    lines: [{ number: '1', amount, taxCode: 'P0000000' }],
  };
  const json = await postJson('avalara', '/api/v2/transactions/create', { authorization: `Basic ${Buffer.from(secret).toString('base64')}` }, body);
  return normalizeTax((json as { totalTax?: number })?.totalTax);
}

function normalizeTax(collected: unknown): { taxLines: { name: string; amount: number }[]; taxTotal: number } | null {
  if (typeof collected !== 'number' || !Number.isFinite(collected) || collected < 0) return null;
  const taxTotal = round2(collected);
  return taxTotal === 0 ? { taxLines: [], taxTotal: 0 } : { taxLines: [{ name: 'Sales tax', amount: taxTotal }], taxTotal };
}

// ── Shipping carriers (Shippo → EasyPost rate-shop) ──────────────────────────

interface ShipFrom { postalCode: string; country: string; region?: string; city?: string }

async function tryProviderShipping(input: {
  tenantId: string; orgId: string; currency: string;
  shipFrom?: ShipFrom;
  address?: TaxShippingAddress; parcel?: TaxShippingParcel; actingUserId?: string;
}): Promise<number | null> {
  const { shipFrom, address, parcel } = input;
  if (!shipFrom || !address?.country || !address.postalCode || !parcel || parcel.weightGrams <= 0) return null; // can't rate-shop
  const scope = { tenantId: input.tenantId, actingUserId: input.actingUserId, orgId: input.orgId };
  // First configured carrier wins (mirrors the taxjar → avalara tax cascade above).
  const shippo = await resolveCred('shippo', scope);
  if (shippo) return shippoRate(shippo, shipFrom, address, parcel, input.currency);
  const easypost = await resolveCred('easypost', scope);
  if (easypost) return easypostRate(easypost, shipFrom, address, parcel, input.currency);
  return null;
}

/** Bill ONLY rates in the ORDER's currency (a carrier can return account-currency or mixed
 *  rates, and `orderChargeTotal`/`markAsPaid` assume ONE currency — a foreign rate would
 *  silently over/undercharge), and the CHEAPEST of those. Carrier rates are NOT sorted, so we
 *  scan for the min. No same-currency finite-positive rate ⇒ null ⇒ flat fallback. ONE selector
 *  so the money-selection invariant can't drift between carriers (grade-code HIGH). */
function cheapestInCurrency(rates: { amount: number; currency: string }[], want: string): number | null {
  const w = want.toUpperCase();
  const amounts = rates
    .filter((r) => r.currency.toUpperCase() === w)
    .map((r) => r.amount)
    .filter((a) => Number.isFinite(a) && a > 0); // a zero/negative rate ⇒ ignore (fall back to flat)
  return amounts.length ? round2(Math.min(...amounts)) : null;
}

/** Shippo `POST /v1/shipments` — grams + cm native; rate field is `amount`. */
async function shippoRate(secret: string, shipFrom: ShipFrom, address: TaxShippingAddress, parcel: TaxShippingParcel, currency: string): Promise<number | null> {
  const body = {
    address_from: { zip: shipFrom.postalCode, country: shipFrom.country, state: shipFrom.region ?? '', city: shipFrom.city ?? '' },
    address_to: { zip: address.postalCode, country: address.country, state: address.region ?? '', city: address.city ?? '' },
    parcels: [{ weight: String(parcel.weightGrams), mass_unit: 'g', ...(parcel.dims ? { length: String(parcel.dims.l), width: String(parcel.dims.w), height: String(parcel.dims.h), distance_unit: 'cm' } : { length: '10', width: '10', height: '10', distance_unit: 'cm' }) }],
    async: false,
  };
  const json = await postJson('shippo', '/v1/shipments', { authorization: `ShippoToken ${secret}` }, body);
  const rates = (json as { rates?: { amount?: unknown; currency?: unknown }[] })?.rates;
  if (!Array.isArray(rates)) return null;
  return cheapestInCurrency(rates.map((r) => ({ amount: Number(r.amount), currency: typeof r.currency === 'string' ? r.currency : '' })), currency);
}

/** EasyPost `POST /v2/shipments` (ADR 0250 follow-on). EasyPost parcels are OUNCES + INCHES
 *  (our model is grams + cm) so convert; a ~10 cm cube defaults when dims are absent, mirroring
 *  the Shippo default parcel. The rate field is `rate` (a string), NOT Shippo's `amount`. */
async function easypostRate(secret: string, shipFrom: ShipFrom, address: TaxShippingAddress, parcel: TaxShippingParcel, currency: string): Promise<number | null> {
  // grams → ounces / cm → inches (1 decimal, EasyPost's convention). Floor a positive weight at
  // 0.1 oz so a sub-~1.4 g item still rates (a 0-weight parcel gets no rates ⇒ flat fallback).
  const oz = (g: number): number => Math.max(0.1, Math.round((g / 28.3495) * 10) / 10);
  const inch = (cm: number): number => Math.round((cm / 2.54) * 10) / 10;
  const d = parcel.dims ?? { l: 10, w: 10, h: 10 };
  const body = {
    shipment: {
      from_address: { zip: shipFrom.postalCode, country: shipFrom.country, state: shipFrom.region ?? '', city: shipFrom.city ?? '' },
      to_address: { zip: address.postalCode, country: address.country, state: address.region ?? '', city: address.city ?? '' },
      parcel: { weight: oz(parcel.weightGrams), length: inch(d.l), width: inch(d.w), height: inch(d.h) },
    },
  };
  // EasyPost Basic auth: base64("<API_KEY>:") — the trailing colon (empty password) is REQUIRED.
  const json = await postJson('easypost', '/v2/shipments', { authorization: `Basic ${Buffer.from(`${secret}:`).toString('base64')}` }, body);
  // The POST returns the shipment object with `rates` auto-populated. A hard failure rides a
  // non-2xx (postJson ⇒ null); a rated-but-no-usable-carrier shipment returns 2xx with an empty
  // `rates` (+ a `messages[]` we don't need to read) — both funnel to the flat fallback.
  const rates = (json as { rates?: { rate?: unknown; currency?: unknown }[] })?.rates;
  if (!Array.isArray(rates)) return null;
  return cheapestInCurrency(rates.map((r) => ({ amount: Number(r.rate), currency: typeof r.currency === 'string' ? r.currency : '' })), currency);
}

// ── Shared HTTP + credential helpers ─────────────────────────────────────────

async function resolveCred(provider: string, scope: { tenantId: string; actingUserId?: string; orgId: string }): Promise<string | null> {
  try {
    const resolved = await resolveConnectionCredential({ tenantId: scope.tenantId, provider, actingUserId: scope.actingUserId, orgId: scope.orgId });
    return resolved?.secret ?? null;
  } catch { return null; }
}

/** Bounded best-effort POST returning parsed JSON, or null on ANY failure (never throws —
 *  the caller falls back to flat). Secrets ride the caller-supplied auth header only. */
async function postJson(provider: string, path: string, authHeaders: Record<string, string>, body: unknown): Promise<unknown | null> {
  try {
    const res = await fetch(`${providerBase(provider)}${path}`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
    });
    if (!res.ok) { log.warn(`${provider} quote non-2xx — flat fallback`, { provider, status: res.status }); return null; }
    return await res.json().catch(() => null);
  } catch (e) {
    log.warn(`${provider} quote failed — flat fallback`, { provider, error: e instanceof Error ? (e.name === 'TimeoutError' ? 'timed out' : e.message) : String(e) });
    return null;
  }
}
