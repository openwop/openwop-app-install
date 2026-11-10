# ADR 1025 — Commerce merchandising: money, replay and authority hardening

Status: Accepted — D1 implemented in PR-A (branch `fl2-74a-budget-holds`), D2–D9 in PR-B (branch `fl2-74-merchandising`, row 74); D10 filed (`MCH-STORE-1`)

Amends ADR 0273 (MERCH-A recommendations), ADR 0274 (MERCH-B promotions) and ADR 0275
(MERCH-C discovery). Feature-loop round 2, row 74. Toggle ids unchanged
(`promotions`, `discovery`, `recommendations`); no new toggle, no new package.

## Context

The first workflows grade of the three packages as a unit
(`docs/steward/workflows-assessment/2026-11-02-commerce-merchandising-row74.md`, ids
`MCHWF-*`) found two Blockers and three Highs. Every one was witnessed by a probe through
the real `createOrder` path or by reading the code at `fc536023f`:

| Id | Finding | Evidence |
|---|---|---|
| MCHWF-1 | The loss budget is derived from orders and never reserved, so concurrent checkouts overspend it | 5 concurrent 1-unit checkouts against `maxDiscount: 10` burned **50** |
| MCHWF-2 | The 4 write nodes are `role:"action"`, so `:fork` re-executes them; discovery's two "upsert" nodes always create | `packs/feature.*.nodes/pack.json`; `host/featureSurfaces.ts:10-28` (CSMCD-13) |
| MCHWF-3 | Surface writes sit on the ADR 0832 `workspace:read` floor (no `methodScopes`) | `features/{promotions,discovery,recommendations}/feature.ts` |
| MCHWF-4 | The currency guard is inert on 3 lanes: PATCH ignores `currency`; the chat draft schema cannot carry it; a currency-less denominated promotion applies in any currency | `updatePromotion` never reads `patch.currency`; probe: "10 off" took 10 off a ¥3,000 order |
| MCHWF-5 | An agent (chat or run) creates a LIVE merch rule (it can `hide` inventory from the public search), and there is no route to pause a rule | `discovery/agentTools.ts:285-290`, `discovery/routes.ts` (create + delete only) |
| MCHWF-6 | An unparseable `schedule.endAt` reads as NaN, so the promotion never expires | probe: `endAt: 'last friday'` still discounts |
| MCHWF-7 | Per-type required fields are not enforced (a `cart_threshold` with no `minSpend` is accepted, Active, and never fires) | probe |
| MCHWF-8 | The public search resolves an INACTIVE collection; `parentId` is called "strict at write" and never checked | `discoveryService.ts:188-197`, `:113` |
| MCHWF-9 | No per-org cap on merch rules; every public search iterates them all | `discoveryService.ts:46` (`MAX.rules` caps actions per rule) |
| MCHWF-10 | Shoppers never see merchandising on the app's own storefront (no rec slot, no discovery search, no promotion line before Stripe) | `git grep public-recommendations\|public-discovery frontend/react/src` → 0 |

**Prod (read-only, 2026-11-02, by the lead):** all merchandising data lives in one user
tenant, written in one 2026-07-09 burst: 6 promotions, 6 collections, 4 merch rules, 5
placements, all active, none from a run. **These are the Solstice demo seed**, not
hand-authored rows: the counts match `SOLSTICE_PROMOTIONS` / `_COLLECTIONS` / `_MERCH_RULES`
/ `_PLACEMENTS` exactly (`host/seed-data/solsticeDemo.ts:682-708`), written as
`createdBy: 'demo:merch'` (the SQL's "creator" column folded every non-agent author into
"human"). **2 promotions are denominated with no currency**: the seed's "$10 off orders
over $60" (fixed reward + `minSpend`) and its loss leader (`budget.maxDiscount: 500`),
because `seedDemoMerchandising` passes no `currency` (`host/demoMerchandisingSeed.ts:83-94`),
while the sibling `SOLSTICE_COUPONS` already says "the catalog is seeded 'USD'". Of 63 orders, only 2 ever carried a
promotion, and both were canceled; 0 promotions are over their cap, so MCHWF-1 is latent.
0 runs and 0 stored definitions use the 8 merchandising nodes, so MCHWF-2 has never fired.
The 15 `reco:affinity` rows dated 2026-11-02 07:13Z are the affinity sweep's immediate
boot tick (`affinityRebuild.ts:37`), which rewrites every row on each instance start; it is
not an event writer, and nothing here changes it.

