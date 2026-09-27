# KickTodo commerce + seats (unit G4) — chat-first port review

**Scope:** BE `backend/typescript/src/features/kicktodo-commerce/` + FE
`frontend/react/src/features/kicktodo-seats/`. The operator/creator money
surfaces (share-ledger table, payout runs UI, earnings, seller onboarding UI)
render in **kicktodo-admin** and **kicktodo-studio** (separate units) over the
same routes; the only FE in *this* unit is the buyer seat-purchase page.

**Headline verdict:** this unit **already rides the engine**. It is the ADR
0420/0445/0447/0451 money ADAPTER — every owned concept (money, capacity,
approvals, obligations, affiliate, contacts, subject-erasure, exception feed)
instantiates its host owner; nothing is shadowed. There is **no orphaned
workflow, no toothless agent, no bespoke approve/submit button, and no PARALLEL
money system**. Money surfaces are legitimately PAGE-LEGIT here, and their
honesty loops are unusually well kept (confirm is *words, not a button*;
"accrued" is honestly unpaid; host never moves money). The one real defect is a
**broken honesty loop on the seat page's Pay step** (promises a checkout it
never links). The rest are watch-items, not ports.

---

## Contract scouting (pinned evidence)

- **No workflow is declared or ignited by this unit.** `grep` for
  `startWorkflowRun` / `WorkflowDefinition` / `agentProfile` in
  `kicktodo-commerce/` returns nothing. There is no orphaned orchestration to
  ignite — so the "declared-without-igniter = THEATER" law finds no target.
- **No agent pack for this feature.** No `*.agents/` pack references
  `kicktodo-commerce`; the only kicktodo agent is the *challenge-author* persona
  (`packs/feature.kicktodo.agents/pack.json:27`), owned by the core/factory
  unit, and it holds **no** commerce/seat/payout/referral tools (correct —
  pricing/payout is post-publish config, not authoring). No
  `registerFeatureAgentTool` call exists in this package. ⇒ no toothless-agent
  THEATER, but a genuine **design opportunity** (see Deferred).
- **The node pack exposes exactly three READ adapters**, all `role:action`
  thin passthroughs over `ctx.features['kicktodo-commerce']`:
  `feature.kicktodo.nodes.entitlement-check`
  (`packs/feature.kicktodo.nodes/pack.json:179`, index.mjs:236),
  `…seat-availability` (pack.json:260, index.mjs:496), `…referral-code`
  (pack.json:278, index.mjs:241). They fail typed on a missing capability
  (`host_capability_missing`, index.mjs:217/245/500). These RIDE the existing
  node catalog and are consumed by kicktodo-core workflows (factory pricing
  step, daily-loop paid chip, referral-invite link) — composition test passes.
- **Owners instantiated, not shadowed** (the RIDES greps):
  - money truth → `registerOrderPaidObserver`/`registerOrderRefundObserver`
    from `commerce/commerceService` (`feature.ts:31-41`); adapter never learns
    Stripe (`seatService.ts:11`).
  - obligation ledger → `createObligationLedger` (`shareLedgerService.ts:142`);
    this is the ADR 0447 extraction — the state machine lives at
    `host/obligationLedger`, only the domain stays here (`shareLedgerService.ts:8-13`).
  - capacity/seats → `holdSeat`/`confirmSeat`/`releaseSeat` from
    `kicktodo-accountability/cohortService` (`seatService.ts:19-26`,
    owner at cohortService.ts:346/390/441) — "never a second counter"
    (`seatService.ts:10-13`).
  - approvals → `createConnectSellerApproval` on the SHARED queue
    (`sellerRequestService.ts:18-21`, owner at approvalService.ts:424) — "no
    parallel queue" (`sellerRequestService.ts:5-11`).
  - affiliate → `createAffiliate`/`affiliateByCode` (`subjectAffiliateBridge.ts:24`);
    the subject→code map is an explicit sidecar, "no new ledger, no Affiliate
    schema change" (`subjectAffiliateBridge.ts:5-9`).
  - contact bridge → `linkSubjectToContact` (`contactLinkObserver.ts:13`).
  - subject erasure → `registerSubjectEraser` (`compliance.ts:30/44`).
  - exception feed → `registerExceptionSource` (`exceptionSources.ts:12/36`).
  - enroll gate + tier → `registerEnrollGuard` (`feature.ts:53/58`).
