# ADR 0786 — Billing money truth: fulfil what was paid, only what was paid, only for its owner

Status: Accepted (post-/architect, 2026-09-29; 2 Blockers + 6 Highs folded into the decision text before code)

**Date:** 2026-09-29 · **Feature:** `billing` (EXTENDS ADR 0176 / 0419; toggle id
unchanged, no new package) · **Feature loop:** 2026-10 row 9 · **Grade:**
`docs/steward/WORKFLOWS-ASSESSMENT.md` § Billing (`BILLWF-1..16`)
**RFC verdict: none.** Host-extension under `/v1/host/openwop-app/billing/*` and a
host-private Stripe integration; no run-event, capability, endpoint contract or
normative behaviour changes.

## Context

The `/grade-workflows` pass found the CLAUDE.md Stripe invariants intact (one client,
one webhook URL with two secrets, the routing order, toggle-independent money events,
`priced ⟹ gated`). What is broken is what the processor writes after it has a
verified event:

| Id | Defect (evidence in the grade) | Money effect |
|---|---|---|
| `BILLWF-1` | plan + token-pack checkouts carry no tenant correlation; the pack credit reads fields a real payload never has | customer charged, nothing granted |
| `BILLWF-2` | bundle grant = "not `.deleted`"; one-time purchases ignore `payment_status` | granted, never paid |
| `BILLWF-3` | every non-bundle subscription event (incl. commerce PRODUCT subs stamped `metadata.tenantId=<merchant>`) rewrites the tenant's PLAN row | merchant downgraded by a shopper's cancel; merchant's portal opens the shopper's customer |
| `BILLWF-4` | plan row get→put without CAS; no ordering; a late event for an old sub overwrites the current one | paying tenant locked, or cancelled plan resurrected |
| `BILLWF-5` | checkout / bundle checkout / portal gated only on the toggle | a Viewer can cancel the workspace plan or re-point its card; anon tenants can buy |
| `BILLWF-6` | ADR 0176's "balance draw MUST discount cached reads before prepaid goes live" never shipped; `BILLWF-1`'s fix makes prepaid live | over-charges prepaid customers ~5× on cached prompt tokens |
| `BILLWF-7` | no checkout reuses the tenant's Stripe customer; a second plan checkout double-subscribes | duplicate customers; double billing |
| `BILLWF-8` | signature check keeps only the last `v1` | every event rejected during a secret roll |

**The witnesses share the blind spot** (the row-4 lesson): `billing.test.ts` builds
a `checkout.session.completed` with a `priceId` field and a `customer` in payment
mode — neither exists on a real session payload — so the broken live path has
always been green.

## Competitive / best-practice matrix

| Practice | Source | Ours today | This ADR |
|---|---|---|---|
| Fulfil from the Checkout Session id; retrieve it (line items are expand-only); fulfil only if `payment_status != 'unpaid'`; handle `async_payment_succeeded`; "safe to run multiple times, even concurrently"; record fulfilment per session | Stripe, *Fulfill orders* (docs.stripe.com/checkout/fulfillment) | none of these | D1 |
| Events are not ordered; "don't use `created` to determine order"; retrieve the object from the API | Stripe, *Webhooks § Event ordering* | payload applied as-is | D4 |
| `canceled` is terminal; revoke on `canceled`/`unpaid`; `incomplete` means not yet paid | Stripe, *Using webhooks with subscriptions* | bundle grants on `incomplete`; late `.updated` resurrects | D2, D4 |
| Multiple `v1` signatures during a secret roll; compare each, constant-time | Stripe, *Webhooks § Verify manually* | last `v1` only | D8 |
| One Customer per billing entity; pass `customer` to Checkout | Stripe Checkout (`customer` param) | new Customer per purchase | D7 |
| Credits land only after payment succeeds | Lago wallets (`invoice_requires_successful_payment`) | pack credit would land on `completed` regardless | D1 |
| Auditable credit ledger (grants, draws, expiries, cost basis) | Orb prepaid credits | a mutable counter | filed `BILLWF-17` (not this ADR) |
| Dunning grace (`past_due` keeps access for N days) | Stripe settings; Chargebee/Metronome (not re-verified this pass) | plan drops to free on `past_due` | filed `BILLWF-13` (policy, not widened here) |

