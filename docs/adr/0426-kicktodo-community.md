# ADR 0426 — `kicktodo-community`: creator profiles, challenge reviews, and counts-only creator analytics

Status: **implemented** (P1–P5, 2026-07-18; record below)

**Requirements source:** `docs/kicktodo-prd.md` §12 Wave 3 ("Creator profiles and challenge reviews"; "Creator analytics that do not expose participant private data").
**Depends on:** ADR 0415 (the published-challenge catalog is what profiles/reviews attach to), ADR 0420 (entitlements prove purchase; the counts-only projection pattern), ADR 0414 (completed enrollments prove participation), approvals (ADR 0493 family — moderation).
**Surface:** host-extension. **NO new RFC.**

## Why this exists

Wave 3 opens the creator economy; a marketplace without creator identity and social proof doesn't convert, but reviews and profiles are also the classic abuse surfaces (spam, brigading, PII leakage, squatting). Every mechanism here is therefore gated on something the host can PROVE: a profile on the approval lane, a review on a verified enrollment/entitlement, analytics on counts the participant-privacy floor already allows.

## Boundaries audit (verified against live code)

- **Route namespace:** the reserved-namespace guard FORBIDS `/kicktodo/marketplace` — this package registers `/v1/host/openwop-app/kicktodo/community` (grep clean; joins the collision union).
- **Single owners composed, not forked:** challenge artifacts/versions/publication → `kicktodo-creator` (untouched); money/entitlements → `kicktodo-commerce` (`entitlementFor` is the purchase proof); enrollment/completion → `kicktodo-core`; moderation → the existing approvals owner (a `community-review` approval kind, same seam as `challenge-publish`); seller/paid-listing gates → commerce-connect's approval-gated lanes (ADR 0385 — the anti-phishing correction applies verbatim to profiles).
- **No second identity system:** a creator profile is keyed by the caller's stable subject (`callerSubject`), display fields only — it never models auth.

## Decision + data model

New feature package `src/features/kicktodo-community/`:

```text
CreatorProfile   tenantId, creatorSubject, handle (tenant-unique, collision-checked),
                 displayName, bio, links[] (schema-validated http(s) only), state: draft|pending|approved|suspended
ChallengeReview  tenantId, reviewId (deterministic: challengeId+reviewerSubject — ONE review per buyer, editable),
                 challengeId, challengeVersion, reviewerSubject, rating 1..5, body?, state: visible|flagged|removed,
                 provenance: entitlement|completed-enrollment
```

- **Profiles are approval-gated before public visibility** (`pending → approved` via the approvals kind) — the multi-tenant squat/phishing posture ADR 0385 established for seller lanes; `anon:` tenants can never hold an approved profile.
- **Reviews require proof**: the writer must hold a live entitlement (paid) OR a completed enrollment (free) for that challenge version — checked at write time through the owning services' seams; one review per subject per challenge (deterministic id; edits overwrite, never duplicate).
- **Analytics are counts-only projections** for the creator's OWN published challenges (enrollment count, completion rate, rating histogram, refund count) — the `revenueProjectionFor` pattern; never a participant row, never cross-creator.
- **Aggregate rating** on the Discover card renders only at ≥3 visible reviews (k-floor).

## Phased plan

| Phase | Ships |
|---|---|
| **P1** | Package + profile CRUD + the approval kind + handle collision checks + tenant/RBAC tests. |
| **P2** | Reviews: proof-gated write (entitlement/completion), deterministic one-per-buyer, flag → moderation via approvals, uniform 404s. |
| **P3** | Counts-only creator analytics + the Discover aggregate-rating projection (k-floor). |
| **P4** | Frontend: profile page + review composer on completed/purchased challenges + Discover rating display; i18n ×4. |
| **P5** | `ctx.features.kicktodo-community` reads + node additions (pack bump + pin lockstep); LLM-EXCHANGE row. |

## PRD-vs-architecture correction (implementation)

Free-challenge creator attribution does not exist in the catalog (`ChallengeDefinition` has no `createdBy`) — creator analytics therefore covers **product-linked** challenges (the link's `createdBy`, the `revenueProjectionFor` precedent). Free-challenge attribution arrives with creator onboarding (Wave-3 activation), not silently here.

## Implementation record

| Phase | Landed |
|---|---|
| P1 — profiles: atomic CAS handle claims (no TOCTOU), owner CRUD, `community-profile` approval kind (typed union extension + `createCommunityApproval`, the D3 precedent), SEPARATION OF DUTIES on decide (owner cannot approve self — test-pinned), approved-only closed public projection | kicktodo/0426-p1p3 |
| P2 — reviews: proof-gated (active entitlement OR completed enrollment via the owning services), ONE per buyer by deterministic key (edit overwrites — test-pinned), rating clamped int 1..5, body capped, NO reviewer PII in projections (test-pinned), flag → `community-review` approval + immediate hide, k≥3 aggregate floor | kicktodo/0426-p1p3 |
| P3 — counts-only creator analytics composing `revenueProjectionFor` + rating aggregates | kicktodo/0426-p1p3 |
| P4 — Community page (`/kicktodo/community`, KickTodo nav group, toggle-gated): profile editor with labeled state chips (draft/pending/public/suspended) + the approval-required disclosure; proof-gated review composer over the caller's enrollments (denial explained via Notice, never hidden); k-floor aggregate display; i18n ×4; ux-review CLEAR | kicktodo/0426-p4p5 |
| P5 — read-only `ctx.features.kicktodo-community` (profile/reviews/analytics) + `feature.kicktodo.nodes.challenge-reviews`; pack **v1.7.0** pin-lockstepped across core/creator/accountability/engagement/community (parity-enforced); LLM-EXCHANGE row | kicktodo/0426-p4p5 |

## Feature matrix

1. Package ✔. 2. Toggle `kicktodo-community`, **OFF**, `bucketUnit: tenant`, dependsOn `kicktodo-core`, `kicktodo-creator`. 3. `ctx` surface: P5 reads. 4. Node pack: extends `feature.kicktodo.nodes`. 5. Envelopes: none. 6. Agent pack: none new. 7. Public surface: none in this ADR (public profile pages would ride the published-content lane later — open question 2). 8. RBAC: profile mutation = owner; review mutation = proven reviewer; moderation = the approvals lane; fail-closed, uniform 404. 9. Replay/fork: no run coupling. 10. Frontend: composes Discover + a profile page; no new nav group.

## Alternatives weighed

- **Extending `kicktodo-commerce` with reviews** — rejected: commerce is the money adapter (ADR 0420's single job); social surfaces drift on a money package.
- **Open (proof-free) reviews** — rejected: the marketplace's trust claim IS verified participation; unproven reviews are spam surface with no upside.
- **Cross-tenant global reviews** — rejected for now: tenant-scoped like the rest of the catalog; a federated catalog would be a wire conversation (RFC gate) — recorded as the falsifiable trigger.

## Open questions

1. Review body moderation: pre-moderation (approval before visible) vs post-moderation (visible, flaggable)? Recommend post-moderation with the flag lane — pre-moderation starves cold-start.
2. Public (unauthenticated) profile pages — defer until the published-content public lane is composed; not in P1–P5.

## RFC verdict

**Host work, no new RFC.** A cross-HOST/federated review catalog would need one — explicitly out of scope and recorded as the trigger.