## Boundaries audit

- **Money path.** `commerce/promotionSeam.ts` is the only door from commerce into
  promotions (ruling 1 of ADR 0274: commerce never imports promotions). Fulfilment and the
  amount check stay where ADR 0877 put them. No change to `resolveStorefrontSettlement`,
  the Stripe client, `orderChargeTotal` or `markAsPaid`.
- **Concurrency primitive.** `DurableCollection.compareAndSwap` (`hostExtPersistence.ts:894`)
  is what commerce's own inventory reservation uses (`casAdjustProductInventory`,
  `commerceService.ts:1196`). Reuse it; no lock primitive, no new store type.
- **Replay classification.** `executor/sideEffects.ts` serves recorded outputs on `:fork`
  only for `role:"side-effect"` / `side-effectful` nodes (ADR 0572/0645). The `*-node-replay`
  tests (`crm-node-replay.test.ts` and siblings) are the witness pattern.
- **Surface authority.** `FeatureSurfaceOrgPolicy.methodScopes` (`host/featureSurfaces.ts`)
  is the declared way to raise a method above the floor (app-builder, campaign-brief,
  campaign-orchestration precedents).
- **Agent-proposes firewall.** Promotions drafts (`active:false`) and recommendations
  holdout drafts (ADR 0273 M7) already use it. Discovery is the outlier.
- **No wire change.** Every route is under `/v1/host/openwop-app/*`; node packs are host
  packs. **RFC verdict: host extension, no RFC.**

## Decision

### D1 — Budget holds (MCHWF-1). SHARED SEAM, its own PR (PR-A).

*Lead decision 2026-11-02: D1a, in its own PR (PR-A).*

**D1a (recommended): a CAS'd per-promotion hold ledger.**

**What counts against a budget does not change** (today's `usageFromOrders`,
`promotionsService.ts:324-363`, kept verbatim):
- `canceled` and `refunded` orders count nothing;
- a `pending` order counts in full until it is paid, canceled, or its own
  `reservationExpiresAt` passes;
- `paid` / `fulfilled` count in full;
- `partially_refunded` counts `amount × (total − refundedAmount) / total` and every
  discounted unit.

Holds ADD the in-flight checkouts that do not yet have an order row. They never remove
or reweigh anything above.

- A new promotions-owned collection `promotions:budget-hold`, one row per promotion:
  `{ promotionId, tenantId, holds: [{ holdId, amount, quantity, expiresAt, orderId? }] }`.
- Holds are taken ONLY on the order lane. `applyPromotionsUngated` is also the preview
  entry (`promotions/surface.ts:33`, `promotions/agentTools.ts:147`), so it gains an explicit
  `{ reserve: true }` option that only `applyPromotions` (the commerce hook) passes; a preview
  never touches the ledger (witnessed).
- For each budgeted promotion that would fire: read the ledger row FIRST, then the orders, prune expired holds, compute
  `remaining = cap − (orderUsage excluding orders named by a live hold) − Σ live holds`,
  cap the amount, append a hold, and `compareAndSwap`. On a lost race, re-read and
  recompute (bounded retries, then **fail closed: the WHOLE evaluation returns zero
  promotions**, logged). Dropping only the contended promotion would let lower-priority
  promotions that a non-stackable winner excludes fire instead, and would change the
  approval `gateKey` (`commerceService.ts:997`) between a proposal and its resume. Hold TTL = 120 s, one shared constant with `ORDER_IDEM_STALE_MS`
  (`commerceService.ts:132`) so the two cannot drift; each tax/shipping provider call is
  bounded at 4 s (`taxShipping.ts:50`).
