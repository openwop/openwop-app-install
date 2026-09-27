# ADR 0752 — RFC 0215 on this host: per-subscription delivery lanes, and unregister that no enqueue can outrun

Status: Accepted

Implements the host half of **RFC 0215** (webhook delivery isolation +
unregister-stops-delivery, going into `spec/v2/core/webhooks.md` §Durability,
binding on hosts that advertise `webhooks`). Requested by the openwop spec steward
session on 2026-09-25. This is host work on an RFC whose wire shape is fixed by the
spec. **No wire change**: no event, field, header or endpoint moves.

Builds on WHD-1 (#4052, the claimed batch made concurrent), WHD-34 (the DB-pool
bound), and WHD-16 (#4083 lineage, `deleteWebhook` drops pending rows).

## The rules

- **§A.1 MUST NOT** — the start of an attempt to one subscription must not wait for
  an attempt to a DIFFERENT subscription to finish (answered, failed or timed out).
- **§A.2 MUST** — sustain §A.1 while at least **8** subscriptions have attempts
  their receivers have not answered.
- **§A.3 SHOULD** — one tenant's unanswered attempts should not occupy capacity
  another tenant needs.
- **§B MUST** — after `unregisterWebhook` answers 204, start no further attempt for
  that subscription, scheduled retries included. An attempt in flight at the 204
  MAY complete. No dead-lettering at unregister.

## What was measured on `origin/main` (bc0f13f1c), before this ADR

**§A failed, for three reasons, not one.** The steward's estimate was
"`CLAIM_BATCH = 5`, so 8 held + 1 starves the ninth". It was worse than that:

1. **A barrier between batches.** WHD-1 made the rows *inside* a claimed batch
   concurrent, but `processDueWebhookDeliveries` still awaited the whole batch, and
   the tick awaited it behind a `running` guard. The next claim could not start
   until the slowest row answered or hit `DELIVERY_TIMEOUT_MS`.
2. **The batch ran 3 wide in production, not 5.** WHD-34 bounded the whole attempt
   at `min(CLAIM_BATCH, OPENWOP_PG_POOL_MAX − 1)`, and production runs pool 4.
   That bound exists to protect the DB pool, but the HTTP attempt holds no
   connection. Only the write after it does.
3. **No per-subscription bound.** Even with more capacity, one subscription's
   backlog could fill every slot with its own rows. That is a §A.1 violation of its
   own: the other subscriptions' attempts wait on it.

**§B was met except for one race.** WHD-16 deletes a subscription's `pending` rows
with it, atomically. A claimed, in-flight row is still `pending`, so it goes too,
and its later `rescheduleWebhookDelivery` UPDATE matches no row. No retry starts.
The gap was the fan-out: `deliverToSubscribers` reads `listWebhooks` and then
enqueues. An event racing the unregister could insert a fresh row after the 204,
and the worker would attempt it.

## Decision

### D1 — lanes: a non-blocking dispatcher, one attempt per subscription

`createWebhookDispatcher` replaces the tick's drain loop (Svix-style: per-endpoint
work that shares only a capacity bound).

- A **claim takes up to the free capacity**, launches each attempt, and returns.
  Nothing awaits an attempt: not the claim, not the tick. The `running` guard now
  only keeps the piggybacked sweeps from overlapping.
- **One attempt per subscription per instance.** The claim takes each
  subscription's oldest due row (`onePerSubscription`) and skips subscriptions
  already in flight here (`excludeSubscriptionIds`). A hung receiver, or a deep
  backlog, holds exactly one slot.
- **Capacity** is `webhookMaxInFlight()`: default 32, tunable via
  `OPENWOP_WEBHOOK_MAX_IN_FLIGHT`, and **floored at 9** (§A.2: 8 held + 1). A lower
  configured value is raised, never honoured.
- **An attempt finishing re-pumps immediately**, so a busy healthy subscription is
  not throttled to one attempt per poll interval by its own lane.
- **The WHD-34 guarantee is kept, and narrowed to what it protects.**
  `deliveryConcurrency()` now gates only the post-attempt DB write, still at
  `pool − 1`.

`processDueWebhookDeliveries` stays as the deterministic, awaiting test lane.
Its claim is unchanged (no lane options), so every existing queue test keeps its
semantics.

**Storage.** `claimDueWebhookDeliveries(…, opts?: WebhookClaimOptions)`:
- **Postgres** narrows candidates with an unlocked `DISTINCT ON (subscription_id)`
  subquery (`DISTINCT ON` cannot carry `FOR UPDATE`), then locks with
  `FOR UPDATE SKIP LOCKED` in a layer that re-states the due predicate.
- **SQLite** does an oldest-first scan inside the existing claim transaction.

### D2 — §B: the enqueue re-checks the subscription, atomically with the delete

`enqueueWebhookDelivery(record, { requireSubscription: true })` inserts only while
the subscription exists, and returns whether it inserted. The fan-out (all three
call sites take their subscription from `getWebhook`/`listWebhooks`) passes it.
Callers that enqueue for a subscription they never persisted (tests, suppression
lanes) omit it and are unaffected.