## Boundaries audit

- **Single owners, reused:** Stripe HTTP = `features/billing/stripeApi.ts`
  (`stripeRequest`); the webhook = `routes.ts` `POST …/billing/webhook`; the event
  dedup = `seenEvents` CAS; the checkout record = `billing:checkout`
  (`billingService.ts:472`) — **already written, never read back**; tenant authority =
  `requireTenantScope` (`features/featureRoute.ts`) over `MANAGEMENT_SCOPES`
  (`host/accessControlService.ts:114`), the `host:byok:manage` precedent (ADR 0711 /
  0779, `routes/byok.ts:72`); the anon predicate = the `anon:` shape
  (`commerce-connect/stores.ts:100` — the ADR 0385 GEN-CC-1 guard); cached-read
  semantics = `providers/dispatch.ts:118-124` (subset for OpenAI/MiniMax, disjoint
  for Anthropic).
- **No second anything:** no second Stripe client, no second webhook route, no second
  dedup ledger, no new store except fields on existing rows. Commerce-connect's
  pre-routing (`routes.ts:186-216`) is untouched and still runs before any billing
  code — the ordering invariant is preserved by construction.
- **Commerce product subscriptions** (`features/commerce/subscriptions.ts:120`) keep
  reaching billing's webhook and keep driving `fireSubscriptionInvoicePaid`; D3 only
  stops them being mistaken for the plan.

## Decision

> **Revised after the `/architect` pass (2026-09-29) — see § "Architect record" for
> the 17 findings and their dispositions.** Two Blockers were in this text: the
> first draft claimed "a crash between steps is safe" while the `event.id` claim
> itself strands a paid event on a crash (the ADR 0615 class it cited as solved),
> and it phased the cached-read discount AFTER the fix that makes prepaid live.

### D0 — The event claim is a lease, not a tombstone (architect #1)

`seenEvents` rows gain `state: 'claimed' | 'done'` and `claimedAt`. A delivery
CAS-inserts `claimed`; applies; then CAS-flips to `done`. A delivery that finds:
- `done` (or a legacy row with no `state`) → `202 duplicate`;
- a FRESH `claimed` (younger than 2 minutes — two 15 s Stripe reads plus CAS
  retries fit inside it) → **`409` in-progress**, so Stripe RETRIES the delivery
  instead of treating it as delivered (a `2xx` here would drop it if the holder
  then dies);
- a STALE `claimed` → takes the claim over by CAS (`claimed@t0 → claimed@t1`) and
  applies.
A handler error still releases the claim (delete) and returns 500. This is safe
because every handler below is idempotent by construction (D1's credit dedup rides
the balance CAS; D4 applies fetched state; bundle activation is by value;
`runSubscriptionCycle` is per-invoice idempotent, `commerce/subscriptions.ts:168`),
so a takeover that re-applies is harmless. Commerce-connect's own ledger is untouched.

### D1 — Every checkout is correlated, and fulfilment reads the session we created (`BILLWF-1`, `-2`)

- `createCheckoutSession` stamps EVERY session (plan, pack, bundle):
  `metadata = { tenantId, kind, priceId, bundleId? }`
  with `kind ∈ plan | token-pack | bundle`, and in subscription mode the same map on
  `subscription_data[metadata]`. *(Implementation correction: the draft also set
  `client_reference_id = tenantId`. Dropped — tenant ids contain `:` and the checkout
  row plus metadata already carry the tenant, so a field whose accepted charset we had
  not verified bought nothing but a way to 502 every checkout.)*