- If the promotions side throws after appending holds, it releases its own holds before
  rethrowing (the commerce hook's `catch` swallows the error, so the ids would otherwise
  never reach commerce).
- `OrderDiscountResult` gains `holdIds?: string[]`. `promotionSeam` gains
  `commitOrderPromotions(holdIds, orderId)` and `releaseOrderPromotions(holdIds)`, default
  no-ops. `createOrderInner` wraps everything from the hook to `orders.put` in ONE
  `try/finally`: commit on success, release otherwise. That covers the approval gate
  (`:998`), inventory reservation (`:1017-1034`), `reservationDue.put` and `orders.put`.
- A committed hold keeps its `orderId` until it expires. Usage counts an order through its
  hold while the hold lives and through `appliedPromotions` after. Reads go ledger first,
  then orders, so an in-flight spend is **never counted zero times while its hold lives,
  and at most twice for ≤ TTL** (when a commit CAS fails after the order exists). Both
  errors are on the safe side: the budget is under-spent, never over-spent.
- A crash between hold and order costs at most one hold for 120 s, after which the budget
  frees itself. This keeps ADR 0274's "no second counter that can leak" property.
- `budget.maxQuantity` rides the same hold (`quantity`).
- The ledger is registered like every other store: tenant teardown, the DSAR census
  (it holds `tenantId` + `orderId`, no subject), and retention. Deleting a promotion
  deletes its ledger row.

  > **CORRECTED 2026-11-02 (PR-A review, MCHA-5):** as shipped, no registration was added
  > and none is needed beyond what the collection already has. It is a tenant-indexed
  > `DurableCollection`, which tenant teardown reaches; it holds no subject, so the DSAR
  > census does not apply. There is no retention purger: expired holds are pruned on the
  > next write to the row, and the row is deleted with its promotion, so a row is bounded by
  > the checkouts of the last TTL.

**D1b:** a per-(tenant, org) CAS'd mutex row held from the hook to the order `put`, only
when a budgeted promotion is active. Simpler, but it serialises every checkout in the
org across a network tax quote, and a crash holds the lock until its TTL.

**D1c (rejected):** a running burn counter. ADR 0274 rejected it for leaking on
cancel/refund; that rationale stands.

### D2 — Write nodes are side-effects (MCHWF-2, MCHWF-11)

`feature.promotions.nodes.create`, `feature.discovery.nodes.collection-upsert`,
`feature.discovery.nodes.merch-rule-upsert` and `feature.recommendations.nodes.placement-upsert`
become `role:"side-effect"` with `capabilities:["side-effectful"]`, so `:fork` serves the
recorded output. Patch-bump each pack. Witness: a `merchandising-node-replay` test in the
`*-node-replay` pattern that runs each write node, forks, and asserts the store row count
is unchanged and the output is the recorded one. The served set is read from the GENERATED
`executor/sideEffectFloor.generated.ts`, so the sabotage drops the entry there (reverting
`pack.json` alone would leave the witness green).

Mechanical consequences, all in the same PR:
- regenerate `sideEffectFloor.generated.ts` (`scripts/gen-side-effect-floor.mjs`, which
  `ci.sh` runs with `--check`);
- bump the pins in `features/packPins.ts` and the `packs/.steward-manifest.json` digests;
- update `test/merchandising-packs.test.ts`, which asserts every node is `action`;
- correct the pack descriptions that say "All role:'action' (recorded → replay-safe)",
  the claim `executor/sideEffects.ts` already corrected, and list `currency` on `create`.

The discovery node names stay (renaming a typeId would break stored definitions, of which
prod has 0, but names are the cheaper thing to keep). Their descriptions stop claiming
"upsert".

### D3 — Write methods need `workspace:write` (MCHWF-3)

`orgPolicy.methodScopes`:
- promotions: `create`.
- discovery: `createCollection`, `createMerchRule`.
- recommendations: `upsertPlacement`.