- **Postgres.** The single-statement delete could not be made safe: its snapshot is
  taken at statement start, so an INSERT committing mid-statement survived it.
  `deleteWebhook` now runs a transaction:
  1. lock the subscription row `FOR UPDATE`;
  2. delete pending deliveries in a later statement, with a fresh READ COMMITTED
     snapshot;
  3. delete the subscription.

  The conditional INSERT holds `FOR SHARE` on the same row. Two outcomes:
  - The enqueue took `FOR SHARE` first: the delete waits for it to commit, then
    removes the row.
  - The delete locked first: the enqueue sees no subscription and inserts nothing.
- **SQLite.** better-sqlite3 serializes writes, so an `INSERT … SELECT … WHERE
  EXISTS` cannot interleave with the delete transaction.

## Alternatives weighed

- **Raise `CLAIM_BATCH` to 9+.** Rejected: it does not remove the barrier (reason 1),
  so the tenth held subscription starves the eleventh, and it widens the WHD-34
  pool exposure. It is the number, not the shape.
- **Claim-time `EXISTS (subscription)` instead of an enqueue-time one.** Rejected:
  many tests and suppression lanes enqueue rows for subscriptions that are never
  persisted, and it would add a join to every claim. The enqueue is the one
  place the race exists.
- **Per-tenant capacity cap for §A.3.** Deferred. Delivery rows do not carry a tenant
  (`WebhookDeliveryRecord` has no `tenantId`), so it needs a column migration. §A.3
  is a SHOULD. Lanes already bound each subscription to one slot, so a tenant
  occupies at most one slot per subscription it owns.

## Verification

| Claim | Witness | Sabotage that turns it red |
|---|---|---|
| §A.2 — 8 held + 1 healthy (dispatcher at the floor of 9, pool 4) | `test/rfc0215-webhook-delivery-isolation.test.ts` | capacity = 3 (old bound); batch barrier restored |
| §A.1 through the running poll worker | same file | capacity = 3; barrier restored |
| a backlog holds one lane | same file | lanes off (`onePerSubscription: false`, no exclusion); barrier restored |
| §B — retry scheduled before delete never fires | same file | (WHD-16 delete) |
| §B — in-flight at delete completes, no retry row | same file | (WHD-16 delete) |
| §B — enqueue after delete inserts nothing | same file | enqueue ignores `requireSubscription` |

"Held" means **both ends** are still open. The witness records a held request whose
connection the host closed (its timeout fired) as abandoned. The first draft counted
only the receiver side, and the barrier sabotage **passed it**: the host had given up
on the held attempts and moved on, which is exactly the scenario's fail condition.

The Postgres SQL (lane claim, exclusion, conditional insert, the locked delete
transaction) was executed against **real Postgres 17** (PGlite/WASM behind the
adapter's `pg.Pool`), sabotage-checked. pg-mem cannot run it (`SKIP LOCKED`). What
that run cannot show is the **two-connection** lock interplay in D2, since PGlite is
single-connection. That half rests on the reasoning above, and on the live
conformance scenario `v2-webhook-unregister-stops-delivery` once the suite publishes
it.

## Open

- [ ] `v2-webhook-delivery-isolation` + `v2-webhook-unregister-stops-delivery`
      executed-pass on a certified bundle (suite 2.40.0, pending publication).
- [x] §A.3 per-tenant cap: done in **P2** below.
- [ ] `DELIVERY_TIMEOUT_MS` is 10 s. The scenario holds its receivers ~20 s, so this
      host abandons a held attempt at 10 s. It does not affect either scenario (the
      healthy attempt lands in well under a second), but a receiver slower than 10 s
      is a failed attempt here.

## P2: §A.3 per-tenant in-flight cap (2026-09-26)

Deferred above because delivery rows carried no tenant. Now:

- **Column.** `webhook_deliveries.tenant_id` (postgres mig 46, sqlite mig 48), stamped
  at enqueue from the subscription. It is **nullable with no backfill**: only rows
  queued before the deploy are NULL, they drain within minutes, and a NULL row is never
  tenant-excluded (the pre-P2 behaviour).
- **Cap.** `webhookMaxInFlightPerTenant(capacity)` defaults to half the capacity (16 of
  32), is capped at the capacity, and is tuned with
  `OPENWOP_WEBHOOK_MAX_IN_FLIGHT_PER_TENANT`. **It is floored at 9, and the floor is the
  point.** §A.2 is a MUST *within* one tenant too: the conformance scenario holds eight
  of one tenant's subscriptions and needs its ninth to start. A cap below 9 would trade
  the MUST for the SHOULD.
- **Exact, never overshot.** Tenants at the cap are excluded from the claim
  (`excludeTenantIds`). The claim is sized to the smallest remaining room of any tenant
  already in flight, because a leased row cannot be handed back. Full claims loop, so a
  small limit costs round trips, not throughput.

| Claim | Witness (`rfc0215-webhook-delivery-isolation.test.ts`) | Sabotage that turns it red |
|---|---|---|
| a tenant with 20 hung receivers holds 16; another tenant starts while all 16 are open | §A.3 describe | cap disabled (per-tenant = capacity); sqlite claim ignores `excludeTenantIds` |
| §A.2 still holds inside ONE tenant at the capacity floor | same | floor removed |
| a NULL-tenant row is never excluded | same | floor removed (starves the setup) |
| Postgres tenant clause, and the migration on real PG 17 | PGlite scratch run (not committed) | tenant clause dropped |
