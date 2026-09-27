# ADR 0447 — One money-obligation ledger: extract the share-ledger machine to a host seam; migrate affiliate commissions onto it

| | |
|---|---|
| **Status** | Implemented — 2026-07-20 (0447 P3 deferred, release-gated) |
| **Feature** | Architecture extraction (the ADR 0446 program's method, applied to money). **No new feature package, no new toggle, no new wire.** Consumers: `kicktodo-commerce` (author shares, ADR 0445) and `commerce` (affiliate commissions, ADR 0177 P5 / 0297 D2). |
| **Source** | The KickTodo core-value evaluation (this session): the app has **two live systems for "we owe a third party a cut of a paid order"** — the worst kind of duplication, because money code drifts. |
| **RFC verdict** | **Host work, no RFC.** A host-internal store refactor; nothing on the OpenWOP wire, no capability advert, no endpoint contract change. |
| **Composes** | ADR 0445 (share ledger + payout runs — the machine being extracted), ADR 0177/0297 (affiliates — the lane being migrated), ADR 0446 (the promotion bar this passes), CLAUDE.md Stripe invariants (minor-units-first; no host money movement) |

## 1. Why this exists

`commerce/affiliate.ts` and `kicktodo-commerce/shareLedgerService.ts` model the same
concept at two maturity levels:

| | Affiliates (`commerce/affiliate.ts`) | Author shares (`kicktodo-commerce/shareLedgerService.ts`) |
|---|---|---|
| Accrual record | a running `balanceOwed` number mutated in place (`:81`) | one row per paid order line, deterministic key, first-write-wins |
| Refund clawback | **none** — a refunded order's commission is never reversed | reversal rows that MIRROR the accrual under its original policy version |
| Policy | rate frozen per affiliate row, unversioned | versioned tenant policy, stamped per row |
| Payout | `recordPayout` zeroes the balance via CAS (`:106`), mints a `pending` payout with **no evidence field** | CAS-claimed payout runs; rows flip `accrued→paid` only on attested external evidence |
| Units | **major** units + `round2` float arithmetic (`:23`) | minor units, integer arithmetic (the CLAUDE.md law) |
| Audit | balance tells you the total, never *which orders* | every cent traceable to an order line + policy version; CSV statements |

Every affiliate weakness is a defect class the share ledger already solved (several
were found and fixed by adversarial review the day it shipped). Left as two systems,
the affiliate lane re-earns those bugs one incident at a time, and any third
obligation lane (Connect seller fees, referral bounties, ADR 0445 OQ4's future
transfer phase) would mint a third copy.

**ADR 0446 bar check:** this is not a speculative "looks general" promotion — the
duplication is live today, both consumers exist, and the mechanism (a state machine
over rows + runs) is infrastructure, not either owner's domain. This is precisely the
`[1]` shape 0446's per-edge review kept finding *false* instances of; this one is real
because there are two concrete implementations to diff.

## 2. Boundaries audit (verified 2026-07-20)

- **The machine to extract** lives in `kicktodo-commerce/shareLedgerService.ts`:
  accrual/reversal rows (`kicktodo-share-ledger`), versioned policy
  (`kicktodo-share-policy`), payout runs with CAS-claimed transitions
  (`kicktodo-payout-runs`), `summarizeShares`, `reconcileShares` — plus the CSV
  serializer in `kicktodo-commerce/routes.ts` (`sharesCsv`).
- **The lane to migrate**: `commerce/affiliate.ts` (`accrueCommission` called from
  `commerceService.ts:1095` on the pending→paid transition; `recordPayout`;
  `payoutExportRows` → the ADR 0297 D2 CSV at `commerce/routes.ts:588`).
- **Import direction is clean**: a `host/` seam imports nothing from features
  (`hostExtPersistence`, `observability` only). Unit conversion
  (`toStripeMinorUnits`) lives in `billing/stripeApi.ts` — a feature — so
  **conversion stays in the adapters**: the core machine stores integer minor units +
  a currency string and never converts.
- **No namespace/route collision**: no routes move; each consumer keeps its existing
  paths. No second owner is created — the machine moves, the *domain* stays with each
  feature (what accrues, at what rate, to whom).
- **What is NOT extracted**: derivation (which order lines create obligations) — that
  is domain logic and stays in each feature; the ADR 0445 D3 posture (the host never
  moves money; confirm attests external evidence) is inherited by the seam as law.

## 3. Decision

**Extract the state machine, not the domain.** New host seam
`backend/typescript/src/host/obligationLedger.ts`:

```ts
createObligationLedger(config: {
  ns: string;                    // collection names — verbatim, so existing rows keep their keys
  runsNs: string;
}): ObligationLedger
```

An `ObligationLedger` owns exactly what both lanes need and nothing domain-shaped:

- **Rows**: `{ tenantId, sourceId, lineId, kind: 'accrual'|'reversal', payeeSubject,
  currency, amountMinor, basisMinor, rateStamp, policyVersion, state: 'accrued'|'paid',
  payoutId?, sourceCreatedAt, createdAt }` — key
  `${tenant}::${sourceId}::${lineId}[::reversal]`. `accrue()` is first-write-wins;
  `reverse()` mirrors the accrual negated (never recomputed). Integer minor units only.
- **Payout runs**: `create` (CAS-claims unclaimed accrued rows of net-positive payees;
  post-claim net≤0 release), `confirm(reference)` (CAS-claimed transition, re-entrant
  row flips), `cancel` (CAS-claimed, releases) — the ADR 0445 P3 machine verbatim,
  including its grade-sweep fixes.
- **Reads**: per-payee list (self-scope filtering is the caller's), tenant list,
  per-currency summary, and the CSV serializer (with the formula-prefix
  neutralization).

**Consumers become adapters:**

- **D1 — kicktodo adapter (behavior-preserving).** `shareLedgerService` keeps its
  exports and its policy store, delegating rows/runs to
  `createObligationLedger({ ns: 'kicktodo-share-ledger', runsNs: 'kicktodo-payout-runs' })`
  with field mapping `sourceId=orderId, lineId=productId, payeeSubject=authorSubject,
  basisMinor=grossMinor, rateStamp=shareBps`. **Zero data migration** — collection
  names and key shapes are unchanged; the existing 12-test file must pass unmodified
  (that is the extraction's acceptance gate).
- **D2 — affiliate adapter (the payoff).** `accrueCommission` derives a ledger row per
  paid order (`ns: 'commerce:affiliate-ledger'`, `sourceId=orderId,
  lineId=affiliateCode, payeeSubject=aff:<id>`), converting to minor units in the
  adapter; the refund observer gains an affiliate reversal (the clawback affiliates
  never had). `recordPayout` becomes create-run + confirm-run with
  `reference: 'advisory:<operator>'` (the lane stays advisory — no money movement,
  same as today). `payoutExportRows` and the D2 CSV read from the ledger.
- **D3 — migration (repair before constrain).** One-shot boot backfill per tenant:
  a non-zero `balanceOwed` becomes ONE opening-balance accrual row
  (`sourceId: 'opening-balance'`, `policyVersion: 0`) and `balanceOwed` is retired
  from the write path (kept on the row, frozen, for one release as a cross-check);
  historical `commerce:payout` rows stay as read-only history. Backfill is
  idempotent by deterministic row key, NOT by a one-shot sentinel (the fold lesson).

## 4. Feature-evaluation matrix (deltas only)

| Dim | Decision |
|---|---|
| Package/toggle | None new. Money effects remain UNCONDITIONAL in both lanes (the money-truth rule); toggles keep gating only read/manage surfaces, exactly as today |
| Workflow surface / node pack / agent pack | **None** — no workflow node may move money (ADR 0445 law, inherited by the seam) |
| Public surface | None; no route moves |
| RBAC | Unchanged per consumer (affiliates: `workspace:read/write`; kicktodo: manage vs self-scoped) |
| Replay | N/A (no run-event shape); ledger keys deterministic on source ids |
| Frontend | No change in P1/P2; the affiliate payout CSV gains reversal rows (additive columns) |

## 5. Phased plan

| Phase | Ships | Gate |
|---|---|---|
| P1 | `host/obligationLedger.ts` + the kicktodo adapter; `kicktodo-share-ledger.test.ts` passes UNMODIFIED; a new ledger-unit test file owns the machine's invariants | /architect on the seam API before code |
| P2 | Affiliate adapter: per-order accrual rows + refund clawback + payout runs; opening-balance backfill; D2 CSV from the ledger | P1; affiliate tests extended (clawback, backfill idempotency, concurrent accrual-vs-payout — the M5a/M5b scenarios re-pinned on the new machine) |
| P3 | Retire `balanceOwed` from reads (export computes from the ledger); delete the frozen field the release after | P2 green in prod for one release |

## 6. Alternatives, corrections, open questions

- **Alternative (rejected): migrate shares onto the affiliate balance model.** Loses
  row-level audit, refund clawback, policy versioning, and evidence-gated payouts —
  adopting the weaker of the two.
- **Alternative (rejected): leave both, document the divergence.** Money code drift
  is the failure mode this ADR exists to close; a third obligation lane is already
  foreseeable (0445 OQ4's transfer phase).
- **Correction to the plan as evaluated:** unit conversion does NOT move to `host/`
  (would invert the core→feature import rule); adapters convert, the machine is
  integer-minor-units only.
- **OQ1:** does the affiliate lane adopt *versioned* rates (policy rows) in P2, or
  keep per-affiliate frozen rates and stamp `rateStamp` per row? Start with the
  latter (behavior-preserving); versioning can layer without migration because rows
  stamp their rate.
- **OQ2:** partial refunds — both lanes currently claw back on FULL refund only (the
  observer's contract). Unchanged here; recorded so nobody reads the unification as
  fixing it.
- **OQ3 (= ADR 0445 OQ4):** payout destination for real disbursement — untouched;
  rides the adapters, not the machine.

## 7. Implementation record (2026-07-20)

| Phase | Shipped | PR |
|---|---|---|
| P1 | `host/obligationLedger.ts` (machine verbatim incl. grade-sweep fixes; integer-minor-units ENFORCED; payee-scoped runs added for P2) + kicktodo adapter — acceptance gate met: `kicktodo-share-ledger.test.ts` passed UNMODIFIED (zero diff) | #2265 |
| P2 | Affiliate adapter: per-order rows, refund clawback at both refund sites, payee-scoped payout runs, opening-balance backfill (idempotent by key, boot-wired), projected `balanceOwed` reads, legacy Payout compat row | #2267 |
| P3 | **Deferred (release-gated by design)**: retire the frozen `balanceOwed` field after P2 soaks one release in prod | — |

**Correction notes:**
- **Row storage**: canonical shape chosen over codec machinery — safe because the
  kicktodo collections were EMPTY in every deployment (no share policy ever set ⇒
  zero rows); made non-load-bearing by an `upgradeRow` read-tolerance hook (typed
  field guards, fail-closed).
- **Contract discovery at the P2 gate**: existing tests/FE pin `balanceOwed` on
  affiliate reads and `Payout.status 'pending'` — so `balanceOwed` became a
  read-time PROJECTION of the ledger net and the legacy payout row remains the
  compat surface while the confirmed run is the truth (both recorded in
  `affiliate.ts`'s header).
- The M5a/M5b race classes are now impossible by construction (rows, not
  increments; CAS-claimed payee-scoped runs) — re-pinned with the original
  deterministic proxies.