All set to `workspace:write`, matching the HTTP door and the chat tools. A run with no
person stays tenant-trusted (ADR 0832, unchanged). The floor skips an empty `orgId`
(`featureSurfaces.ts:199`), so each write method also refuses a blank `orgId` itself.

### D4 — Currency is captured on every lane and enforced at evaluation (MCHWF-4)

1. `updatePromotion` reads `patch.currency` (validated by `currencyOrThrow`; `null`/`''`
   clears it only when the promotion is not denominated after the patch).
2. The chat `promotions.draft` schema gains `currency` (enum `CURRENCIES`).
3. `createPromotion` REFUSES a denominated promotion without a currency
   (`validation_error`, field `currency`), on every lane. A pure percentage stays currency-free.
   `updatePromotion` refuses only when the PATCH touches a denominating field (`reward`,
   `minSpend`, `budget`, `currency`) or sets `active:true` and the RESULT is invalid.
   **Pausing is always allowed**, so a legacy row is valid or paused, never wedged.
   The same rule governs D6 and D7 on PATCH.
3a. **The demo seed passes `currency: 'USD'`** (the catalog it seeds is USD), exactly as
   `SOLSTICE_COUPONS` does. Without this, D4.3 throws on the first seeded promotion and
   aborts the rest of `seedDemoMerchandising`.
4. **Existing currency-less denominated rows fail closed at evaluation** (lead decision,
   2026-11-02): such a promotion applies to NO order, the skip is logged as a typed refusal
   (`promotion_currency_missing`), and the list response, the run surface's `listActive`
   and the chat `promotions.list` mark it `needsCurrency: true`. **No data migration.**
   The two prod rows this affects are the demo seed's "$10 off orders over $60" and its
   House Blend loss leader (`createdBy: 'demo:merch'`, one tenant, 2026-07-09). A narrower
   alternative, reading `demo:merch` rows as USD because the seed defines that catalog as
   USD, was offered to the lead and is not taken unless the lead reverses this.
   This overturns the "pre-R2 rows stay first-come" note on `Promotion.currency`
   (`promotionsService.ts:67-69`), which gets a dated correction note. The console
   shows "Not applying: set a currency" with an inline currency picker, which uses the
   PATCH from (1).
   - No migration. Guessing a currency from the catalog is the relabelling the PRO2-P1
     doctrine forbids.
   - **Recorded as a behaviour change:** in the prod demo tenant those two promotions stop
     applying until someone sets a currency (one click in the console). Prod has had 0 paid
     orders carrying a promotion. A self-hosted adopter's pre-R2 denominated promotion
     behaves the same way.

### D5 — Agents propose merch rules; humans activate (MCHWF-5)

- Chat `discovery.create-rule` and the run surface `createMerchRule` pass `active:false`
  explicitly. The service default stays `active:true`, so the HTTP route and the seed keep
  creating live rules (the promotions `surface.ts:43` precedent). The tool tells the model
  it is a proposal.
- A new `PATCH …/discovery/orgs/:orgId/rules/:ruleId` (`workspace:write`) accepts `{active, name}`.
- The console shows each rule's state, with Activate / Pause.
- Collections stay live on create: on their own they hide nothing. D8 makes an inactive
  collection unreachable publicly, so pausing one now means something. The console gains
  Activate / Pause for collections too, through the existing PATCH.

### D6 — Schedules are validated (MCHWF-6)

`startAt` / `endAt` must parse as dates, and `endAt` must come after `startAt`; anything else
is refused at intake on create and patch. At evaluation, a stored unparseable bound **fails
closed**: the promotion is treated as outside its window. Prod has 0 such rows.

### D7 — Per-type intake rules (MCHWF-7)

- `cart_threshold` requires `minSpend > 0`.
- `product_discount`, `loss_leader` and `bogo` require a non-empty scope at create. The patch
  path already deactivates a promotion whose scope empties (PRO2-P22).
- A `fixed` reward requires `value > 0`.

