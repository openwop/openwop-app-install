# ADR 0239 — Commerce scale & search honesty: per-currency reporting, a reservation due-index, and relevance search

Status: implemented (Phase 2 of the ecommerce-deferral plan)

Relates to: ADR 0177 (commerce package), ADR 0224 (transaction graph), ADR 0225
(surfaces + loops), ADR 0238 (money-completeness), ADR 0029 (secondary-index scans),
RFC 0018 (`host.db.search`). No OpenWOP wire change; no schema migration.

## Context

Three recorded deferrals, all "scale / honesty" shaped:

- **DEF-6 — per-currency reporting.** `commerceSummary` used a last-seen `currency` and
  summed `gmv`/`refunded`/`aov` across **all** orders regardless of currency — a
  mixed-currency org got a meaningless total labelled with the last order's currency.
- **DEF-5 — reservation sweep scan.** `sweepExpiredReservations` did `orders.list()` — a
  full, unbounded, cross-tenant scan of **every order ever placed** — each 60s tick, to
  find the (few) pending reservations actually due to expire.
- **DEF-3 — product search.** `listProducts` did a naive per-field substring `includes`
  over the tenant-indexed product slice. The recorded plan was "move to `host.db.search`".

## Decision

### DEF-6 — bucket every money aggregate per currency

`commerceSummary` now accumulates `gmv`, `netRevenue`, `aov`, refunds, and coupon usage
**per currency** into `byCurrency: CurrencyFigures[]` (GMV-desc). The flat headline
(`gmv`/`netRevenue`/`currency`/`aov`) mirrors the **primary** (highest-GMV) currency, so
existing single-currency callers/cards are unchanged; the empty-store default keeps the
historical `USD`/zeros. Order counts and `topProducts` **units** are counts, not money, so
they stay global. The Reports tab renders one figure band per currency (labelled with a
currency chip when there's more than one). Additive to the FE `CommerceSummary` type.

### DEF-5 — an outstanding-reservations due-index

A new `commerce:reservation-due` collection holds **one small row per LIVE pending
reservation** (`{orderId, tenantId, orgId, dueAt}`), written at `createOrder` and deleted
when the order leaves `pending` (pay / cancel / expire). The sweep scans **that** (bounded
to outstanding reservations) instead of the full order history, releasing due rows
oldest-first under the existing batch cap. **Divergence handling:** if the sweep finds a
row whose order already moved on (a raced pay/cancel — `cancelOrder`'s CAS no-ops), it
prunes the stale row. Best-effort: a missing index row never oversells (the reservation
lives on the order's own `reservationExpiresAt`; the index is only the sweep's work-list).

### DEF-3 — relevance search in-memory, NOT a parallel search index

**Key finding:** the default durable `host.db.search` `query()` (`durable/durableData.ts`)
is itself an O(n) `listParsed` + in-memory tokenize/score — it gives **no scale win** over
the existing in-memory product filter; the win materializes only with the **OpenSearch**
backend, which this host doesn't run. And an eagerly/lazily-synced product index would be a
**parallel read model** — the exact anti-pattern the "build on existing, don't stand up
parallel surfaces" rule warns against. Products are also `assertCap`-bounded per org.

So DEF-3 is delivered as a **relevance upgrade to the existing in-memory `listProducts`**:
multi-token **AND** (every query token must appear somewhere searchable) with a
field-weighted score (name > tag > description) plus phrase/prefix bonuses, so "red shirt"
finds a product named "Shirt" tagged "red" and ranks "Red Shirt" first. No parallel index,
no write-path coupling. Any feature that genuinely needs engine-scale search already has
the sanctioned `host.db.search` seam available once OpenSearch is configured — that is a
deployment choice, not new per-feature infra.

## Alternatives weighed

- *Convert stored money to a base currency for one total* — rejected: no FX source, and
  it would hide the per-currency truth. Bucketing is honest and additive.
- *A time-bucketed due-index key for range scans* — rejected as over-engineering at this
  scale: `dueAt`-range isn't a key prefix, and the outstanding-reservations set is already
  small (TTL-bounded), so a bounded list + filter is the lean correct choice.
- *Stand up a `host.db.search` product index (conversation-search style)* — rejected for
  DEF-3 on the evidence above (equivalent O(n) on the durable backend; a parallel read
  model). Recorded here rather than silently built.

## Wire honesty (no RFC needed)

Host-side only: an additive-optional response field (`byCurrency`), a new internal
`DurableCollection` (no migration — existing orders simply have no due-row until re-created;
the sweep tolerates that), and an in-memory search change. No run-event, capability, or
endpoint-contract change.

## Implementation

| Piece | Files |
|---|---|
| Per-currency `CommerceSummary` + `CurrencyFigures` | `features/commerce/commerceService.ts` |
| `commerce:reservation-due` index; write at create; clear at pay/cancel; sweep off the index + divergence prune | `features/commerce/commerceService.ts` |
| Relevance search (multi-token AND + ranking) | `features/commerce/commerceService.ts` (`listProducts`) |
| FE: per-currency figure bands; `CurrencyFigures` type | `frontend/react/src/features/commerce/{CommercePage,commerceClient}.tsx` |
| Tests | `test/commerce-phase2-deferrals.test.ts` (4) |

## Open questions / follow-ons

- ~~`topProducts` revenue is still nominal across currencies (a product sold in USD + EUR
  sums raw numbers); a per-currency product breakdown is a future refinement.~~
  **CORRECTION (follow-on, 2026-07-04):** shipped. `commerceSummary` now buckets top-product
  revenue **per currency** (`CurrencyFigures.topProducts`); the flat `topProducts` mirrors
  the primary currency's list. The Reports tab renders a per-currency top-product list with
  its own symbol (replacing the units-only-when-multi-currency stopgap). Additive, no wire,
  no migration. Tests: `commerce-followon-a.test.ts`.
- Engine-scale product search (OpenSearch-backed `host.db.search`) remains available as a
  deployment choice; no per-feature index is maintained.
- The **flat** `couponUsage` (and the FE coupon list) now reflects only the **primary**
  currency's coupons; per-currency coupon usage is available in `byCurrency[].couponUsage`.
  A multi-currency store's coupon list is primary-currency-only until the FE renders the
  per-currency slices — acceptable at the single-currency common case.
- **Top-product revenue** is currency-agnostic when the store sells in more than one
  currency: the Reports tab shows **units only** in that case (a single currency symbol
  would misstate a cross-currency revenue sum). Single-currency stores show revenue as before.