- **Chassis/authority constraints that bound the surface:**
  - Money effects register **unconditionally at boot**; the toggle gates only
    linking/read routes (`feature.ts:6-9`, `routes.ts:86-88`). Correct per the
    ADR 0176/0385 money-truth rule.
  - Buyer actions (availability, hold) sit on the open feature gate; **publisher
    authority** (`requireKicktodoManage`) gates linking, policy, ledger, payout,
    reconcile (`routes.ts:128/148/232/246/293/380`). Payout ACTIONS additionally
    require `commerce-connect` live (`payoutGate`, `routes.ts:44-47`).
  - `anon:` tenants can never onboard as sellers (`sellerRequestService.ts:62`).
  - The durable-collection name `kicktodo-entitlements` **collides** with
    `host/entitlementSeam` vocabulary; documented, considered, and DECLINED as a
    naming smell (not a shared store/path) — `entitlementService.ts:60-68`.

---

## Verdict table

| # | Capability | Today | Verdict | Port target |
|---|---|---|---|---|
| 1 | Grant/revoke challenge entitlement on paid/refund | order observers → CAS-derived entitlement (`entitlementService.ts:146`, `feature.ts:31-32`) | **RIDES** | leave |
| 2 | Grant/release cohort seat on paid/refund | `reprocessSeatOrder` over cohort owner (`seatService.ts:123`, `feature.ts:35-36`) | **RIDES** | leave |
| 3 | Seller-onboarding request | ONE `connect-seller` approval on shared queue (`sellerRequestService.ts:78`) | **RIDES** | leave |
| 4 | Self-referral accrual veto | `registerAffiliateAccrualGuard` (`feature.ts:63`, `subjectAffiliateBridge.ts:174`) | **RIDES** | leave |
| 5 | Tier / max-active-enrollment gate | `registerEnrollGuard` + billing entitlements (`tierGuard.ts:27`, `feature.ts:58`) | **RIDES** | leave |
| 6 | Buyer→Contact identity link | `registerOrderPaidObserver`→contact bridge (`contactLinkObserver.ts:26`) | **RIDES** | leave |
| 7 | Subject erasure (DSAR) | `registerSubjectEraser`, anonymize-not-delete (`compliance.ts:44`, `entitlementService.ts:292`) | **RIDES** | leave |
| 8 | Payout-run exception feed | `registerExceptionSource` → admin Exception Ledger (`exceptionSources.ts:36`) | **RIDES** | leave; complete deep-link (watch) |
| 9 | Workflow read nodes (entitlement/seat/referral) | 3 thin `role:action` adapters over surface (`surface.ts:13`) | **RIDES** | leave |
| 10 | Author share ledger accrual/reversal | derived over `host/obligationLedger` (`shareLedgerService.ts:251`) | **ADAPTER** | leave; watch CAS-byte-match |
| 11 | Payout runs create/confirm/cancel | obligation-ledger runs; evidence-gated confirm (`shareLedgerService.ts:322-335`) | **ADAPTER** | leave |
| 12 | Referral-code resolve/mint + earnings | subject↔affiliate sidecar (`subjectAffiliateBridge.ts:79`) | **ADAPTER** | leave |
| 13 | Reconcile entitlements/shares (operator repair) | idempotent forward-repair sweep (`entitlementService.ts:235`, `shareLedgerService.ts:288`) | **ADAPTER** | leave |
| 14 | Buyer seat reserve→pay→confirm page | bespoke page; real hold, confirm-is-words (`SeatPurchasePage.tsx:28`) | **PAGE-LEGIT** | keep; **fix Pay-step honesty loop** |
| 15 | Creator revenue / my-earnings / referral-earnings reads | self-scoped count/ledger projections (`entitlementService.ts:199`, `routes.ts:280`) | **PAGE-LEGIT** | keep |
| 16 | Product↔challenge & product↔cohort link (catalog config) | publisher-gated writes (`entitlementService.ts:80`, `seatService.ts:48`) | **PAGE-LEGIT** | keep |
| 17 | Challenge price read (ADR 0455 Buy CTA feed) | reverse product lookup (`entitlementService.ts:119`, `routes.ts:177`) | **PAGE-LEGIT** | keep |

**Tally: RIDES 9 · ADAPTER 4 · PARALLEL 0 · THEATER 0 · PAGE-LEGIT 4.**

---

## Blockers (from scouting) — with the honest alternative

None that block a chat-first port, because **there is almost nothing to port** —
this is money plumbing and a checkout page, both legitimately non-chat. The
scouting instead falsifies the premise that a money adapter should be
conversational:

- **"Buying a seat is describing intent" → false.** A seat purchase is a
  scarce-resource RESERVE → external PAY → CAS-CONFIRM. The interface test lands
  on *page/projection + a real hold action*, not conversation. Forcing it into
  chat would shadow the commerce checkout owner. Honest alternative: keep the
  page; fix its one broken loop (below).
