# ADR 0574 — Commerce-Connect listing ownership & lifecycle (closes CC2-B3)

Status: implemented (P1 + P3, 2026-08-15) — dissolution route + store-backed tombstone/cooldown + listing states + the ONE purchasable predicate (region fold). P2 (claim-time publisher proof) remains the next phase: its prerequisite — a tenant↔publisher-identity registration — does not exist yet and is its own design.

## Problem

**Any tenant can permanently claim any pack name.** `upsertPaidListing`
(`features/commerce-connect/listings.ts:93`) checks only "already listed by
*another* seller" — pure first-come. There is no pack-ownership check anywhere,
the free lane is deliberately ungated (no seller account, no approval), and
**nothing ever deletes a listing row**. One
`PUT /listings/feature.crm.nodes {lane:'free'}` and the pack's real author gets
a permanent 409 with no escalation path (CC2-B3, UX_UPGRADE-access-data
§Known-open). Two residuals compound it: `packTombstones.ts` is a per-process
boot cache ("cross-instance freshness = next boot" — a tombstoned pack keeps
selling on other Cloud Run instances until they restart), and
absent-but-not-tombstoned listings stay purchasable (CC2-R1 residual).

## Research basis (bounded — session WebSearch exhausted; documented registry policies)

The three major package registries map the whole design space:

- **npm** resolves squats through a *dispute lifecycle* (contact → mediation →
  operator transfer/removal) — remediation exists, prevention doesn't.
- **PyPI (PEP 541)** defines *claim categories* (name squatting, abandoned,
  invalid) with an operator-arbitrated reclaim path — a written lifecycle.
- **crates.io** famously enforces *neither* — and name squatting is endemic
  there. It is the control group: a registry with first-come claims and no
  lifecycle converges on exactly our CC2-B3.

Lesson: **prevention at claim time where ownership is provable, plus an
operator remediation lifecycle for everything else.** We are better positioned
than any of the three: our packs are **Ed25519-signed through the registry
pipeline**, so ownership is cryptographically provable at claim time — the
registries can't do that for arbitrary names.

## Decision

Three phases; the invariant at the end: *a listing exists only while a seller
who can prove publisher identity for that pack name wants it listed, and the
operator can always dissolve one.*

### P1 — superadmin dissolution (the remediation floor)

- `DELETE /v1/host/openwop-app/commerce-connect/admin/listings/:packName`
  (superadmin; the ADR 0575 operator-surface class — deliberately NOT
  toggle-gated). It **tombstones** rather than hard-deletes: the row moves to
  `state:'tombstoned'` with `{by, at, reason}` — the audit trail is the point,
  and a tombstoned name is refused on re-claim by the SAME sellerTenantId for a
  90-day cooldown (a squatter cannot immediately re-squat).
- **Tombstones move to the store** (`cc:tombstone` DurableCollection read at
  serve/claim time with a short in-process cache + TTL), closing the
  boot-cache residual: an operator tombstone takes effect on every instance
  within the cache TTL (60s), not at next boot.
- The 409 on a taken name gains the escalation path the current message lacks:
  it names the operator-review route (the approvals inbox already exists) so
  "contact the operator" points at a mechanism that exists (the CC2-M2 lesson).

### P2 — claim-time ownership proof (the structural close)

- A listing claim for a REGISTRY-PUBLISHED pack name must present publisher
  identity: the claim is accepted only when the pack registry's publisher key
  for `packName` verifies against the claiming tenant's registered publisher
  identity (the Ed25519 signing identity the pack pipeline already maintains).
  Wrong/absent identity ⇒ typed `not_pack_publisher` 403 naming the dispute
  path — never a silent first-come win.
- Names NOT in the registry (a seller listing a pack they are about to publish)
  fall back to first-come **with the P1 lifecycle behind them** — the npm
  posture, but with a working dissolution route.
- Existing listings are grandfathered but re-verified lazily: the first PUT
  after P2 ships re-runs the proof; a failing grandfathered row is flagged to
  the approvals inbox, not auto-tombstoned (operator decides — over-retain,
  never over-remove).

### P3 — lifecycle states + the purchasable seam

- `PaidListing.state: 'active' | 'suspended' | 'tombstoned'` (absent ⇒ active,
  additive). `suspended` = operator hold (visible to the seller, not
  purchasable, not 404) — the intermediate state every dispute needs.
- `purchasable` derives from state AND the region guard (closing CC2-M4's
  drift in the same projection — one predicate, both consumers).
- Checkout refuses non-active listings with a typed reason; the CC2-R1
  absent-but-not-tombstoned residual closes because absence now has a state.

## Boundaries audit

- Listing rows: ONE owner (`listings.ts`) — unchanged. Tombstones: currently
  `packTombstones.ts` (boot cache) — P1 makes the STORE the source of truth
  and the module its cache; no second owner.
- The approvals inbox (`approvalService`) already owns operator review — the
  dispute flow rides it (no new review surface).
- The pack registry owns publisher identity — P2 READS it, never duplicates it.

## Alternatives weighed

- **Remediation only (P1 alone):** the npm posture. Leaves every future squat
  as operator toil; rejected as the end state, accepted as the floor.
- **Proof-of-ownership only (P2 alone):** leaves existing squats and
  unpublished-name claims unresolvable; no dissolution path is how crates.io
  got here. Rejected.
- **Hard-delete instead of tombstone:** destroys the audit trail and re-opens
  the name to the same squatter instantly. Rejected.

## Test plan (route-level, per the architect skill's testability rule)

Claim-by-non-publisher refused typed; superadmin tombstone → listing gone from
`/listings` within cache TTL on a SECOND app instance (two-listener test);
re-claim by the tombstoned seller inside cooldown refused, by the true
publisher allowed; suspended ⇒ visible-not-purchasable; checkout against each
non-active state refused typed. Sabotage: drop the publisher check ⇒ the claim
test fires; revert tombstones to boot-cache ⇒ the two-instance test fires.

## RFC verdict

Host-extension only (`/v1/host/openwop-app/*`); the pack REGISTRY protocol is
untouched (we read its existing signature chain). No new OpenWOP wire.

## Open questions (for David)

1. Cooldown length (assumed 90 days) and whether tombstoned names should be
   operator-reservable indefinitely.
2. Should P2's publisher identity also gate the FREE lane's first listing
   (assumed yes — same claim seam, no seller account required, identity only)?
