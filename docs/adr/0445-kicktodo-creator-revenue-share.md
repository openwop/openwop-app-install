# ADR 0445 — KickTodo creator revenue share & payouts (authors get paid)

| | |
|---|---|
| **Status** | Implemented — 2026-07-20 |
| **Feature** | EXTENDS `kicktodo-commerce`; COMPOSES the platform Commerce-Connect lane (ADR 0176/0385 — the ONE money owner). **No new toggle, no new package, no second Stripe surface.** |
| **Source** | `docs/kicktodo-original-intent-coverage.md` §5 gap **3** — the business plan's core commercial promise: *"Challenge authors receive a percentage of every transaction associated with their challenge."* The single largest unhonored original intent. |
| **RFC verdict** | **Host work, no RFC.** Money flows ride existing platform commerce; routes are host-ext. Nothing on the OpenWOP wire. |
| **Composes** | ADR 0420 (challenge↔product links + entitlements — the fulfilment truth), ADR 0176/0385 (Stripe billing + Connect: seller onboarding, `payoutsEnabled`, payouts, webhook routing order), ADR 0426 (creator profiles — the author identity), ADR 0437 UX-2.7 (Creator insights — where earnings render), ADR 0438 A5 (admin reconciliation) |

## 1. Why this exists

Entitlements, seat products, and creator reach (entitlement counts) all exist —
but **no mechanism pays the author**. The revenue-share promise is what makes the
Challenge Factory an *economy* rather than a catalog. This ADR routes it through
the platform's existing money machinery instead of inventing any.

## 2. Boundaries audit (verified 2026-07-20)

- **Commerce-Connect already owns sellers + payouts** — `commerce-connect`
  carries `onboarding/onboardingState`, `payoutsEnabled`, `payouts`. KickTodo
  authors become **Connect sellers via that lane**, never a parallel one.
- **CLAUDE.md Stripe invariants are law here:** ONE Stripe client
  (`features/billing/stripeApi.ts`); ONE webhook URL with the existing routing
  order (Connect events FIRST — a kicktodo handler must never intercept before
  `connectEventHook`); **money-truth = the order-row CAS `pending→paid`**, never
  an API response; amounts verified before flips; **fees minor-units-first**;
  **seller lanes approval-gated** (multi-tenant phishing/squat vector) and
  **`anon:` tenants can never onboard** (GEN-CC-1).
- **The revenue linkage already exists** — `linkChallengeProduct`
  (`kicktodo-commerce/entitlementService.ts`) binds `{productId → challengeId,
  version, createdBy}`; `reprocessOrder`/`revenueProjectionFor` already walk
  orders→links. The share ledger derives from THESE rows; no second sales record.
- **Author identity** = the link's `createdBy` (opaque subject) + the ADR 0426
  creator profile (approval-gated public identity). No new identity model.

## 3. Decision

**The author-share is a derived ledger over existing money truth, paid out
through Connect:**

- **D1 — Share policy (versioned, deterministic).** A tenant-level
  `authorSharePolicy` (percentage in basis points, versioned like ADR 0415's
  rights policy). Each PAID order event that fulfils a challenge entitlement
  derives a **share-ledger row**: `${tenant}::${orderId}::${challengeId}` →
  `{ authorSubject, grossMinor, shareBps, shareMinor, policyVersion, state }`.
  Deterministic key = idempotent under webhook replay/reprocess (the
  `reprocessOrder` discipline). Refund/dispute events write **negative** ledger
  rows (money-truth rule: they apply even when toggles are OFF).
- **D2 — Author onboarding.** An author with entitleable products may request
  seller onboarding → the EXISTING Connect onboarding lane, **operator-approved**
  (ADR 0438 Safety inbox gets a `connect-seller` approval kind on the shared
  queue), `anon:` refused at the door. Until onboarded+`payoutsEnabled`, shares
  **accrue** in the ledger (visible, unpaid) — honest, never fabricated as paid.
- **D3 — Payout runs.** A periodic/manual operator action aggregates `accrued`
  ledger rows per author → ONE Connect payout via the existing payout lane →
  rows CAS `accrued→paid(payoutId)`. Partial-failure fails closed (rows only
  flip on payout confirmation); reconciliation is an ADR 0438 A5 extension
  (stranded `accrued` with `payoutsEnabled` = an incident row).
- **D4 — Surfaces.** Creator insights (UX-2.7) gains an **Earnings** section:
  accrued/paid in REAL currency minor units (this ADR is what finally licenses
  dollars there — until it ships, the units-not-dollars honesty stays). Admin A5
  gains the payout-run + share-policy read. All figures derive from the ledger;
  nothing hand-entered.

## 4. Feature-evaluation matrix (deltas only)