- **"Payout confirmation is a HITL decision" → partly false.** The *seller
  onboarding* decision correctly IS an approval on the shared queue
  (`sellerRequestService.ts:78`). But **confirming a payout run** is not a
  yes/no gate — it is recording *external payment evidence* (`reference`) after
  the operator paid out-of-band (`routes.ts:308-319`, `shareLedgerService.ts:326`).
  The host never moves money, so an approval card would misrepresent it. Honest
  alternative: keep it as an evidence-stamped operator record; the open runs
  already surface as an Exception-Ledger action-required row
  (`exceptionSources.ts:22-33`).

---

## Demolition list (with regression pins)

**Empty.** No bespoke UI in this unit duplicates a platform primitive. The seat
page is the only bespoke surface and it is PAGE-LEGIT (there is no cohort
marketplace primitive to ride; the confirm step deliberately renders no button —
`SeatPurchasePage.tsx:115-119`). Nothing to demolish; add no resurrection pins.

---

## New-code inventory (should be SMALL)

The only change this review calls for is a **honesty-loop fix**, not a port:

1. **Wire the Pay step to a real checkout link.** `SeatPurchasePage.tsx:141-144`
   renders `payPanelBody`/`nextStep` ("Continue to checkout to confirm it",
   `i18n/en.ts:19/25`) but **no href/CTA to the org checkout**. The buyer holds
   a seat and then dead-ends — the exact ADR 0455 defect ("dead-ends at the
   enroll wall") that the challenge Detail page already fixed. The
   `seatAvailability` surface carries no `orgId`/checkout URL today
   (`seatService.ts:77-90`), whereas `productForChallenge` does
   (`entitlementService.ts:112-128`). Fix = extend `SeatAvailability` with the
   product's `orgId` (thin read; the seat link already knows the product), and
   render an `<a>`/button to `/public-store/:orgId/checkout` gated on
   `heldByYou && seatsLeft`-context. ~1 surface field + ~1 read + ~1 CTA + i18n
   ×4 locales.
   - Pin: a test asserting the held state renders a checkout link (so the
     dead-end can't regress), across the 4-locale parity gate.

Everything else is already the right size: three read nodes, thin observers, and
projections over host owners.

---

## Phased plan (gated on real gates)

**Phase 1 — close the seat-page honesty loop (the only port work).**
- Add `orgId` (and optional `productActive`) to `SeatAvailability`
  (`seatService.ts:77`) + its FE type (`kicktodoSeatClient.ts`).
- Render a checkout CTA in the Pay panel gated on `heldByYou`
  (`SeatPurchasePage.tsx:141`); keep the "confirm is words" honesty.
- i18n ×4 (`kicktodo-seats/i18n/*`).
- Gate: `( cd frontend/react && npm run build )` (tsc + token/CSS + 4-locale
  parity) + the new render test; close with `/code-review` + `/ux-review`,
  apply fixes.

No Phase 2 demolition — nothing to demolish. No compliance-seam phase — erasure,
retention posture, exception feed, and lifecycle keys already ship
(`compliance.ts`, `exceptionSources.ts`, deterministic keys throughout).

---

## Deferred honestly (watch-items + one design opportunity)

- **CAS-byte-match trap (ADR 0447) — already mitigated, keep watching.** The
  boot `normalizeShareLedgerRows()` rewrites legacy-shaped rows canonical so
  `compareAndSwap` always byte-matches into a payout run
  (`shareLedgerService.ts:149-176`, `feature.ts:51`). Collections are empty in
  every deployment today; the trap re-arms only if a new writer bypasses the
  canonical shape. Not a port; a data-integrity tripwire.
- **`kicktodo-entitlements` namespace collision** with `host/entitlementSeam` —
  documented, DECLINED, cosmetic (`entitlementService.ts:60-68`). Left as-is
  honestly; noted so a future reader doesn't "fix" it into a data migration.
- **Exception-row deep-link (`/admin/kicktodo/commerce`,
  `exceptionSources.ts:31`)** points at the out-of-scope kicktodo-admin page —
  verify that page exists and resolves the run (cross-unit check, not this
  unit's port).
- **Design opportunity, not THEATER — no conversational "monetize" path.**
  Setting a share policy, linking a product to a challenge/cohort, and requesting
  payouts are all form/route today; a creator could plausibly *describe* "sell my
  challenge for \$X and pay authors 20%" to the existing challenge-author agent.
  This is a NET-NEW capability (a commerce tool-set on that agent, sharing the
  publisher predicate), **not** a port of existing UI — filed as an opportunity,
  deliberately not scored as THEATER since nothing today claims to do it.

---

SLUG: g4-kicktodo-commerce-seats
