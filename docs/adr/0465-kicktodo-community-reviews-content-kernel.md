# ADR 0465 — KickTodo community reviews → the content kernel (reviewer-anonymous projection)

Status: implemented — 2026-07-21 — `reviewProjection.ts` (random `rev:<uuid>` entity id, `rating`/`body`/`provenance`/`challenge_id` only, NEVER `reviewerSubject`) + write-model `reviewEntityId` SoT + triggers (`putReview`/`flagReview`/`resolveReviewFlag`/`eraseCommunitySubject`) + boot `reconcileReviewProjections`; test `kicktodo-review-kernel.test.ts` pins the reviewer-anonymity invariant. Phases 1–4 landed together on `feat/adr0465-reviews-kernel`.
Extends: ADR 0453 (creator-profiles → kernel — the projection precedent this follows AND diverges from on privacy)
Composes: ADR 0406/0407/0408 (the one content kernel — `entitiesService`), ADR 0410 (system-type façades), ADR 0426 (opaque subjects, never PII), ADR 0430 (challenges are off-kernel/immutable)
TODO refs: `docs/steward/TODO.md §6` KT-PORT-8

## 1. Context

`kicktodo-community` challenge reviews are a bespoke store today (`communityService.ts`):
a buyer/completer leaves a `rating` + optional `body`, gated by a `reviewProof`
(active entitlement or completed enrollment); the review is `visible`, can be
`flagged` (→ a `community-review` moderation approval) and `removed`. The ONLY public
projection is `visibleReviews` (`:356-370`) — `{rating, body?, provenance:'verified
purchase'|'verified participant', createdAt}`, **no reviewer identity** — plus
`aggregateRating` (`:382-389`), suppressed below k=3.

KT-PORT-8 proposes these approval-gated public reviews ALSO project onto the ONE
content kernel (`entitiesService`), following the ADR 0453 creator-profiles precedent
(publish-on-approval, delete-otherwise, `putSystemEntity`/`deleteSystemEntity`,
`gatePublicType = published && publicRead && !neverPublic`).

## 2. Boundaries audit + the two corrections (why this is NOT a clean copy of 0453)

The projection MECHANICS are copyable from `creatorProfileProjection.ts:83-113`
(a self-contained module in kicktodo-community importing the kernel API; no shared
kernel host file is edited — `mintSystemType` is runtime + tenant-scoped with no
central registry, `entitiesService.ts:634`). But two decisions have NO precedent:

- **CRITICAL — reviewer anonymity (the privacy divergence).** 0453 keys its kernel
  entity by `creatorSubject` and deliberately exposes that opaque subject in the
  entity URL — for a creator profile the subject IS the public identity (ADR 0453 P4:
  "the OPAQUE subject is only the entityId … NEVER in the body"). A **review is meant
  to be publicly anonymous** — `visibleReviews` drops the subject entirely. Keying a
  `publicRead` review entity by `challengeId::reviewerSubject` would **leak the opaque
  subject into the public URL**, enabling who-reviewed-what enumeration and cross-
  challenge correlation of a single reviewer — a real PII/consent leak (ADR 0426).
  Even a *deterministic hash* of the subject preserves correlation. → the review
  kernel entity MUST be keyed by a **random, per-review, non-subject-derived id**, and
  carry `rating`/`body`/`provenance`/`challengeId` ONLY — never `reviewerSubject` as an
  entity id OR a value.
- **Weaker justification than 0453 (record honestly).** 0453's justifying win was
  **localization** (`display_name`/`bio` per-locale). Reviews have **no l10n story**
  (`rating` + free-text `body`). And the aggregate has **no kernel home**: challenges
  are deliberately off-kernel (immutable, version-frozen — ADR 0430), so there is no
  challenge kernel entity to hang `aggregateRating` on, and a review entity has no
  kernel parent. So the projection's value is **kernel consistency + uniform public-
  read gating + erasure + discoverability**, NOT a richer read. `aggregateRating`
  stays computed off-kernel regardless. See §4 (alternatives) — this trade-off is the
  ratification question.

## 3. Decision

Project each **visible** review as a `kicktodo.review` kernel system-entity, reviewer-
anonymous by construction:

1. **Random projection id (the privacy fix).** `putReview` mints a random
   `reviewEntityId` (e.g. `rev:<randomUUID>`) stored on the `ChallengeReview` write-
   model (the SoT for the review→entity mapping) — NOT derived from `reviewerSubject`,
   so it is unlinkable to the reviewer or across their reviews.
2. **Type** — `kicktodo.review` via `mintSystemType({fields: rating, body, provenance,
   challengeId, actor:'system:kicktodo-community'})` → `updateEntityType({publicRead:
   true})`, minted lazily in the publish branch (the 0453 shape). `neverPublic` NOT
   set (it IS public content) — but see OQ1 (publicRead vs. private mirror).
3. **Sync** (`reviewProjection.ts`, mirroring `syncCreatorProfileProjection`):
   `state==='visible'` → `putSystemEntity({typeName:'kicktodo.review', entityId:
   reviewEntityId, values:{rating, body, provenance, challengeId}, status:'live'})`;
   `flagged`/`removed` (or erased) → `deleteSystemEntity(reviewEntityId)`. **Never**
   put `reviewerSubject` in `entityId` or `values`. Best-effort try/catch with the
   0453 asymmetric severity (publish-fail = `warn`; unpublish-fail = `error`, a stuck-
   public row is the dangerous divergence).