- **Tenant resolution for `checkout.session.*` moves to the `billing:checkout` row**
  (architect #3): the ROUTE resolves the session's row by `data.object.id` first, then
  metadata, then the customer scan — still AFTER the Connect and `ccOrderId`
  branches, so the routing-order invariant is unchanged. A pre-ADR in-flight session
  (row, no metadata) is therefore reachable.
- The row is the **authority** for tenant + price; the row gains `kind` and
  `fulfilledAt?`. A row whose tenant disagrees with `metadata.tenantId` is refused
  (error log, `ignored`). A session with NO row falls back to metadata only when
  `metadata.kind` is present AND a Stripe key is configured: the handler retrieves
  the session with `expand[]=line_items` and requires
  `line_items[0].price.id === metadata.priceId` (architect #11 — "amounts verified
  before flipping"; a dashboard/Payment-Link session carrying `kind` cannot choose its
  own price). Otherwise the session is not ours (commerce storefront, a Payment Link)
  and is ignored with a log line.
- **Paid check:** with a key, the handler RETRIEVES the session and reads
  `payment_status`; without one it reads the payload's. It fulfils only on `paid` or
  `no_payment_required`. `unpaid` on `completed` waits for
  `checkout.session.async_payment_succeeded`; `async_payment_failed` fulfils nothing.
- **Exactly-once: the dedup marker rides the same CAS as the money.** A pack credit is
  ONE compare-and-swap on the tenant's balance row that adds the tokens AND appends
  the session id to `creditedSessions` (bounded to the last 100; CAS is a whole-row
  compare, so the list adds no new contention class). A session already in the list
  credits nothing, so a second event for one session (`completed` then
  `async_payment_succeeded`) and a D0 takeover are both safe. `creditBalance` must
  carry the list (today it rebuilds the row without spreading it); `drawFromBalance`
  already spreads it; the importer keeps an imported list. `fulfilledAt` on the
  checkout row is written after, informational only.
- One-time bundles fulfil on the same paid check; activation is by value.
- EVERY session kind records its `customer` on the plan row when the row has none
  (D7), so the portal works for pack/bundle-only tenants too.

### D2 — ONE entitled-status predicate (`BILLWF-2`)

`isEntitledStatus(s) = s === 'active' || s === 'trialing'`, used by
`resolveEntitlements` (plan, already this) AND the bundle grant. A grant is `active`
iff its subscription's status is entitled and the event is not a delete.
`SubscriptionStatus` widens to Stripe's full set (`unpaid`, `incomplete_expired`,
`paused`) instead of the unchecked cast at `billingService.ts:621`. The grant stores
the raw Stripe status as `stripeStatus` — **terminal checks key on that raw status,
never on the derived `active|canceled`** (architect #7: a `past_due` grant is
not-active but must still recover to `active`). `past_due` stays non-entitled for
both (no widening; grace is `BILLWF-13`).

### D3 — A plan event applies only to the tenant's plan subscription (`BILLWF-3`, `-15`)

A non-bundle `customer.subscription.*` event mutates the plan row only when the
subscription IS a plan: its ITEM price maps to a plan tier (`planTierForPrice` —
the item, not `metadata.priceId`, which goes stale after a portal plan switch), OR
`metadata.kind === 'plan'`, OR its id equals the row's `stripeSubscriptionId` (R-1
imported subscriptions map by price anyway). Anything else — commerce product
subscriptions (inline `price_data`, `productSubscriptionId` metadata) above all — is
`ignored` for the plan row. `payment_method.*` touches the plan row only when the
method's `customer` is the row's customer.