These refusals apply on every lane, because all three lanes call the same service. The
demo seed SKIPS (does not throw on) a promotion whose slugs resolve to an empty scope, so
a partial catalog cannot abort the seed. Fixtures that create denominated promotions
without a currency (`promotions.test.ts`, `promotion-max-quantity.test.ts` and others the
pre-handoff sweep finds) are updated in the same PR.

### D8 — Collections (MCHWF-8)

- `resolveCollection` splits its flag into `activeProducts` and `activeCollection`.
  `searchProducts` passes `activeCollection:true` on EVERY lane (console search, run
  surface, chat tool, public), so a paused collection searches empty for operators and
  agents too: pausing means paused. The console's collection preview
  (`routes.ts:108`) keeps showing a paused collection's members, so an operator can see
  what they would re-enable. Publicly, an inactive id reads like an unknown one (empty).
- `parentId` is validated on create AND `updateCollection`: it must exist in the same org,
  must not be the collection itself, must have no parent of its own, and a collection that
  already has children cannot take a parent (one level, as the comment claims).

### D9 — Bounded merch rules (MCHWF-9)

At most 200 rules per org. Creating one more is refused with a typed error.

### D10 — Storefront merchandising (MCHWF-10): deferred, filed

Rendering recommendations, discovery search and a promotion line on `StorefrontPage` is a
UX feature of its own. Its main open question is whether the cart should show the promotion
before checkout, which needs a public, rate-limited preview of `applyPromotions`: a new
public money read. That is filed as `MCH-STORE-1` with this ADR's open questions. It is not
built here.

## Alternatives weighed

- **Make the "upsert" nodes real upserts instead of side-effects (D2).** That would not stop
  a fork re-issuing the write; it would only make the re-issue land on the same row. Replay
  safety belongs to the role.
- **Migrate the currency-less rows by inferring the catalog currency (D4).** Rejected: it
  relabels money. The tenant fixes the row in one click.
- **Drafts for agent-authored collections too (D5).** Rejected: a collection changes nothing
  a shopper sees on its own.

## Phased plan

| Phase | Scope | PR |
|---|---|---|
| P0 | ADR + tracker | PR-B |
| P1 | D2, D3 (packs, surfaces, replay witness) | PR-B |
| P2 | D4, D6, D7 (promotions intake + evaluation + console `needsCurrency`) | PR-B |
| P3 | D5, D8, D9 (discovery: drafts, rules PATCH, console activate/pause, collections) | PR-B |
| P4 | D1 (budget holds; commerce seam) | PR-A (separate, shared seam) |
| P5 | D10 storefront merchandising | filed (`MCH-STORE-1`) |

## Frontend + i18n

The console gains a `needsCurrency` chip with an inline currency picker (promotions), and
Activate / Pause for merch rules and collections (discovery). Every new string ships in all
four locales (`en`, `es`, `fr`, `pt-BR`); the parity check fails the build otherwise.

## Pre-code `/architect` pass (independent agent, 2026-11-02)

3 CRITICAL, 5 HIGH, 4 MEDIUM, 2 LOW, all folded into the text above:
- C1: D1 put holds in `applyPromotionsUngated`, which is the PREVIEW entry, so every preview
  would have drained the budget. Holds are now order-lane only (`reserve: true`).
- C2: the prod "human" rows are the demo seed, and D4/D7 as drafted would have thrown inside
  `seedDemoMerchandising`. Fixed by seeding `currency: 'USD'`.
- C3: PATCH refusals checked the resulting row, so a legacy promotion could not even be
  paused. Pausing is now always allowed.
- H4: "counted exactly once" was false; restated as never-zero, at most twice, both safe.
- H5: a lost race dropping one promotion changes which promotions fire and the gate key.
  It now fails the whole evaluation closed.
- H6: release paths: the swallowing `catch`, one `try/finally`, and store registration.
- H7: D2's generated floor, pins, manifest and existing test, and a sabotage that can fail.
- H8: D8 affects every search lane, not only public; `updateCollection` and depth rules.
- M9–M12: lane-only drafts, seed and fixture handling, a correction note, and i18n.
- L13–L14: blank `orgId`, the hold TTL tied to `ORDER_IDEM_STALE_MS`.

