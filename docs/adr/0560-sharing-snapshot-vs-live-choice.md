# ADR 0560 — Snapshot-vs-live as a mint-time choice on share links

Status: Proposed
Date: 2026-08-13
Origin: UX_UPGRADE-sharing round 3 (/feature-refinement) over SH-R2-4, which
R2 ranked "highest effort — resolveShared semantics + replay; own ADR if
pursued". Market basis (R2 catalog, cited): Google Docs publish-to-web ships
an explicit "automatically republish" checkbox; DocSend markets always-latest
links. The leaders offer the CHOICE; today we are honest about which one each
resource type gives you, but the operator cannot choose.

## Current truth (post-R2, verified)

`resolveShared` serves LIVE content for 8 of 9 types and a true snapshot only
for conversations; the viewer says which, honestly, per type (SR-3's fix). The
share link model carries `snapshotAt` only where it is real.

## Decision (proposed)

Add an optional mint-time `mode: 'live' | 'snapshot'` to share-link creation
(default: today's per-type behavior, so an un-migrated caller is byte-identical):

- **`live`** — today's behavior for the 8 living types; refused (400, named)
  for conversations only if conversations cannot honestly serve live (they
  can — the resolver reads current state when `snapshotAt` is absent).
- **`snapshot`** — at mint, the resolver's CURRENT projection is serialized
  and stored as a share-scoped copy (the commerce_order precedent: an
  immutable projection frozen at a business moment). The public viewer then
  serves the stored copy with the (now always-true) "Snapshot from {date}"
  line. Content-addressed dedup optional later.

## The two hard problems, named up front

1. **Storage & retention**: a snapshot copy is tenant data with the LINK's
   lifetime — it must ride the existing revocation grace + retention sweep
   (the `revokedAt`-anchored 30-day grace), and subject-erasure must reach
   INTO stored snapshots (the documents/entities R2 lesson: an eraser that
   misses a derived copy reports false completeness). This is the majority of
   the effort and the reason R2 declined to drive-by it.
2. **Replay/fork**: a snapshot minted inside a run must freeze what the RUN
   saw. Snapshot-at-mint composes with replay only if minting is a recorded
   effect (role:'action') — the guard rails exist (ADR 0531's fail-closed
   effect guard); the ADR requires the mint node declare itself effectful.

## Boundaries audit

- `resolveShared` is the single resolve owner; the mode branches INSIDE it.
- The commerce_order resolver is the stored-projection precedent — compose its
  shape, don't invent a second freezing mechanism.
- ~~Erasure: sharing already registers link-level erasure; snapshot copies key
  by tokenHash and ride the same eraser + retention anchor.~~

  > **CORRECTION 2026-08-18 (WF-SHARE-6 / SHARE-2).** When this audit was
  > written the claim was **false**: `git grep registerSubjectEraser` returned
  > 73 sites and **none** was in `features/sharing/`, while `ShareLink.createdBy`
  > is a subject identifier. Nothing shipped on the false premise (this ADR is
  > still Proposed), but the stored-snapshot design leans on that eraser reaching
  > derived copies, so the premise is now **satisfied rather than assumed**:
  > `sharingService.ts` registers `eraseSubjectSharing`, which **REVOKES** a
  > departing subject's live links and then anonymizes `createdBy`.
  >
  > Two consequences this ADR's Phase 1 must honour, not inherit silently:
  > (1) the eraser is a REVOKE, so a stored snapshot keyed by `tokenHash` goes
  > dark with its link — that is the intended outcome, but it must be stated in
  > the snapshot design rather than discovered; (2) the retention anchor is the
  > derived `deadAt` field (`registerKvAgeOut('sharing:link')`, WF-SHARE-1), so a
  > snapshot row must either live on the link row itself or cascade from the
  > collection's delete hook — a sidecar collection with its own key would age
  > out on nothing.
  >
  > **AMENDED 2026-08-18 (R2 review, F3) — the eraser's REACH, stated before
  > Phase 1 inherits an assumption.** `eraseSubjectSharing` matches
  > `createdBy === subjectKey`, and only the authed management route
  > (`sharing/routes.ts`) attributes a link to a human. Booking-manage, e-sign
  > and order-status tokens are minted by SYSTEM actors
  > (`system:crm-booking`, `system:crm-sign`, `system:commerce`), so subject
  > erasure does **not** touch them — nor, therefore, any snapshot keyed to
  > them. Consequence (3) for this ADR: a stored snapshot of a
  > `commerce_order` / `booking_manage` / `sign_request` link SURVIVES the
  > erasure of the person whose data it may describe, because the link it hangs
  > off was never attributed to them. If Phase 1 needs those snapshots erased,
  > it must key on the snapshot's SUBJECT (the contact/customer), not on the
  > link's `createdBy` — a different eraser, not a reuse of this one.
- RFC verdict: **host-ext, no wire** (mint body field on an existing host
  route; the public viewer contract unchanged).

## Alternatives weighed

- **Snapshot-on-first-view** (lazy) — rejected: the first viewer defines what
  later viewers see; a mint-time freeze is what the operator chose.
- **Version-pin instead of copy** (store a version ref, not bytes) — viable
  for versioned resources (cms pages), impossible for unversioned ones;
  REJECTED as the general mechanism, noted as a per-type optimization.
- **Do nothing** — the current honest-per-type posture is defensible; this ADR
  exists because the market row says the leaders offer the choice, not because
  the current state lies.

## Phased plan

| Phase | Scope | Verify |
|---|---|---|
| P1 | Mint-time `mode` + snapshot storage for cms_page + kb_collection (the picker's defaults) + viewer truth line + retention/erasure reach | backend tests incl. erasure-reaches-snapshots |
| P2 | Remaining living types + the recorded-effect mint node for runs | replay tests |
| P3 | SH2 mint UI (the choice, defaulting per type) + i18n ×4 | frontend tests |

## Open questions

- [ ] Snapshot size caps (a shared app design can be large) and the refusal
      copy when a resource exceeds them.
- [ ] Should re-minting a snapshot link of the same resource dedup?