**Invoices (architect #5 — a finding outside this ADR's first reading).** The pinned
API version `2025-12-15.clover` REMOVED `invoice.subscription` (Stripe basil
changelog, "Invoicing resources now specify how they were generated"): the id is
`invoice.parent.subscription_details.subscription` and the subscription's metadata
snapshot is `invoice.parent.subscription_details.metadata`. So today `obj.subscription`
is always undefined on a live invoice and the ADR 0279 product-subscription bridge
(`fireSubscriptionInvoicePaid`) has never fired in live mode — and the route drops
product invoices anyway, because their customer is the shopper's and they carry no
top-level `metadata.tenantId`. Fix: read the sub id and tenant from
`parent.subscription_details.{subscription,metadata.tenantId}`, falling back to the
legacy top-level field (pre-basil payloads, R-1). `latestInvoiceId` is written only
for the plan subscription's invoices. The witnesses post clover-shaped invoices
through `POST …/billing/webhook`, not `processStripeEvent` (the
`subscription-bridge-integration.test.ts` blind spot).

### D4 — Order-independent, race-free subscription state (`BILLWF-4`)

- **CAS on every plan-row write** (`mutateSubscription(tenantId, fn)`, the
  `creditBalance` shape; exhaustion throws → claim released → Stripe retries). The
  superadmin `setSeats` and `importBillingState` writes move onto it too (architect #9).
- **Fetch, don't trust the payload's order.** With a key, a `customer.subscription.*`
  event RETRIEVES `GET /v1/subscriptions/:id` and applies the fetched state (Stripe:
  "don't use `created` to determine event order … retrieve the object"). The row and
  the grant keep `syncedAtMs` (the local fetch time); a fetched write whose fetch is
  OLDER than the stored one is skipped inside the CAS. **Only fetched
  subscription-state writes set or compare `syncedAtMs`** — invoice, payment-method,
  customer-record, seat and import writes never touch it, so an unrelated write can
  never make a status change look stale. Cross-instance this relies on NTP-grade
  clocks for two fetches of one subscription inside the same few milliseconds — the
  residual is stated, not hidden. Without a key the payload is applied and only the
  terminal rule orders it; a keyless live webhook logs a warning.
- **Terminal per subscription id, remembered** (architect #6). Stripe: `canceled` "is a
  terminal state that can't be updated"; `incomplete_expired` never bills. The row and
  each grant keep a bounded `endedSubscriptionIds` (last 20). An event for an ended id
  is ignored, whether or not that id is still the "current" one.
- **A different subscription supersedes only when it is entitled.** An event for S1
  while the row holds S0 replaces S0 iff S1's status is entitled and S1 is not ended.
  So a canceled or incomplete old subscription never displaces a newer one, and an
  `incomplete` new one waits until it is paid. (The first draft's "or S0 is not
  live" clause let a stale S0 displace an incomplete S1.)

### D5 — Buying and managing billing are admin acts; anon never buys (`BILLWF-5`)

- New management scope **`host:billing:manage`** in `MANAGEMENT_SCOPES` AND
  `ADMIN_SCOPES` (owner inherits), never mintable onto a custom role (`host:` scopes
  are refused there, `accessControlService.ts:208`).
- `POST /checkout`, `POST /bundles/:id/checkout` and `POST /portal` call
  `requireTenantScope(req, 'host:billing:manage')` — the ADR 0711/0779 BYOK authority,
  chosen over `callerHoldsTenantScope` because the latter grants undeclared `owk_`
  keys (ADR 0779 § correction). It short-circuits on the caller's own personal
  workspace, so solo users are unaffected.
- **The anon refusal is a separate, mandatory check** (architect #12):
  `requireTenantScope` ALLOWS an `anon:` personal tenant via that short-circuit
  (`isPersonalTenantId` accepts `anon:`). A host-level `isAnonTenantId(tenantId)` in
  `host/requestSubject.ts` (not commerce-connect's predicate — importing it would make
  a billing→commerce-connect edge on top of commerce-connect→billing) refuses 403
  `forbidden` ("Sign in to purchase") on all three writes.
- Reads stay open to members.
- *(grade-code `BILLCD-7`, recorded)* `requireTenantScope` judges ONE identity spelling,
  so a bound caller whose shared-workspace membership row is still keyed `oidc:<sub>`
  is refused. This fails CLOSED and is the ADR 0779 BYOK posture on purpose (ADR 0779's
  correction showed bind re-keys member rows, and the union helper grants undeclared
  `owk_` keys); it is not widened here.

### D6 — The prepaid draw discounts cached reads; the free cap does not (`BILLWF-6`) — ships WITH D1 (architect #2)

`recordManagedUsage` threads `cachedReadTokens`; the balance draw charges
`(input − cached) + cached × w + output` for an OpenAI-compatible target (cached is a
SUBSET of input) and `input + cached × w + output` for Anthropic (DISJOINT,
`dispatch.ts:118-124`). `w` is a field on the managed target (ADR 0176 asked for
per-target), read from `OPENWOP_MANAGED_CACHED_READ_WEIGHT`, clamped to [0,1],
default `0.2` = MiniMax-M3's $0.06 cache read / $0.30 input (re-measured 2026-09-29
from published M3 pricing). The daily cap keeps full weight — ADR 0176's cost-rail
reasoning; its contradictory "applied to BOTH" sentence gets a correction note. The
recorded usage bucket is unchanged.

### D7 — One customer per tenant; one live plan (`BILLWF-7`)

- Before the FIRST checkout of any kind, billing ensures the tenant has a Customer:
  the plan row's `stripeCustomerId` if present, else `POST /v1/customers` with
  `metadata[tenantId]` and a tenant-keyed idempotency key (`billing-customer:<tenant>`,
  so two concurrent first clicks get one customer), stored by CAS on the plan row
  (a `none`-status row if the tenant has no plan). Every checkout then passes
  `customer`. (`customer_creation` is not needed once a customer always exists.)
- A plan checkout while the row says the plan is live (`active | trialing | past_due`)
  is refused **409 `conflict`** ("change your plan in the billing portal") — but with
  a key the handler first RETRIEVES that subscription, and if Stripe says it is not
  live the row is reconciled and the checkout proceeds (architect #8: an imported or
  previously-resurrected row must not lock a tenant out of buying). A bundle checkout
  while that bundle's grant is entitled is refused 409 the same way.
- **Known limit, stated:** the 409 is advisory between checkout completion and the
  first subscription event; a double click inside that window can still
  double-subscribe. Reusing the tenant's still-open plan session closes most of it
  and is filed (`BILLWF-19`).
- **Existing corrupted rows** (a plan row carrying a shopper's customer from
  `BILLWF-3`) are an operator repair, sized read-only in prod before deploy (see §
  Deploy note), not a runtime heuristic: shopper customers carry no tenant metadata,
  so no safe runtime test tells them from an R-1 MyndHyve customer.

### D8 — Any matching `v1` verifies (`BILLWF-8`)

Parse every `v1` in `Stripe-Signature`, ignore other schemes (Stripe: downgrade
protection), compare each in constant time; accept if any matches within the 5-minute
window. The commerce storefront webhook shares `verifyStripeSignature` and gets the
fix too.

### D9 — Stripe read failures are classified (architect #10)

The webhook's reads (session, subscription, customer, line items) map failures by
class: `404`/`400` (object not found, a key from another account after a rotation) →
error log + `ignored` (a permanent failure must not 500 until Stripe disables the
endpoint); `401` → 500 + an error log naming `billing:stripe-key`; timeout/`5xx`/`429`
→ release the claim and 500 so Stripe retries.

### Operator step (architect #13)

The billing endpoint must also subscribe `checkout.session.async_payment_succeeded`
and `checkout.session.async_payment_failed`. Added to the ADR 0385 deploy-day
checklist and README § "Stripe payments".

## Filed, not in this ADR (with reasons)

- `BILLWF-9` customer→tenant reverse index — performance only. Correction
  (architect #17): invoice and payment-method events carry no top-level metadata, so
  they still scan; D3 removes the scan only for subscription and checkout events.
- `BILLWF-10` coupons never applied; invoices only superadmin-minted — honesty; a
  correction note on ADR 0176 now, removal or real Stripe-invoice sync as a follow-up.
- `BILLWF-11` clobber-proof importer; `-12` seat push to Stripe; `-13` dunning grace;
  `-14` a chat read tool; `-16` positive-balance cap bypass (overdraft bounded by one
  call); `-17` an auditable credit ledger (Orb parity); `-19` reuse a still-open plan
  session to close the double-click window; `-20` `fireSubscriptionInvoicePaid`
  swallows a failed period order after a 2xx, so Stripe never redelivers it — now
  logged loudly, propagation (safe: the cycle dedupes per invoice) filed; `-21` the
  managed balance draw is skipped when the usage increment before it throws
  (`recordManagedUsage`, architect #14).

## Evaluation matrix

| # | Dimension | Answer |
|---|---|---|
| 1 | Feature-package | extends `features/billing`; one host touch (`accessControlService.ts` scope list) and one provider touch (`managedProvider.ts` draw arithmetic); core imports no feature |
| 2 | Toggle | `billing` unchanged (OFF by default); webhook stays toggle-independent (money truth) |
| 3 | Workflow orchestration | none added; `fireSubscriptionInvoicePaid` unchanged |
| 4 | Node pack | none (money writes are not chat/workflow-drivable by design) |
| 5 | Envelopes | none |
| 6 | Agent pack | none; `BILLWF-14` read tool filed |
| 7 | Public surface | webhook only (unchanged path); signature hardening D8 |
| 8 | RBAC | D5; refuse-side tests for Viewer, Editor, anon, custom role |
| 9 | Replay / fork | Stripe calls already fail closed under replay (`assertEffectAllowed('payment')`); the webhook is not run-scoped |
| 10 | Frontend | hide/disable "Manage billing" and bundle Buy for non-admins (read the 403, `common:error_forbidden`); a "payment processing" state on `?checkout=success` — ce-owned files need approval first |

## Phased plan

| Phase | Scope | Witnesses (each sabotage-checked on committed code) |
|---|---|---|
| P1 | D0–D9 backend, D6 included (architect #2: prepaid must not go live without it) | a REAL-shaped session payload (no `priceId`, `customer:null`, `payment_status`) credits once; completed+async for one session credits once; `unpaid` credits nothing; plan checkout carries metadata + `client_reference_id`; `incomplete`/`unpaid` bundle never grants; product sub never touches the plan row; late `.updated` after `.deleted` stays canceled; concurrent invoice+update keeps `active`; old-sub event never overwrites; Viewer/Editor/anon 403 on the three writes, admin/owner/personal 201; any-`v1` accepts a rolled header |
| P3 | SPA (after ce OK) | non-admin sees no enabled money button; 403 maps to `common:error_forbidden`; processing state |

## Architect record (2026-09-29, pre-code)

17 findings: 2 Blocker, 6 High, 5 Medium, 4 Low. Dispositions:

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | Blocker | claim-first `seenEvents` strands a paid event on a crash | D0 lease + takeover |
| 2 | Blocker | D6 phased after the fix that makes prepaid live | D6 in P1 |
| 3 | High | checkout row unreachable: tenant resolved in the route before it is read | D1 route resolution by session row |
| 4 | High | pack/bundle buyers still mint unrecorded customers; portal `demo` for them | D7 ensure-customer before any checkout |
| 5 | High | clover invoices carry `parent.subscription_details`, not `subscription`; product-sub bridge dead live | D3 invoice paragraph |
| 6 | High | "terminal per sub id" not representable; supersede rule resurrects | D4 `endedSubscriptionIds` + entitled-only supersede |
| 7 | High | grant `canceled` conflates `past_due` | D2 raw `stripeStatus` |
| 8 | High | 409 locks out stale-live rows; advisory window | D7 reconcile-then-409; window filed `BILLWF-19` |
| 9 | Medium | `syncedAtMs` scope; setSeats/import not CAS | D4 |
| 10 | Medium | permanent 4xx on a read → 500 forever | D9 |
| 11 | Medium | metadata fallback trusts `metadata.priceId` | D1 expand + price match, key required |
| 12 | Medium | anon allowed by the personal short-circuit; predicate import cycle; scope needs ADMIN_SCOPES; tests use non-personal tenants | D5 |
| 13 | Medium | async events need an operator subscription | § Operator step |
| 14 | Low | per-target weight; M3 ratio unverified | D6 (re-measured 0.2) |
| 15 | Low | `creditBalance` drops fields; importer overwrites | D1 |
| 16 | Low | witnesses must go through the route | P1 witness list |
| 17 | Low | BILLWF-9 rationale overstated (invoice/pm events always scan) | filed, rationale corrected |

## Blast radius in production (measured 2026-09-29, read-only, counts only)

Sized by the peer session that runs prod queries:
- **Env:** only `OPENWOP_BILLING_BUNDLE_PRICES`, `_BUNDLE_DISPLAY` and
  `_PLAN_FEATURES` are set. **No plan prices and no token-pack prices.**
- **Rows:** `billing:subscription` = 0, `billing:checkout` = 0, `billing:token-balance` = 0,
  and no commerce product-subscription collection exists.
- **Webhooks:** six events processed, each with a resolved tenant — the monthly
  renewals of ONE live bundle tenant (crm + marketing).

So `BILLWF-1` (plan/pack never fulfilled), `BILLWF-3` (product subs overwrite the plan)
and the dead clover invoice bridge are **LATENT — no customer was affected, no backfill
is needed.** They **must be fixed before anyone sets plan or pack prices or sells
product subscriptions**, which is why they ship here rather than being filed. The
**bundle path is LIVE**, so the Blockers that bite it now — `BILLWF-2` (an
`unpaid`/`incomplete` renewal kept access), `BILLWF-4` (a late `.updated` resurrected a
cancelled bundle) and `BILLWF-5` (any Viewer of that tenant could open its portal and
cancel or change the card) — are the P1 priority, each with a refuse-side witness, and a
regression witness replays the live tenant's renewal shape (pre-0786 metadata without
`kind`, a grant without `stripeStatus`, legacy ledger rows without `state`).

**Backfill path (designed, not executed — a separate, user-approved step if ever
needed).** Should a paid-but-uncredited session ever be found: list the tenant's
Checkout Sessions from Stripe (`GET /v1/checkout/sessions?customer=…&status=complete`,
`expand[]=line_items`), and for each `paid` session run the SAME D1 fulfilment
(`creditBalance(tenant, tokens, sessionId)`). Because the credit's dedup marker is the
session id inside the balance CAS, a replay is idempotent — a session already credited
credits nothing — so the backfill can be re-run safely and cannot double-credit. The
100-entry `creditedSessions` window bounds this to a tenant's last 100 packs; a deeper
backfill needs `BILLWF-17` (the ledger) first.

## Deploy note (draft)

- **Operator:** subscribe the two `checkout.session.async_payment_*` events.
- **No manual repair:** the `BILLWF-3` corruption count in prod is 0 (measured above).
- **Visible:** Viewers/Editors no longer see a working "Manage billing" or Buy;
  anon sessions cannot buy; a second plan checkout returns 409 → portal.
- **The live bundle tenant:** its next renewal records its Stripe customer on the plan
  row, so "Manage billing" opens its real portal instead of the demo sentinel.

## Open questions

- [ ] Should `past_due` keep access for a grace window (`BILLWF-13`)? Product call; not
      widened here.
- [ ] Refund / dispute of a token-pack charge claws back nothing today (billing ignores
      `charge.refunded`). Filed as `BILLWF-18`; out of this ADR's blast radius.
