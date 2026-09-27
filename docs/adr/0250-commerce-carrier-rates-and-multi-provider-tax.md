# ADR 0250 — Commerce carrier rate-shopping + multi-provider tax

Status: implemented (ecommerce-deferral follow-on, Group B)

Relates to: ADR 0238 (DEF-1 tax/shipping seam), ADR 0177 (commerce package), RFC 0095
(connection packs). No OpenWOP wire change; no schema migration.

## Context

ADR 0238 (DEF-1) shipped the tax/shipping SEAM with a TaxJar reference tax adapter and a
flat/manual default; shipping was flat-only (the Shippo pack was a descriptor with the rate
mapper deferred). Two follow-ons remained: real carrier **rate-shopping** (needs a parcel +
an origin) and **more providers** (a second tax provider; a second carrier).

## Decision

### Parcel model on `Product`

`Product` gains optional `weightGrams?` + `dims?: {l,w,h}` (cm) — additive-optional, no
migration. `createOrder` sums the cart's physical-line weights and passes a `parcel` to the
quote **only when EVERY physical line carries a weight** (an unweighed line ⇒ the total is
understated ⇒ fall back to flat). Digital/service lines add no weight.

### Multi-provider tax (TaxJar → Avalara)

`tryProviderTax` now resolves the first configured tax connection: TaxJar, then Avalara
(AvaTax `createTransaction`, Basic auth, reads `totalTax`). Each is a real mapper; first
configured wins.

### Carrier rate-shopping (Shippo)

New `tryProviderShipping`: when a Shippo connection is configured **AND** the org sets
`commerce.shipFrom` (origin) **AND** the cart has a parcel weight, it calls Shippo's rate API
(`POST /v1/shipments`), reads `rates[]`, and bills the **cheapest**. Any missing input /
error / timeout ⇒ the flat governance rate. EasyPost ships as a **descriptor pack** with the
rate mapper a noted follow-on (honest — the seam resolves by provider id, Shippo is the wired
carrier).

### Hot-path safety (unchanged discipline)

All provider calls stay **best-effort**: bounded `AbortSignal.timeout`, flat fallback on any
failure, and the rate call only fires when all inputs are present — a carrier hiccup NEVER
blocks the public guest-checkout sale. These are READ quotes (not money movement) → **no**
`commerce-spend` gate. Credentials ride the Connections broker (never logged/in-payload); the
request carries only from/to postal + parcel + line amount, never customer contact details.

### Testability

A provider **base-URL override** (`OPENWOP_COMMERCE_PROVIDER_BASE`, the `OPENWOP_STRIPE_API_BASE`
precedent — an env/ops trust boundary, not user input) lets tests point the pinned mappers at
a loopback mock, so the real Shippo/TaxJar/Avalara mappers get **CI coverage** (parse + cheapest-
rate selection + fallback), not just the flat path. Default is the pinned `https://<host>`.

## Alternatives weighed

- *Fabricate all four provider mappers without tests* — rejected; ship Shippo + Avalara wired
  and mock-tested, EasyPost as an honest descriptor.
- *A new `shipping`/`tax` connection-pack category* — rejected (the manifest `category` enum is
  normative wire; the seam resolves by provider **id**, so packs use `category:"other"`, the
  DEF-1 precedent — no wire/RFC change).
- *Rate-shop with a partial parcel* — rejected; understated weight → wrong rate. Fall back to
  flat unless every physical line is weighed.

## Wire honesty (no RFC)

Host-side only: additive-optional `Product.weightGrams`/`dims`, an additive governance
sub-field (`shipFrom`), new provider mappers behind the existing broker, and RFC 0095
descriptor packs inside the existing `category` enum. No run-event/capability/endpoint change.

## Implementation

| Piece | Files |
|---|---|
| `Product.weightGrams`/`dims` + `cleanParcel`; create/update + routes; cart-weight aggregation in `createOrder` | `features/commerce/commerceService.ts`, `routes.ts` |
| Provider dispatch (TaxJar→Avalara), Shippo rate-shop, base-URL override | `features/commerce/taxShipping.ts` |
| `commerce.shipFrom` | `host/governanceService.ts` |
| Connection packs (avalara + shippo + easypost mappers now all live) | `examples/connection-packs/{avalara,easypost,shippo}/pack.json` |
| FE: shipping-weight field in the admin product form | `frontend/react/src/features/commerce/{CommercePage,commerceClient}.tsx`, i18n |
| Tests (mock carrier via the base override) | `test/commerce-followon-b.test.ts` (5) |

## Review fixes (code-review)

- **Currency safety (HIGH, was blocking):** Shippo can return rates in the account currency
  (or mixed); billing the numeric-cheapest would silently over/undercharge since
  `orderChargeTotal`/`markAsPaid` assume one currency. Fixed: filter rates to the **order
  currency** (case-insensitive) before selecting the cheapest; no same-currency rate ⇒ flat.
  Locked by a regression test.
- **Latency (MEDIUM):** the shipping and tax quotes now run **concurrently** (`Promise.all`)
  so a slow carrier + slow tax provider don't serialize into ~2× checkout latency.
- **Avalara date (MEDIUM):** the transaction date is **today**, not the epoch (effective-dated
  rates).
- **Zero-rate (LOW):** a `0`/negative carrier rate is ignored (falls back to flat) rather than
  silently zeroing a merchant's shipping.

## Open questions / follow-ons

- ~~**EasyPost rate mapper** — descriptor shipped; the mapper is a follow-on behind the same seam.~~
  **SHIPPED:** `easypostRate` lands behind the same seam as a second carrier in the `shippo →
  easypost` cascade (mirroring the `taxjar → avalara` tax cascade). It `POST`s `/v2/shipments`
  (Basic auth `base64("<key>:")` — the trailing colon is required), converts our grams+cm model
  to EasyPost's ounces+inches, and parses the `rate` field (string, unlike Shippo's `amount`).
  The cheapest-same-currency selection is now a **shared `cheapestInCurrency` helper** so the
  money-selection invariant can't drift between carriers. Both EasyPost error paths (a top-level
  `error` on a non-2xx, or a 2xx with empty `rates`+`messages[]`) funnel to the flat fallback.
  Tested with a `/v2/shipments` mock + an easypost-only connection (asserting the cheapest rate,
  the Basic-auth header, and the grams→ounces conversion).
- **Dims-driven rates + dimensional weight** — the mapper sends dims when present but defaults a
  10×10×10 parcel otherwise; dimensional-weight pricing is a refinement.
- **Tax on shipping** — tax is quoted on the goods subtotal; taxing shipping (jurisdiction-
  dependent) is a refinement.