## Open questions

- OQ1 — resolved: D1a (lead, 2026-11-02).
- OQ2 — Should the cart show applied promotions before Stripe (D10)? That needs a public
  preview read and its abuse budget.
- OQ3 — Should a promotion's currency be required for pure percentages too, to support a
  per-currency storefront later? Not now: a percentage carries no amount.

## Implementation record

| Phase | Decision | Commit (branch `fl2-74-merchandising`) | Witness |
|---|---|---|---|
| P0 | ADR + grade | `4b643d799` | — |
| P1 | D2, D3 | `8af085c9f` | `test/merchandising-node-replay.test.ts` (partition, generated floor, a real run + replay fork of all four writes, Viewer/editor/blank-org legs); sabotages: a served entry dropped, a methodScope dropped |
| P2/P3 | D4–D9 | `a91c790fb` | `promotions/__tests__/promotionsAdr1025.test.ts`, `discovery/__tests__/discoveryAdr1025.test.ts`, `test/merchandising-agent-tools.test.ts`, FE `needsCurrency.test.tsx`, `activatePause.test.tsx`; 11 backend + 2 frontend sabotages |
| grade fixes | review findings (`MCHCD-*`, `MCHUX-*`) | `834527287`, `2b5ab2c89` | `test/merchandising-routes.test.ts` (needsCurrency on the wire), `test/demo-merchandising-seed.test.ts` (seed currency + empty-scope skip) |
| P4 | D1 | PR-A, branch `fl2-74a-budget-holds` (separate: it changes the order path) | `test/promotion-budget-holds.test.ts`: 5 concurrent checkouts burn exactly `maxDiscount`; the same for `maxQuantity`; a crashed checkout's hold expires; a failed order releases; previews never hold; sequential orders count once; delete removes the ledger. Sabotages, each red: reserve off, commit removed, release removed, expiry ignored, preview reserving, ledger delete removed |

**PR-A independent review (static, `/grade-code`): B+ → fixed.** MCHA-1 (High): 5 CAS
attempts with no backoff failed late checkouts of a hot loss leader closed (full price)
while budget remained; now 25 attempts, jittered backoff, and a retry re-reads only the
ledger (witness: 20 concurrent checkouts on an unexhausted budget all get the discount).
MCHA-2 (Medium): holds excluded whole orders, forgetting an order's spend on an unheld
promotion; now excluded per (promotion, order) pair (witnessed). MCHA-3 (Medium): a commit
that finds its hold expired is logged (`promotion_hold_expired`). MCHA-4 (Low): the ledger
row carries a rising `version`, so a stale read can never re-match. MCHA-5: the
registration text corrected above. MCHA-6: the two new witnesses.

**As shipped, D1 differs from the text above in one place:** `createOrderInner` is a thin
wrapper over the unchanged body (renamed `createOrderCore`) rather than a `try/finally`
inside it. It releases on any throw from the body and commits after it returns, so a new
early exit added to the body cannot strand a hold. Between the order `put` and the commit,
the spend is counted twice (hold without an `orderId` + the order): the safe direction.

**Filed (not built here):** `MCH-STORE-1` (D10, storefront merchandising), `MCHCD-10` (the
merch-rule cap is checked before the write), `MCHUX-5` (server refusals as raw English
toasts; a shared console gap), `MCHUX-9`, `MCHUX-10`, `MCHUX-14`. See
`docs/steward/CODEBASE-ASSESSMENT-merchandising-row74.md` and
`docs/steward/UX-ASSESSMENT-merchandising-row74.md`.

**Correction (2026-11-02, found by the pre-handoff sweep):** D7's "fixtures updated in
the same PR" missed `test/merch-product-lifecycle.test.ts`, whose promotions used
`reward.kind: 'percent'`. That is not a valid kind; the old intake silently read it as a
percentage, which is exactly the `MCHCD-6` defect. The new refusal reddened it, and the
fixture now says `'percentage'`. No production row used `'percent'` (prod's reward kinds:
`percentage` and `fixed` only).
