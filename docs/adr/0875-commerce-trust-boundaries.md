# ADR 0875 — commerce trust boundaries

Status: implemented

Feature-loop round 2, row 37 (`commerce`: catalog, orders, UCP seller + buyer).
Builds on ADR 0177 (e-commerce), 0178 (UCP), 0188 (UCP buyer), 0221/0224/0238
(commerce governance + money completeness), 0296 (one-click), 0615 (refund
claim), 0832 (surface org floor), 0607 (one egress predicate).

## Context

Commerce was written and graded while every charge was demo-mode. Since
2026-10-06 the platform Stripe key is LIVE, and several boundaries that were
honest under "no money moves" are not honest any more. The row-37 grade pass
(three read-only probes, each finding traced to code on `f7a216b78`) found:

| # | Finding | Where | Class |
|---|---|---|---|
| F1 | A public guest who types a contract customer's email gets that customer's negotiated prices + exclusive assortment (and the order lands on the victim's contact) | `routes.ts` public checkout → `ensureContact` → `createOrderInner` → `resolvePrice` | identity from client input |
| F2 | One-click upsell charges a saved card off-session for anyone who knows a paid `orderId`; quantity unbounded | `routes.ts` `/public-store/:orgId/orders/:orderId/one-click` | missing capability proof (env-gated, default off) |
| F3 | `markAsPaid` verifies an intent's status/amount/currency but not that the intent belongs to THIS order — an editor can mark an order paid with another tenant's `pi_` and then refund it from the shared platform account | `commerceService.ts` `markAsPaid`; `stripeApi.ts` `getStripePaymentIntent` drops `metadata` | money truth |
| F4 | UCP `/pay` marks any pending order in the org paid on an unverified AP2 mandate or a bare `payment_intent_id`, even on a live host; UCP order read/cancel/pay are not restricted to the calling client's own orders; a deleted UCP client's tokens keep working | `ucp/routes.ts`, `ucp/ap2.ts`, `ucp/ucpClientStore.ts` | demo posture on a live host |
| F5 | The workflow surface has no `orgPolicy`, so a run acting for a Viewer can refund (live Stripe), adjust inventory, create coupons, send quotes, create orders | `feature.ts` surface registration; `surface.ts` | role floor on the node lane |
| F6 | `ucp*` surface verbs skip the `commerce-ucp-buyer` toggle (HTTP + chat check it) | `surface.ts` | toggle on the node lane |
| F7 | UCP buyer merchant fetch validates only the literal hostname — a DNS name resolving to 10/8 or 169.254/16 is dialed | `ucpBuyer/ucpBuyerService.ts` `merchantFetch` | SSRF (DNS) |
| F8 | Fractional quantity (`0.01`) buys a whole product at a fraction of the price | `createOrderInner` `nonNeg` | amount tampering |
| F9 | The per-org order cap counts canceled orders, so ~5000 abandoned public checkouts disable a store permanently | `assertCap(listOrders…)` | availability |
| F10 | Quote-send approval is keyed per `(quote, version)` and a draft revision does not bump `version`, so an approval for T is reused for 10T | `assertQuoteSendGate` | gate not bound to content |
| F11 | Partial refunds are gated per request, so N refunds just under the threshold never need sign-off | `partialRefundOrder` | gate splitting |
| F12 | `/subscriptions/:id/cycle` mints "paid" orders with no payment check on a live subscription; `subscribe` does not tenant-check `contactId` | `routes.ts`, `subscriptions.ts` | money truth |
| F13 | Product / price-list prices are not quantized on write, so a Stripe line total can differ from the order charge and the webhook rejects a real payment | `createProduct`/`updateProduct`, price lists | money truth |
| F14 | Public checkout + one-click buy inactive products by id; `anon:` tenants can open live checkout sessions on the operator's account | `createOrderInner`; public checkout | exposure |
| F15 | `create-quote` chat tool skips the route's contact tenant check; payout CSV is formula-injectable | `agentTools.ts`; `routes.ts` | hygiene |
| W1 | `order-exception-digest` and `low-stock-reorder` wire the digest into `notify.input`, which the node never reads — the run "succeeds" with a title-only notification | `examples/workflow-chain-packs/commerce/pack.json` | output honesty |
| W2 | Commerce write nodes claim "recorded → replay-safe" but are not side-effect-classified, so a `:fork` re-creates orders/refunds (quarantined in `pack-replay-claim-parity.test.ts`) | `packs/feature.commerce.nodes/pack.json` | replay |

## Decision

**D1 — a public guest is priced as anonymous.** `createOrder` gains
`buyerVerified?: boolean` (default `true`; every authenticated lane is
unchanged). The public checkout and the one-click child pass `false`: the
contact is still LINKED (CRM lead capture, confirmation email, saved payment
method) but pricing, sellability and promotions resolve as an anonymous buyer.
A verified-buyer storefront is future work (a magic-link or account sign-in),
not something an email field can prove.

**D2 — one-click needs a capability.** The public checkout mints
`oc = HMAC(sessionSecret, "commerce-oneclick:v1:" + len-prefixed(tenant, org, order))`
and puts it on the Stripe success URL. The one-click route requires it
(timing-safe compare), refuses a parent older than 24 h, and caps `quantity` at
10. No token ⇒ the same uniform 404 as an unknown order (no oracle).

**D3 — an intent must belong to its order.** `getStripePaymentIntent` returns
`metadata`. `markAsPaid` with a Stripe key requires `metadata.orderId`,
`tenantId` and `orgId` to equal the order; anything else is a 409
`payment_intent_mismatch`. Every intent this host creates already carries that
metadata (checkout session `payment_intent_data[metadata]`, off-session
intents). An operator recording an external payment uses the existing
non-Stripe ids (`manual:`), which skip verification only when no key is set —
on a live host a non-bound id is refused, which is the point.

**D4 — UCP on a live host is honest.**
- `/pay` refuses with 409 `live_payment_required` whenever the platform Stripe
  key resolves: an AP2 mandate is not cryptographically verified (ADR 0178 says
  so), and "demo-mode, no money moves" is false on a live host. Demo hosts keep
  today's behaviour.
- UCP order read, cancel and pay require `order.createdBy === principal.subject`
  (the client that created it); anything else is the uniform 404.
- `verifyToken` refuses a token whose client no longer exists; `deleteClient`
  deletes the client's tokens.

**D5 — the surface carries the HTTP role floor.** `COMMERCE_SURFACE_POLICY`
declares `workspace:write` for every write verb (`createOrder`, `refundOrder`,
`updateFulfillment`, `adjustInventory`, `createQuote`, `sendQuote`,
`createCoupon`, `ucpBuildCart`, `ucpCheckout`) — the same scope their HTTP
routes require (ADR 0832 pattern, `CRM_SURFACE_POLICY` precedent). The `ucp*`
verbs additionally require the `commerce-ucp-buyer` toggle through `resolveOne`
(the predicate the HTTP routes and chat tools already use).

**D6 — the merchant fetch uses the ONE egress dispatcher.** `merchantFetch`
dials through `undici` with `webhookEgressDispatcher()` (connect-time pinned
resolution re-check) while keeping its per-hop `assertEgressAllowed` and manual
redirect loop.

**D7 — money input hygiene.** Order line quantities must be integers in
`1..10000` (a fractional or zero line is a 400, not a silent skip). Product,
variant and price-list prices are quantized to the currency's minor unit on
write. The order cap counts only non-canceled orders. Public checkout and
one-click refuse an inactive product (uniform `validation_error`). An `anon:`
tenant's public checkout never opens a live Stripe session (demo branch).

**D8 — approvals bind to content.** The quote-send gate key includes a hash of
`(lines, total, currency)`; a partial refund is gated on the CUMULATIVE refunded
amount (`already + amt`).

**D9 — subscriptions.** `/cycle` refuses a `paymentMode:'live'` subscription
(the `invoice.paid` webhook is its only paid path); `subscribe` tenant-checks
`contactId` like the order routes. The `create-quote` chat tool applies the
route's contact check; the payout CSV neutralises leading `= + - @`.

**D10 — chain + node honesty.** The commerce chain pack's notify edges become
port-qualified (`digest.content → notify.message`, `draft.content → notify.message`)
and the pack version bumps. The commerce write nodes declare
`role:"side-effect"` (the ADR 0572 mechanism: a replay fork is SERVED the
recorded outcome), the side-effect floor is regenerated, and
`feature.commerce.nodes.create-order` leaves the replay-claim quarantine.

## Adversarial `/architect` pass (pre-code, 2026-10-11) — amendments

An independent pass over the draft above found 1 Blocker, 4 High, 7 Medium.
The decision text is AMENDED as follows (the original wording above is kept
so the reasoning trail survives; where they disagree, this section wins).

- **B1 (Blocker) — D1+D2 did not close F2.** The saved payment method was keyed
  by CONTACT, and D1 still links a guest to the contact their typed email
  resolves to. An attacker paying a cheap order with the victim's email held a
  valid `oc` for a parent whose `contactId` is the victim, and one-click
  charged the victim's card. **Amended D2:** the saved-method row is keyed by
  its SOURCE ORDER (`${tenant}:${org}:${orderId}`, carrying `sourceOrderId`),
  and one-click looks up only the row captured from THAT parent. A legacy
  contact-keyed row is never used (fail closed). The token's 24 h window runs
  from the parent's paid time (`updatedAt` at the paid CAS). On the secret:
  `readSessionSecret()` already THROWS in production when
  `OPENWOP_SESSION_SECRET` is unset (cookie mode cannot run without it), and the
  per-process fallback exists only in dev — so no extra 503 is needed
  (implementation correction to the amendment).
- **H1 — D8's cumulative refund gate was raceable.** `refundedAmount` is
  written only after Stripe succeeds, so N concurrent partial refunds each saw
  `already = 0`. **Amended D8:** the cumulative amount is `refundedAmount` +
  every non-failed ledger claim for the order, read AFTER this request's claim
  lands; the gate key carries that cumulative figure.
- **H2 — D9's `/cycle` check was bypassable** via a degraded-from-live
  subscription. **Amended D9:** `/cycle` refuses whenever the platform key
  resolves, or the row carries `stripeSubscriptionId` / `degradedFromLive`.
- **H3 — D3 guarded the writer, not the money exit.** **Amended D3:** both
  refund paths re-read the intent and require the same metadata binding before
  `createStripeRefund`; an unbound stored id is a 409 `payment_intent_unbound`
  (operator refunds it in Stripe). Rows written by the pre-0875 UCP `/pay` on a
  live host are the population this protects; counting them needs a read-only
  prod query, raised to the orchestrator.
- **H4 — D10 omitted the buyer pack.** **Amended D10:** every write typeId in
  BOTH packs declares `role:"side-effect"`: seller `create-order`,
  `refund-order`, `fulfill-order`, `adjust-inventory`, `create-coupon`,
  `create-quote`, `send-quote`; buyer `build-cart`, `checkout`.
- **M1** — D3's binding applies only on the `stripeKey` branch; keyless callers
  (`evt:` $0 sessions, `subinit:`/invoice ids, seeders) are intentional. A
  live host has no lane for recording offline payments (it never had one:
  `manual:` ids already fail the Stripe lookup) — recorded, not added.
- **M3** — `anon:` exclusion moves into ONE resolver, `liveStripeKeyFor(tenantId)`,
  used by public checkout, quote accept, one-click and subscribe.
- **M4** — quote lines take the same integer `1..10000` rule at create/revise;
  `resolvePrice` quantizes its answer (covers stored legacy prices); the
  5000-order ceiling for a real store and canceled-row growth are Open questions.
- **M5** — on a live host UCP `/checkout` refuses too (409
  `live_payment_required`) rather than minting unpayable pending orders;
  `verifyToken` also checks the client still holds the requested scope.
- **M6** — every commerce WRITE verb on the surface requires a non-empty `orgId`
  (a `writeOrg` guard), so the org floor cannot be skipped by omission. The
  buyer `discover`/`search-catalog` READS keep an optional `orgId`: they write
  nothing, and with D6 in place their egress is the same pinned-resolution
  posture as every webhook. (Implementation correction: the first amendment said
  "every `ucp*` verb"; requiring it on the reads would have broken the chat path,
  which calls them org-less, for no protection the floor adds.)
- **M7** — the commerce chain pack is ALSO a registry-installed
  `core.openwop.workflows.commerce`; the in-tree bump does not reach a host that
  installs from the registry (ADR 0713). Publishing is the orchestrator's
  release step, named in the PR.
- **LOW** — D6: *implementation correction* — Node's global `fetch` bundles undici
  6.x and the installed `Agent` is 7.x, so passing the dispatcher there was not
  reliable; `merchantFetch` calls undici's own `fetch` with `webhookEgressDispatcher()`
  (as `mcpClient.ts` does) and the one test that stubbed the global fetch mocks
  `undici` instead; D1 anonymises all four call sites (sellability, price, bundle
  components, promotions). D1 still emails the typed address and records CRM
  activity on its contact — that is what any store does with a typed email,
  and is listed under Consequences.

## D11 — event-bound chains read the event's record (PR 2, 2026-10-11)

Input: a stood-down peer agent's read-only grade at `83ab2883f`, treated as claims
and re-verified against the code before any change.

- **WF-B1 (verified).** `hostEventDispatcher` passes the event only as
  `metadata.triggerData`; neither `post-purchase-thankyou` nor `low-stock-reorder` had
  a `core.trigger.event` node, so an event-bound run read `{{params.orderId}}` /
  `{{params.productId}}` = `''`. **Decision:** both chains gain a trigger node whose
  `payload` is routed to the read node's NAMED `event` port, and `get-order` /
  `get-product` fall back to `event.orderId` / `event.productId` when the declared
  (manual-run) id is empty. A named port, not the default one: a declared input wins
  over an edge value in `buildNodeCtxInputs`, so the payload on the default port would
  have been overridden by the empty param.
- **WF-B3 (verified).** `low-stock-reorder` read the catalog with `list-products`, which
  ignores `productId` — the model was handed every product. Now `get-product`.
- **WF-I (verified, partly).** *Correction at gate:* declaring `purpose:
  "transactional"` on the sends reddened `chain-node-undeclared-keys` — the
  `core.openwop.integration.email-send` manifest does not declare `config.purpose`
  although the node honours it (ADR 0655 D1). That manifest is a corpus pack, so the
  schema gap is filed (`COM2WF-16`) rather than patched here, and both commerce sends
  still default to `marketing`. `low-stock-reorder` lists `send` last so
  expansion marks it primary (its declared output is `sent`). The false "ADR 0193
  ledger dedups re-fires" claim is removed from the thank-you description.
- **Node honesty.** `getOrder` / `getProduct` / `getQuote` on the surface throw a typed
  `not_found` instead of `success` with `null`; `createOrder` forwards `couponCode`
  (a declared node input it dropped); the `create-coupon` node forwards `currency`.
- **NOT done — WF-B2 (verified, deferred as `COM2WF-9`).** The thank-you still goes to
  the fixed `recipientEmail`. Routing the order contact's address into `send` needs a
  second edge into the send node, and a conditional edge that is false "contributes no
  input but `triggerRule` may still fire the target via other edges"
  (`executor/types.ts` EdgeDef) — so a REJECTED thank-you would fire `send` with a
  recipient and no body. The gate-safe shape needs either an approval gate that passes
  context through or a skip-on-false fan-in rule; that is its own decision.
- **NOT done (filed):** the digest's declared output is `digest` while expansion marks
  the terminal `notify` primary (needs a pack-level `outputRole` declaration the format
  lacks); the digest prompt has no current date; `list-orders` is unbounded; the audit
  actor on surface writes is the literal `'agent'`; the chat tools re-implement the
  route access check rather than sharing one helper; COM-R2-3/5/6 (returns, refund
  reasons, order timeline).

## Market-parity mapping (`/feature-refinement`, 2026-10-11)

Matched against `docs/research/ecommerce-gap-analysis.md` (epics E1–E8),
`docs/research/commerce-merchandising-gap-analysis.md` and
`docs/steward/UX_UPGRADE-commerce.md` (rounds 1–2). Decomposition: ONE unit, an
**extension** of `commerce` (toggle ids `commerce` / `commerce-ucp` /
`commerce-ucp-buyer` unchanged), host-extension under `/v1/host/openwop-app/*`,
**no RFC** (UCP/AP2 are third-party protocols never advertised on the OpenWOP wire).

| Market gap (source) | This ADR | Why / where it lives instead |
|---|---|---|
| E3 checkout/payment integrity — "Stripe-verified pay + webhook" was verify-only; live capture now real | **Addressed** (D3, D7, D9, D2) | intent↔order binding at the writer AND the refund exit; quantized prices; no manual cycle on live subs; one-click capability |
| E3 guest/public checkout | **Hardened, not extended** (D1, D7) | anonymous pricing for unverified guests; a *verified-buyer* storefront (accounts / magic link) is a new feature, filed as an open question |
| E8 agentic commerce governance (UCP both sides, "money gates fail-closed") | **Addressed** (D4, D5, D6) | the fail-closed claim was false on a live host (`/pay`), on the node lane (Viewer writes) and on egress (DNS SSRF) |
| E2 approval orchestration (amount-threshold tiers) | **Addressed** (D8) | gates now bind content (quote) and cumulative amount (refund) |
| E4 replay/exception workflows | **Addressed** (D10) | write nodes served on `:fork`; digest chain actually delivers its digest |
| COM-R2-3 Shopify-style 4-axis order status | Not addressed | UX/data-model upgrade, still deferred in `UX_UPGRADE-commerce.md` |
| COM-R2-5 refund reasons, COM-R2-6 order timeline/notes | Not addressed | UI + model work; no security or honesty defect behind them |
| Live AP2 VC verification + settlement (ADR 0178 last mile) | Not addressed | needs a trust root; D4 refuses on live hosts instead |
| Checkout abuse controls (rate limit / proof of work) | Not addressed | open question below; D7's cap fix makes the abuse non-permanent |

No gap here demands a new ADR: everything addressed is a correctness or trust
fix to the shipped surface, and everything unaddressed is already tracked in the
UX tracker or the open questions below.

## Alternatives weighed

- **D1: verify the email (magic link) before pricing.** Right long-term, but
  it is a new UX flow; anonymous pricing closes the hole today with no new
  surface. Recorded as follow-up.
- **D2: store a one-click nonce on the order.** Works, but needs a write and a
  migration of in-flight orders; an HMAC over existing fields needs neither and
  matches `consent/publicSubjectToken.ts`.
- **D3: a unique `paymentIntentId → orderId` index.** Stops reuse across
  orders but not a foreign intent for ONE order; metadata binding covers both.
- **D4: implement AP2 VC verification.** That is the operator last-mile ADR
  0178 deferred and needs a trust root; refusing on live hosts is the honest
  interim.

## Consequences

- Guest buyers who are also contract customers pay list price on the public
  store (they keep contract pricing on every authenticated lane).
- One-click callers must carry `oc` from the success URL (no in-tree SPA caller
  exists today; the funnel step that calls it reads it from the URL).
- On a live host, UCP agents cannot settle via `/pay`; they get a typed 409.
- Existing chain runs of the old pack version keep their stamped definition;
  the port change only affects new instantiations (no replay-shape change for
  old runs).

## Implementation plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1–D4 money + identity | `test/adr0875-commerce-trust.test.ts` (RED first on `main`) |
| P2 | D5–D6 node lane + SSRF | same file + surface floor test |
| P3 | D7–D9 hygiene | same file |
| P4 | D10 packs + floor regen + quarantine shrink | `pack-replay-claim-parity`, chain tests |

## Open questions

- [ ] A real store stops at 5000 live orders (`MAX.perOrg`), and canceled
      rows now grow without a ceiling — needs a canceled-order purge (follow-up).

- [x] Every tenant's live storefront charges land on the operator's ONE
      platform Stripe account (no Connect on the basic commerce lane). Is that
      intended for non-operator tenants, or should live checkout be restricted
      to Connect-onboarded sellers (ADR 0385)? — product call, raised to the
      orchestrator; D7 only closes the `anon:` slice.

      > **RESOLVED 2026-10-12 → ADR 0877** (user decision, feature-loop row 38).
      > Live checkout on the PLATFORM account is for the operator's own tenants
      > only (`OPENWOP_SUPERADMIN_TENANTS` ∪ `OPENWOP_COMMERCE_PLATFORM_TENANTS`;
      > billing-exempt does NOT grant it). Every other tenant must
      > onboard a Connect account first. Its live checkout is then a destination
      > charge to its own account with the platform application fee; until then,
      > demo. **This ADR's D7 resolver `liveStripeKeyFor` is no longer the charge
      > gate.** It stays the SETTLEMENT/verification key (`/pay`, refunds, UCP
      > `live_payment_required`). Every charge-opening lane now asks ADR 0877's
      > `resolveStorefrontSettlement` instead, enforced by a branded
      > `StorefrontCharge` and a call-site ratchet.
- [ ] Rate limiting / proof-of-work on public checkout (D7's cap fix makes the
      abuse non-permanent, not free).
- [ ] The separate `/commerce/webhook` URL + `commerce:webhook-secret` predates
      the "ONE webhook URL" invariant written for commerce-connect; converge or
      document (row 38).

## Implementation record (2026-10-11, `feat/fl2-37-commerce`)

| Decision | Change | Witness |
|---|---|---|
| D1 | `createOrder({ buyerVerified:false })` on public checkout + one-click | live: "typing a contract customer's email…" |
| D2 | `oneClickToken.ts`; saved-PM keyed by source order; window from `paidAt`; qty ≤ 10 | live: D2 block (3 tests); `commerce-one-click.test.ts` |
| D3 | `getStripePaymentIntent` returns `metadata`; binding FIRST in `markAsPaid`; `assertRefundableIntent` on both refund paths; idempotent re-delivery | live: D3 block + fold-ins; `stripe-live-payments.test.ts` |
| D4 | `assertDemoSettlement`, `ownOrder`, token revocation + live scope intersection; admin `settlement` flag | live: D4; lanes: D4; `ucpFailedReads.test.tsx` |
| D5 | `COMMERCE_SURFACE_POLICY`, `writeOrg`, `assertBuyerEnabled` | lanes: D5 (3 tests) |
| D6 | undici `fetch` + `webhookEgressDispatcher()` | lanes: D6 (structural); `adr0607-egress-url-arms` classified |
| D7 | integer qty 1..10000, `activeOnly`, live-order cap, quantized prices, `liveStripeKeyFor` | lanes: D7; live: anon |
| D8 | content-hashed quote key; cumulative partial-refund gate after the claim | live: D8 (3 tests) |
| D9 | `/cycle` refused when live/degraded; subscribe + quote contact checks; CSV neutralised | live: D9; lanes: D9 |
| D10 | port-qualified notify edges (pack 1.2.0); 9 write nodes `side-effect`; floor regen; quarantine −1 | `workflow-chain-commerce-execution.test.ts`; `pack-replay-claim-parity` |

Grade-pass fold-ins (grade-code `COM2CD-1/2/3/5/7/9`, grade-ux `COM2UX-1/2/3/5/6`)
landed in the same branch; the rest are filed in the trackers with reasons.

