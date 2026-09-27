# ADR 0696 — creator payouts move money: the transfer surface and who receives it

Status: Proposed (2026-09-15) · resolves ADR 0445 OQ4 · no code before Accepted

## Context

ADR 0445 shipped the money TRUTH of the creator economy — a policy-versioned share
ledger in basis points, CAS payout runs, reversals mirroring accruals, statements —
and then stopped one step short, deliberately and on the record: **the host never
moves money**. A payout run is an operator record whose CONFIRM step attests an
external payment by typing a reference (`routes.ts:289`, `shareLedgerService.ts:20`).
The correction notes name the two reasons:

| note | what it says |
| --- | --- |
| D2 | Connect sellers are PER-TENANT: `sellers` is keyed `tenantId` (`commerce-connect/stores.ts:57`). The approval is per (tenant, author) but the Connect account is the tenant's ONE seller row. **Which account receives a multi-author tenant's per-author payouts is OQ4.** |
| D3 | The Connect payout lane is OBSERVATIONAL — `SellerPayout` rows are recorded from `payout.paid/failed` webhooks; nothing initiates. Host-initiated transfers would require a new Stripe transfer surface and OQ4 resolved first. |

The report card grades P4 at B+ for exactly this: "a payout is a reference someone
types". ADR 0684 makes the question concrete rather than hypothetical: the shared
participant workspace `host-kicktodo` IS a multi-author tenant by construction —
every creator who publishes there publishes into one tenant.

`stripeApi.ts` wraps thirteen Stripe endpoints today. `POST /v1/transfers` is not
among them; the only "transfer" in the tree is the destination-charge
`transfer_data[destination]` on a Connect checkout session (`stripeApi.ts:376`),
which moves money at CHARGE time to the tenant's one account.

## Decision

**1. Per-author Connect accounts, stored beside the tenant seller row — not in it.**

A new collection `commerce-connect:author-seller`, keyed `${tenantId}::${authorSubject}`,
carrying the same `SellerAccount` shape (Stripe account id, onboarding state,
`payoutsEnabled`, region, capabilities, mode). The tenant seller row is untouched: it
still receives destination charges for products the TENANT sells. An author's
account receives TRANSFERS of the author's accrued share.

Why per-author and not "the tenant account receives, the ledger stays per-author":
the ledger is already per-author (ADR 0445 P1), the seller APPROVAL is already per
(tenant, author) (`sellerRequestService.ts`), and the only thing that could make a
tenant-level account honest for a multi-author tenant is a second, off-host ledger
of who is owed what — the exact bookkeeping the on-host ledger was built to make
unnecessary. The KickTodo shared workspace makes every tenant multi-author.

**2. Onboarding reuses the Connect primitives, per author.** `createStripeConnectAccount`
(express) + `createStripeAccountLink`, driven from the creator's own Earnings page
after the existing `connect-seller` approval is granted. The reverse index
`commerce-connect:seller-by-account` gains author rows so `account.updated` and
`payout.*` webhooks resolve either kind by point lookup.

**3. A payout run's CONFIRM may mint the transfer.** `POST …/payout-runs/confirm`
gains `{ mode: 'transfer' }`: for each author entry with an onboarded,
`payoutsEnabled` account, the host calls a new `createStripeTransfer(key, {
amountMinor, currency, destination, idempotencyKey: `${runId}:${authorSubject}`,
metadata })` and records the returned transfer id as that entry's reference. An
author WITHOUT an account leaves their rows accrued and the run partially
confirmed — reported, never silently paid to the wrong party. The manual
`{ reference }` path stays as the fallback for off-Stripe settlements.

**4. Idempotency and failure.** Stripe idempotency keys are per (run, author); a
retry of a partially failed confirm re-sends only the entries still accrued. A
transfer that Stripe accepts but the host fails to record is reconciled by the
existing `transfer.*` / `payout.*` webhook lane, which now matches author accounts.
The ledger flip accrued→paid happens ONLY on a recorded transfer id.

**5. Minimum payout (OQ3).** Operator config `OPENWOP_KICKTODO_MIN_PAYOUT_MINOR`
(default 1000, i.e. $10.00 in minor units): an author whose net accrued is below
it is skipped by the run and carried forward. Recorded here so OQ3 stops being
open.

**6. Region and currency.** v1 transfers only between accounts in the platform's
own region and currency (Stripe's same-region rule for separate charges and
transfers). Cross-region authors are onboarded but their run entries report
`unsupported-region` and stay accrued.

## Alternatives considered

- **Tenant account receives; operator pays authors off-host.** Rejected: recreates
  the bookkeeping the ledger exists to remove, and for `host-kicktodo` it means
  the operator pays every creator by hand forever.
- **Destination charges per author at checkout.** Rejected: a paid challenge is
  one product; a destination charge has one destination. Multi-author tenancy
  needs transfers after the fact, which is what the share ledger already models.
- **Keep confirm-by-reference only.** The status quo. Honest, but it is the B+.

## Consequences

- P4 reaches "money moves" without a second ledger.
- Two new stores (author sellers, index rows) and one new Stripe wrapper.
  No wire change; every route is host-local under `/v1/host/openwop-app/*`.
- Partial-refund clawback (ADR 0445 note "partial refunds do not claw back") is
  a separate follow-on and is NOT gated on this ADR.

## Open questions

1. Whether the per-author account should be reusable across tenants for the same
   human (one Stripe account, many tenants). v1 says no: keyed per tenant.
2. Payout schedule: Stripe's default for the author account vs an operator-set
   cadence. v1 leaves Stripe's default.

## Implementation phases (after Accepted)

| phase | content |
| --- | --- |
| 1 | author seller store + index; onboarding start/sync per author; Earnings page CTA |
| 2 | `createStripeTransfer` wrapper; confirm `{ mode: 'transfer' }`; partial-confirm reporting; minimum payout |
| 3 | webhook matching for author accounts; reconciliation on `transfer.*`; admin exception rows for unresolved entries |