| Dim | Decision |
|---|---|
| Package/toggle | Extends `kicktodo-commerce` (toggle stable); payout actions additionally gated by the commerce-connect feature being live |
| Workflow surface | None new in v1 (money actions stay REST + operator-gated; no agent-triggerable payouts) |
| Node pack | **None** — deliberately: no workflow node may move money (matches the governed vendor-write posture) |
| Agent | None (insights read-only via existing tools) |
| Public | None |
| RBAC | Ledger reads: author sees OWN rows; operator (`requireKicktodoManage`) sees tenant ledger; onboarding request = author; approval = operator via shared queue; payout run = operator; all fail-closed |
| Replay | Ledger keys deterministic on (order, challenge); policy versioned + stamped per row; webhook idempotency inherited from the CAS money-truth |
| Frontend | Earnings section on CreatorInsightsPage + A5 payout panel; 4-locale; minor-units formatting via the platform money helpers |

## 5. Phased plan

| Phase | Ships | Gate |
|---|---|---|
| P1 | Share policy + derived ledger (accrual on paid/refund events, deterministic keys, tests incl. replay/refund negatives) | /architect on the webhook-derivation seam (MUST NOT touch routing order) |
| P2 | Author seller-onboarding request + `connect-seller` approval kind + accrued-visible Earnings (honest "unpaid until onboarded") | P1 |
| P3 | Operator payout runs + CAS `accrued→paid` + A5 reconciliation extension | P2; Connect live in the deployment |
| P4 | Statements (per-author CSV export via the existing audit-export pattern) | P3 |

## 6. Alternatives, corrections, open questions

- **Alternative (rejected): Stripe destination charges / application fees at
  purchase time.** Splitting at charge time couples every challenge sale to the
  seller's Connect readiness and forks the existing order flow; the derived
  ledger + periodic payout keeps ONE money path and lets shares accrue before
  onboarding. Revisit only if volume makes payout batching a compliance issue.
- **Correction to the original:** the business plan's "percentage of every
  transaction" is honored as a **policy-versioned share on the paid order net of
  refunds** — disputes/refunds claw back via negative rows (the original never
  considered refunds).
- **OQ1:** share policy scope — one tenant-wide bps, or per-challenge override
  (author-negotiated)? Start tenant-wide (simplest honest policy); the row
  stamps `policyVersion` so per-challenge can layer without migration.
- **OQ2:** tax/1099 reporting is OUT of scope for the host (Connect's problem
  surface); recorded as a non-goal so no one assumes we file anything.
- **OQ3:** minimum-payout threshold (avoid micro-payouts) — operator-config,
  decide at P3.

## 7. Implementation record (2026-07-20)

| Phase | Shipped | PR |
|---|---|---|
| P1 share ledger | `shareLedgerService`: versioned bps policy; accrual/reversal derived on the ADR 0420 paid/refund OBSERVERS (downstream of the order CAS — webhook routing untouched by construction); deterministic keys, first-write-wins; reversal MIRRORS the accrual negated; minor-units-first + floor discount allocation; `reconcileShares` on the KTFULL-B13 entry; ARCH-H1 test flake fix | #2252 |
| P2 seller onboarding | `connect-seller` approval kind (shared queue; Safety-inbox filter pinned) + `sellerRequestService` (anon: refused — GEN-CC-1 mirror; needs ≥1 own link; idempotent; rejected ⇒ re-requestable) + honest Earnings on CreatorInsightsPage | #2254 |
| P3 payout runs | Operator RECORDS with fail-closed CAS: create claims accrued rows (double-run safe, net>0 authors only), confirm(reference) flips accrued→paid, cancel releases; actions gated manage + commerce-connect live; A5 admin panel + share-policy set | #2255 |
| P4 statements | `/my-earnings.csv` (self-scoped, no author column) + `/share-ledger.csv` (manage) via the ADR 0297 D2 export idiom; minor-unit amounts | #2256 |

**Correction notes** (implementation overturned two D-section assumptions):
- **D2**: Connect sellers are PER-TENANT ("a per-tenant commercial actor"),
  so the approval is per (tenant, author) and the Connect account stays the
  tenant's ONE seller row — no per-author Connect accounts. Which account
  receives a multi-author tenant's per-author payouts is OQ4 (open).
- **D3**: the existing Connect payout lane is OBSERVATIONAL (`SellerPayout`
  rows recorded from `payout.paid/failed` webhooks); the host never
  initiates payouts/transfers. P3 therefore ships payout runs as durable
  operator records whose CONFIRM step attests the external payment evidence
  — the host moves no money. Host-initiated transfers would require a new
  Stripe transfer surface and OQ4 resolved first.
- Retroactive accrual: a policy set AFTER sales accrues history only via
  the explicit operator `reconcileShares` run — deliberate, test-pinned.
- Partial refunds do not claw back in P1 (full-refund observer only —
  the same honest exclusion entitlements make).
