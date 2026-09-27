# ADR 0238 — Commerce money-completeness: partial refunds + the tax/shipping seam

Status: implemented (Phase 1 of the ecommerce-deferral plan)

Relates to: ADR 0177 (commerce feature package), ADR 0221 (commerce governance /
`commerce-spend`), ADR 0224 (transaction graph), ADR 0228 (Phase-D floors), RFC 0095
(connection packs). No OpenWOP wire change (see "Wire honesty" below).

## Context

The Phase-A–D commerce build shipped a correct transaction core but recorded two
money-shaped deferrals:

- **DEF-7 — partial refunds.** `refundOrder` issues a *full* Stripe refund only
  (`createStripeRefund(key, paymentIntentId)` with no `amount`), CAS-claims
  `paid→refunding→refunded`, restores inventory, and gates on one per-order
  `commerce-refund:<orderId>` approval. There was no way to refund *part* of an order.
- **DEF-1 — tax + shipping.** An `Order` carried a `shippingAddress` but no tax or
  shipping *amounts*; the charge was always goods-after-discount. Real merchants need
  destination tax and a shipping charge, ideally from a provider.

## Decision

### DEF-7 — a distinct `partialRefundOrder`, not an overloaded `refundOrder`

The shipped full-refund path (terminal `paid→refunding→refunded` CAS, one-per-order
gate key, once-only inventory restore) is a **return**. A partial refund is a **price
adjustment** and has different invariants (repeatable, no inventory restore). Overloading
`refundOrder` would break all three shipped invariants. So Phase 1 adds a *separate*
operation and leaves `refundOrder` untouched:

- **Append-only refund ledger** (`commerce:refund`, the `StockMovement` pattern) keyed by
  a **required caller `refundKey`** with a deterministic id
  `commerce:refund:<tenant>:<org>:<order>:<refundKey>`. A retry with the same key returns
  the existing refund — the multi-refund idempotency anchor the single-order CAS cannot
  provide.
- **Cumulative `Order.refundedAmount`** (MAJOR units) updated via a **CAS-retry loop** (the
  `casAdjustProductInventory` pattern), guarded so `refundedAmount + amount ≤ chargeTotal`.
