# ADR 0890 — Checkout options: tax (Stripe Tax or Managed Payments), promotion codes, no-card trials

Status: Accepted — implemented (`feat/checkout-tax-promo-trial`). The open questions in §6 are about
Stripe's behaviour, not about this code. Settle them in a Stripe sandbox before an operator turns on
`managed` in live mode.

Related: ADR 0176 (billing), ADR 0419 (paid feature bundles), ADR 0786 (billing money-truth),
ADR 0820 §7 (trials), ADR 0877 (storefront settlement / Connect).

## 1. Context

Book AI wants to sell its author-suite bundle through the billing rail. It needs three things the
bundle checkout cannot do today:

- **Tax.** `createStripeCheckoutSession` (`features/billing/stripeApi.ts`) sends no `automatic_tax`.
  A digital product sold to consumers in the EU, UK and many US states owes VAT/GST or sales tax.
  Today the operator either absorbs that liability or does not sell there.
- **Promotion codes.** Launch and partner discounts need `allow_promotion_codes`.
- **A trial without a card.** ADR 0820 §7 trials always collect a card, which costs conversion for
  a low-priced creative tool.

Every existing install must keep sending exactly the session it sends today.

## 2. Decision

Three operator env knobs, read in `billingService.ts` next to `OPENWOP_BILLING_TRIAL_DAYS` and
passed to the ONE Stripe client. No new client, route, webhook or store.

Each knob is either a bare value (it applies to every plan and bundle, stored as `"*"`) or a JSON
object keyed `"*"`, `"plan:<tier>"` or `"bundle:<id>"`. Those are the keys `TRIAL_DAYS` already
uses. A specific key beats `"*"`. A value the knob does not accept is dropped with a warning, and
the target falls back to the next key or the default. A typo never turns into a guessed mode. Unset
on all three gives the pre-0890 session, and a test asserts its exact key set.

| Knob | Values (default first) | Form params sent |
| --- | --- | --- |
| `OPENWOP_BILLING_CHECKOUT_TAX` | `none` · `automatic` · `managed` | `automatic`: `automatic_tax[enabled]=true`, `billing_address_collection=required`, `customer_update[address]=auto` (only when a `customer` is sent, which is always on this path). `managed`: `managed_payments[enabled]=true` and nothing else. |
| `OPENWOP_BILLING_ALLOW_PROMOTION_CODES` | `false` · `true` | `allow_promotion_codes=true` |
| `OPENWOP_BILLING_TRIAL_CARD` | `required` · `if_required` | Only when a trial applies (`TRIAL_DAYS` gives one, subscription mode, and the first subscription of that plan or bundle): `payment_method_collection=if_required` and `subscription_data[trial_settings][end_behavior][missing_payment_method]=cancel` |

**Scope.** Plan and bundle checkouts share one code path (`createCheckoutSession`), so both get the
options through the same keying. Token-pack checkouts get none of them, even under `"*"`, because
they have no `plan:`/`bundle:` key. This is a choice, not a limit. A later key such as `pack:<id>`
would add them.

**Money truth is unchanged.** Fulfilment is still the ADR 0786 webhook CAS. A no-card trial's
`checkout.session.completed` arrives with `payment_status: no_payment_required`, which fulfilment
already accepts for card trials. A trial that ends with no card produces
`customer.subscription.deleted`, which revokes the grant the same way any cancellation does.

**Managed-mode exclusivity.** Stripe rejects these params on a Managed Payments session:
`automatic_tax`, `tax_id_collection`, `payment_method_types`, `payment_method_configuration`,
`customer_update[name|address]`, `shipping_*`, `adaptive_pricing`, `invoice_creation`,
`subscription_data.{default_tax_rates, application_fee_percent, on_behalf_of, transfer_data,
invoice_settings}`, and the `payment_intent_data.*` Connect and post-sale fields. The `tax` input is
one value, so `automatic` and `managed` cannot both be set. The managed branch sends only
`managed_payments[enabled]`, and nothing else in `createStripeCheckoutSession` emits any of those
params. The test asserts that every one of them is absent, both in subscription and payment mode.

**Boot warning.** `warnCheckoutConfigAtBoot()` runs when the billing feature registers. It logs one
warning when any key is `managed` and the date prefix of the effective `STRIPE_API_VERSION` is
earlier than `2026-04-22`. `scripts/check-billing-config.mjs` reports the same condition as a WARN,
and it now validates all three knobs: an unaccepted value or a key that names nothing real is an
ERROR.

## 3. Alternatives considered

- **Paddle or Lemon Squeezy as merchant of record.** Rejected. A second billing provider means a
  second client, a second webhook, a second customer model and a second fulfilment path. That breaks
  the CLAUDE.md § "Stripe surface" invariant of one Stripe client and one webhook, and it doubles the
  money-truth surface ADR 0786 just closed. Stripe Managed Payments gives the same merchant-of-record
  outcome on the rail we already have.
- **Stripe Tax only (no `managed` mode).** Simpler, but the operator then registers, files and remits
  in every jurisdiction. For a small seller of digital goods that is the cost they are trying to
  avoid. Both modes are offered, and the operator picks per bundle.
- **Upgrade the pinned API version to dahlia.** Rejected here. The pin (ADR 0176 R-1) keeps outgoing
  calls and webhook payload shapes aligned with the ported handlers. An upgrade is its own decision
  with its own webhook-shape audit. `OPENWOP_STRIPE_API_VERSION` already lets an operator move.
- **One JSON blob (`OPENWOP_BILLING_CHECKOUT_OPTIONS`).** Fewer env vars, but it does not match how
  the trial, cadence and display knobs work, and it is harder to change one option on Cloud Run with
  `scripts/update-env.sh`.
