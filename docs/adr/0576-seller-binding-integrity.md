# ADR 0576 — Seller↔Stripe-account binding integrity (closes CC2-M7)

Status: implemented (2026-08-15) — create-only CAS on every accountIndex write (import + all three onboarding sites), typed import refusals with rejected[], reconcileSellerBindings divergence flag.

## Problem

`importSellers` (`commerce-connect/adminOps.ts:64`) skips-if-exists on the
**tenant** key (`sellers.get(row.tenantId)`) but never checks whether the
row's **`stripeAccountId` is already bound to a different tenant** — and it
unconditionally writes `accountIndex` (keyed by `stripeAccountId`). A crafted
import row `{tenantId: 'attacker', stripeAccountId: <live seller's acct>}`
therefore (a) creates a second seller row for the same Stripe account, and
(b) **overwrites the account index**, re-routing every future
`event.account`-keyed webhook (payouts, deauthorizations, capability changes)
to the attacker's tenant. The R2 note adds that the importer bypasses the
`anon:` guard (GEN-CC-1). The route is superadmin-gated — the exposure is an
operator mistake or a compromised/imported CSV, not an anonymous attacker —
but a money-attribution index that can be silently repointed is wrong at any
privilege level.

## The invariant

**A Stripe account id binds to at most one tenant, and the binding is
immutable except through explicit dissolution** (deauthorize → operator
tombstone/removal → fresh onboarding). This mirrors the platform-side rule
Stripe Connect itself enforces (an account belongs to one platform
relationship at a time); we enforce the tenant-side mirror.

## Decision

1. **Refusals in `importSellers`** (each counted + reported, never silent —
   the import summary gains `rejected: [{row, reason}]`):
   - `account_already_bound`: `accountIndex.get(stripeAccountId)` exists with
     a different `tenantId`.
   - `anon_tenant`: `tenantId` starts with `anon:` (the GEN-CC-1 fold guard,
     applied here too — an anonymous tenant can never be a seller).
   - The existing skip-if-exists and state-enum checks stay.
2. **`accountIndex` writes become create-only CAS** everywhere (import AND
   onboarding): a put that would change the `tenantId` of an existing index
   row throws `binding_conflict` instead of overwriting. Dissolution is the
   only path that deletes an index row, and it requires the seller row to be
   `deauthorized` first.
3. **A reconciliation invariant check** rides the existing daily sweep: every
   `accountIndex` row must agree with its `sellers` row (same tenant, account
   present); disagreement logs `seller_binding_divergence` and flags the
   approvals inbox — divergence is an incident, not a self-heal.
4. **Sunset note:** the importer is a Phase-0 continuity tool (ADR 0176 R-1).
   When the last import predates 90 days of production, remove the route; the
   binding CAS and the reconciliation check outlive it (onboarding needs them
   too).

## Boundaries audit

`accountIndex` stays the ONE binding owner; this ADR makes its write
discipline match its read authority. No new stores, no new routes (the import
route hardens in place; dissolution rides the ADR 0574 lifecycle).

## Test plan / sabotage

Import a row rebinding a live account ⇒ `account_already_bound`, index
unchanged, webhook attribution still the original tenant (route-level, two
sellers); `anon:` row refused; onboarding CAS: concurrent onboard against the
same account — one wins, one gets `binding_conflict`; reconciliation flags a
hand-broken index. Sabotage: restore the unconditional `accountIndex.put` ⇒
the rebinding test fires.

## RFC verdict

None — internal stores + a superadmin host route.

## Open questions (for David)

Whether dissolution should also require a zero-balance check against Stripe
before unbinding (assumed no for v1 — Stripe's own transfer/payout state is
authoritative; we only gate on our `deauthorized` state).