- **No inventory restore** on a partial (the goods aren't coming back).
- **Status** → new `partially_refunded` until the cumulative reaches the full charge, then
  `refunded` (never a restore — a series of adjustments is not a return).
- **Gate** keyed **per request** (`commerce-refund:<orderId>:<refundKey>`) so each partial
  gets its own `commerce-spend` sign-off; the full path keeps its per-order key.
- The Stripe layer gains an optional `amountMinor` + `idempotencyKey`
  (`createStripeRefund(key, pi, { amountMinor, idempotencyKey })`); `/v1/refunds` takes an
  integer `amount`, and the idempotency key makes a crash-retry a no-op, not a second
  charge-back.

### DEF-1 — one charge number + a best-effort provider seam

- **`Order` gains** optional `taxLines: [{name, amount}]`, `taxTotal`, `shippingCost`
  (all MAJOR units, same convention as `total`). **`orderChargeTotal(o) = total + taxTotal
  + shippingCost`** and `orderChargeMinor(o)` are the **single source of truth** routed
  through BOTH the Stripe checkout-session builder AND `markAsPaid`'s amount verification,
  so the order, the charge, and the paid check never diverge. `total` keeps its
  goods-after-discount meaning.
- **Where computed:** at **order create** (`createOrder`), best-effort, after pricing and
  the shipping address are known — so every checkout path (guest, cart, quote-accept) is
  consistent and the session builders simply add the tax/shipping line items.
- **The seam** (`features/commerce/taxShipping.ts`, `quoteTaxAndShipping`): a configured
  RFC 0095 tax/shipping connection pack is called through the Connections authorization
  choke point (`resolveConnectionCredential` — allowlist + org `connections:use`); TaxJar
  is the reference tax adapter. **Default and fallback** is flat/manual from governance
  policy (`commerce.flatTaxRatePercent`, `commerce.flatShippingMinor`); unconfigured ⇒
  zero tax / zero shipping — **byte-identical to the pre-0238 posture**. ANY provider
  error/timeout/missing-address falls back to flat — a tax provider hiccup NEVER blocks the
  public guest-checkout hot path.
- **No `commerce-spend` gate:** tax/shipping quotes are READ calls (quote tax, quote a
  rate), not money movement.

## Alternatives weighed

- *Overload `refundOrder` with an optional amount* — rejected: breaks the shipped terminal
  CAS + one-per-order idempotency + once-only restore. A distinct op is cleaner and safer.
- *Compute tax at the Stripe session instead of at create* — rejected: then `markAsPaid`,
  the order, and the session would each need to recompute and could diverge; one
  `orderChargeMinor` through both points is the single-source-of-truth fix.
- *A new `tax`/`shipping` connection-pack category* — rejected: the manifest `category`
  enum is **normative wire** (`schemas/connection-pack-manifest.schema.json`); a new value
  needs an RFC. The seam resolves the provider by **`id`** (`taxjar`/`shippo`), not by
  category, so the packs use `category: "other"` (the openai-images precedent) — no wire
  change.

## Wire honesty (no RFC needed)

Everything here is host-side: new host-ext routes under `/v1/host/openwop-app/commerce/*`,
additive-optional JSON fields on a `DurableCollection` (no schema migration — existing
orders read back with the new fields `undefined`), a new governance-policy sub-field, and
RFC 0095 connection-pack **descriptors** that stay inside the existing `category` enum. No
run-event, capability advert, or endpoint contract changes.

## Implementation

| Piece | Files |
|---|---|
| Partial Stripe refund (amount + idempotency key) | `features/billing/stripeApi.ts` |
| `partialRefundOrder`, refund ledger, `refundedAmount`, `partially_refunded`, `orderChargeTotal/Minor`, `markAsPaid` verify on charge, `commerceSummary` nets refunds + inits all statuses | `features/commerce/commerceService.ts` |
| Tax/shipping seam (flat default + TaxJar adapter, best-effort) | `features/commerce/taxShipping.ts` |
| Flat tax/shipping governance fields | `host/governanceService.ts` |
| Partial-refund + refunds-list routes; tax/shipping Stripe line items; charge in the response | `features/commerce/routes.ts` |
| Connection-pack descriptors | `examples/connection-packs/{taxjar,shippo}/pack.json` |
| FE: status union + i18n (`partially_refunded`), partial-refund control, tax/refund display, client methods | `frontend/react/src/features/commerce/{commerceClient,CommercePage}.tsx`, `i18n/*` |
| Tests | `test/commerce-phase1-deferrals.test.ts` (8) |

## Open questions / follow-ons

- **Shipping provider mapper** (Shippo live rate-shopping) needs a parcel/weight model the
  storefront cart doesn't carry — descriptor shipped, mapper deferred (noted in the pack).
- **Avalara / EasyPost** adapters — additional providers behind the same seam.
- A partial refund does not currently re-open a `refunded` order; the terminal state stays
  terminal (intentional).
- **Guest-checkout tax provider scope:** a provider tax quote on the anonymous
  guest-checkout path resolves only a **workspace-scoped** connection — an org/user-scoped
  connection needs an acting user, which a guest lacks (fail-closed by design). Guests
  therefore get the flat/manual rate unless the merchant configures a workspace-scoped tax
  connection. Signed-in operator orders resolve org/user connections normally.
- **Partial-refund self-heal:** if the process dies in the microsecond between the atomic
  ledger claim and the order-total CAS, the claim is orphaned and a same-key retry returns
  idempotently without re-driving the accumulation (operator reconciles from the ledger).
  Common failures (Stripe error, CAS exhaustion) delete the claim and self-heal on retry.