4. **Triggers**: `putReview` (visible→publish), `flagReview` (→delete), `resolveReviewFlag`
   (removed→delete / restore→publish), `eraseCommunitySubject` (must ALSO delete the
   subject's kernel review entities — the erasure completeness bar), + a best-effort
   boot `reconcileReviewProjections` backfill (the 0453 `feature.ts` pattern).
5. **Aggregate stays off-kernel** — `aggregateRating`/`visibleReviews` are unchanged;
   this ADR adds the per-review kernel entities, it does not replace the existing reads.

## 4. Alternatives weighed

- **(a) Don't project — leave reviews off-kernel (the honest null option).** `visibleReviews`
  + `aggregateRating` already serve the public need with reviewer anonymity built in and
  zero new surface. Given the weak read-win (§2) + the off-kernel parent, this is a
  legitimate outcome. The trade-off the projection buys: uniform kernel public-read
  gating + erasure + cross-feature discoverability (the one-content-kernel consistency
  the 0406–0410 program chose for company/deal/product/pages/profiles). **This ADR is
  Proposed precisely so that trade-off is ratified, not assumed** (OQ4).
- **(b) Key the entity by `challengeId::reviewerSubject`** — REJECTED: the §2 privacy leak.
- **(c) Aggregate rating onto the challenge's kernel entity** — IMPOSSIBLE: challenges are
  off-kernel (ADR 0430); there is no such entity.

## 5. Evaluation matrix (deltas only)

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | EXTENDS `kicktodo-community`; one new module `reviewProjection.ts`; NO shared-kernel host file edited (runtime `mintSystemType`, no central registry). |
| 2 | Toggle | none — rides `kicktodo-community`. |
| 3 | Workflow surface | none. |
| 4 | Node/agent packs | none. |
| 5 | Public surface | the kernel's existing anonymous public-read (`gatePublicType`) — no new route; a review entity is `publicRead` (OQ1). Tenant derived from the entity, never the request. |
| 6 | RBAC / isolation | tenant-scoped by `recordKey` (kernel enforces); moderation stays on the existing `community-review` approval. |
| 7 | Privacy | **the load-bearing dimension**: random non-subject entity id; `rating`/`body`/`provenance`/`challengeId` values only; NEVER `reviewerSubject`; on the ADR 0381 erasure seam (delete the subject's review entities). |
| 8 | Replay/fork | n/a (projection, no run). |
| 9 | Lifecycle | write-model stays SoT; the kernel row is a derived publish-on-visible / delete-otherwise mirror; erasure pulls it down. |
| 10 | Frontend | none this ADR (a public reviews-browsing surface, if wanted, is a separate consumer — OQ4). |

## 6. RFC verdict

**Host-extension only — no new RFC.** Rides the Accepted one-content-kernel surface
(`entitiesService`, ADR 0406–0410) + ADR 0453's projection pattern. No wire change.

## 7. Phased plan

| Phase | Contents | Gate |
|---|---|---|
| 1 | `reviewEntityId` on the `ChallengeReview` write-model (minted at `putReview`); migration-free (KV blob; absent on legacy rows → minted on next reconcile). | — |
| 2 | `reviewProjection.ts`: `ensureReviewType` + `syncReviewProjection` (privacy-safe mapping, random id, best-effort, asymmetric severity) mirroring `creatorProfileProjection.ts`. | P1 |
| 3 | Triggers in `putReview`/`flagReview`/`resolveReviewFlag`/`eraseCommunitySubject` + `reconcileReviewProjections` boot backfill. | P2 |
| 4 | Test cloned from `test/kicktodo-creator-profile-kernel.test.ts` — adapt its P4 privacy assertion to pin **no `reviewerSubject` in the entity id OR values**; publish-on-visible / delete-on-flag/remove; erasure pulls the entity down. | P3 |

Reviews + grade rhythm per ADR 0458.

## 8. Coordination note

**File-collision: clean** — the projection lives entirely in `kicktodo-community` and
imports the kernel API; no shared-kernel host file is edited. **Decision-ownership:**
docs/steward/TODO.md refined KT-PORT-8 as a handoff to the platform-seam lane ("kernel numbering
theirs"); this ADR is authored under this lane's numbering per an explicit maintainer
reassignment. The kernel is shared platform territory — coordinate the `kicktodo.review`
type name + the publicRead posture (OQ1) with the platform-seam owner before P2 lands.

## 9. Open questions

- **OQ1 — publicRead vs. private mirror:** is the review kernel entity actually
  `publicRead` (anonymous public gating, the point), or a `neverPublic` internal mirror
  (consistency/erasure only, no public exposure)? Proposal: `publicRead` (the value is
  a uniform public content surface) — but only with the §3 random id.
- **OQ2 — replace vs. augment:** does anything consume the kernel review entities
  (a public reviews-browsing/SEO surface), or do `visibleReviews`/`aggregateRating` stay
  the sole public reads? Proposal: augment only; no consumer this ADR.
- **OQ3 — the aggregate:** confirmed off-kernel (no challenge entity to host it); revisit
  only if challenges ever gain a kernel projection (they are off-kernel by ADR 0430).
- **OQ4 — does it earn its keep? (the ratification question):** given the weaker win
  than 0453 (no l10n, off-kernel parent, already-served by `visibleReviews`), ratify
  whether the kernel-consistency/discoverability value justifies the new surface, or
  whether alternative (a) — leave reviews off-kernel — is the right call. The
  first-consumer rule leans toward deferring until a real public-reviews consumer exists.