- **Promotion codes for token packs too.** Deferred. See Scope.

## 4. Trade-offs

- **No-card trials invite trial farming.** A trial is once per plan or bundle per *workspace*
  (`trialFor` refuses a repeat), and workspaces are cheap to create. Farming yields only the trial
  period, the grant is revoked at trial end, and no money moves, so the exposure is product use, not
  revenue. If it shows up in the funnel, keep `required` for that bundle.
- **`automatic` mode makes the billing address required** on every checkout for that target. That
  adds a little friction, but Stripe Tax needs a location, and our tenant customer is created with no
  address (`createStripeTenantCustomer`).
- **Managed Payments changes who the customer deals with.** Receipts, invoices and transaction
  support come from Link, the statement shows `LINK.COM* …`, Stripe may refund within 60 days, and
  `subscription.default_payment_method` cannot be set through the API. Refunds still emit the usual
  events, so the webhook handlers see them.
- **Managed Payments applies only to NEW subscriptions** created through a Managed Payments Checkout
  Session. Existing subscriptions keep their terms. Switching a bundle to `managed` therefore
  affects only checkouts made after the switch.

## 5. Implementation record

| Phase | What | Where |
| --- | --- | --- |
| P1 | `tax` / `allowPromotionCodes` / `trialWithoutCard` inputs on the ONE client | `features/billing/stripeApi.ts` `createStripeCheckoutSession` |
| P1 | Knob parsing (`checkoutOptionsFor`), wiring into `createCheckoutSession`, boot warning | `features/billing/billingService.ts`, `features/billing/feature.ts` |
| P1 | Operator preflight for the three knobs | `scripts/check-billing-config.mjs` |
| P1 | Tests: exact form per mode, default-off key set, managed forbidden-param sweep, keying, invalid values, boot warning; config-script ERROR/WARN cases | `test/billing-checkout-options.test.ts` (15), `test/check-billing-config.test.ts` (+2) |
| P1 | Docs | README § "Sell paid feature bundles", FEATURES.md env list |

Sabotage witnesses, run while authoring:

- Emitting `automatic_tax[enabled]` inside the managed branch turned both managed tests red.
- Dropping the trial guard in both `billingService` and `stripeApi` turned "if_required with no
  trial is ignored" red.
- Disabling the script's managed-version WARN turned its test red.

## 6. Open questions

1. **Does `managed_payments` work on the pinned `2025-12-15.clover`?** The sources disagree. The
   Stripe changelog lists `managed_payments` as *added* to `Checkout.Session#create` in
   `2026-04-22.dahlia`, after a `2026-02-25.preview` public preview. Stripe's "Update a Checkout
   integration" guide says "Use an API version of `2025-03-31.basil` or later", which clover
   satisfies. Not verified against a live or sandbox key. **Operator action:** create one `managed`
   checkout in a sandbox at the pinned version. If Stripe rejects the param, set
   `OPENWOP_STRIPE_API_VERSION=2026-04-22.dahlia` only after checking the webhook endpoint's version
   and the handlers against dahlia's payload shapes. That makes it an API-upgrade decision, not a
   config flip.
2. **Managed Payments with `payment_method_collection=if_required` and `allow_promotion_codes`.**
   Neither appears on Stripe's list of params a Managed Payments session rejects. Stripe documents
   trial emails for Managed Payments subscriptions, so trials are supported. A *card-less* trial
   under Managed Payments is not explicitly documented. Verify both in the same sandbox test.
3. **Connect.** "Managed Payments doesn't support Connect integrations." The billing session sends no
   Connect params, so a `managed` billing checkout is valid on its own. But an operator who runs the
   ADR 0877 commerce-connect storefront lane on the same Stripe account should not also turn on
   Managed Payments there. The README says so. Whether Stripe refuses the account-level combination
   is unverified.
4. **Product tax codes.** Both modes depend on Dashboard configuration this host does not check:
   tax registrations for `automatic`, eligible product tax codes and accepted terms for `managed`.
   A misconfigured account makes Stripe refuse the session. The checkout then fails with Stripe's
   own message (502 `internal_error`), not a silent untaxed sale.

## 7. Sources (fetched 2026-10-14)

- Stripe, "Update a Stripe Checkout integration to use Managed Payments" — `managed_payments[enabled]`,
  the "Remove unsupported parameters" tables, "new subscriptions only", the basil-or-later line:
  https://docs.stripe.com/payments/managed-payments/update-checkout
- Stripe changelog, "Adds support for Managed Payments" (`2026-04-22.dahlia`):
  https://docs.stripe.com/changelog/dahlia/2026-04-22/managed-payments
- Stripe changelog, "Introduces Managed Payments" (`2026-02-25.preview`):
  https://docs.stripe.com/changelog/clover/2026-02-25/managed-payments
- Stripe, "How Managed Payments works" (Link as merchant of record, emails, refunds, no API update
  of `default_payment_method`): https://docs.stripe.com/payments/managed-payments/how-it-works
- Stripe, "Automatically collect tax with the Checkout page", "Calculate tax for existing customers"
  (`billing_address_collection=required` + `customer_update[address]=auto`):
  https://docs.stripe.com/tax/checkout/page
- Stripe, "Configure free trials for Checkout", "Free trials without collecting a payment method"
  (`payment_method_collection=if_required`,
  `subscription_data[trial_settings][end_behavior][missing_payment_method]=cancel`):
  https://docs.stripe.com/payments/checkout/free-trials?payment-ui=stripe-hosted
