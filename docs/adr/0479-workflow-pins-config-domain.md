# ADR 0479 — Workflow published pins join environments as a config domain

Status: Accepted (implementation in this ADR's PR)
Date: 2026-07-24
Relates: ADR 0387 (environments/promotion — the reserved D2 v2 seam), ADR 0474
(workflow revisions + publish=pin — the "stable version handle" the 0387
deferral named), the 2026-07-24 competitive re-assessment (whitespace item 1:
D11 environments C → the Windmill-led axis).

## Context

ADR 0387 §"Workflow-template pins" deferred workflow state from environments
v1 because "templates are not yet content-hash-versioned in a way a snapshot
can pin cleanly — register the domain contributor in v2 once the store
exposes a stable version handle." ADR 0474 shipped that handle: content-hash
revisions (`revisionHashOf`, `workflow:revision` rows) and publish=pin
(`ownership.publishedRevision`, read at every production launch by
`resolveLaunchWorkflow`). The trigger is met; this ADR registers the v2
contributor.

Competitive frame (2026-07-24 re-survey): environments/promotion is our
weakest graded axis (C) while Windmill extended its lead (linked
dev→staging→prod workspaces, per-item deploy diffs, auto-git-deploy with
in-app PRs). Workflow pins are the highest-value config domain a workflow
platform can snapshot — they decide WHAT PRODUCTION RUNS.

## Decision

1. **A `workflow-pins` `ConfigDomain`** (`features/environments/domains/
   workflowPinsDomain.ts`), registered beside the two v1 contributors in
   `features/environments/feature.ts` — the exact seam ADR 0387 D2 reserved.
   Feature→host imports only (`workflowOwnership`, `workflowRevisions`),
   identical in direction to both existing domains.
2. **Export** = a flat deterministic map `{ [workflowId]: publishedRevision }`
   over `listOwned(tenantId)` rows that carry `publishedRevision` (published
   workflows only — transient drafts and never-published workflows are not
   pinnable state). Map-keyed payload honors the canonical-JSON hash contract.
3. **Import is APPLY-ONLY, never clear-omitted** — the /architect §1 ruling,
   and a deliberate divergence from `featureTogglesDomain`'s exact-match
   restore, following the `publishPointersDomain` precedent instead:
   - A workflow ABSENT from the snapshot keeps its live pin. Clearing a pin
     would flip that workflow's production launches back to HEAD — the exact
     "edits eat production" class ADR 0474 closed. Environments' drift
     detection (live-hash vs pinned snapshot) reports the divergence honestly
     instead.
   - **Correction to the domain contract**: `configDomains.ts`'s import
     comment claimed one EXACT-MATCH register, but the built domains already
     disagree (toggles exact-match, publish-pointers apply-only). The comment
     now names both registers: STATE domains restore exact-match; PRODUCTION-
     POINTER domains restore apply-only with drift as the honesty surface.
     ADR 0387 carries the matching correction note.
4. **Per-item failures are AGGREGATED AND NAMED, never swallowed** — the
   /architect §2 ruling, diverging from publish-pointers' silent fail-soft:
   a silently-unapplied pin means production runs the WRONG revision after a
   "green" promote (failure-mode B4, a half-truth button). Each entry
   validates (a) the ownership row exists for THIS tenant (never creates
   one), (b) `getRevision(workflowId, hash)` still exists (a pruned or
   foreign hash is a named failure). All failures throw one aggregated error
   listing the workflowIds, surfacing through `applyToLive`'s existing
   per-domain 409. Idempotent point writes keep retry safe.
5. **A new host seam** `setPublishedRevision(tenantId, workflowId,
   revisionHash)` in `workflowOwnership.ts` — fail-closed on a missing
   ownership row; no clear variant (apply-only kills the need). The promote
   route's `recordOwnership` sticky-merge path is unchanged.
6. **FE: per-domain diff breakdown** in the environments page (promotion
   preview + snapshot apply), replacing the aggregate-only totals — generic
   across all domains (labels via i18n keyed by domain id, raw id fallback),
   matching the field's per-item-diff bar.
7. **No new routes, no wire surface** — the domain rides the existing
   `/v1/host/openwop-app/environments/*` admin-gated routes and the H2
   approval gate (verified to cover both promote and direct apply). No RFC
   needed.

## Alternatives weighed

- **Exact-match restore with clears** (the doc contract): rejected — clearing
  a pin reverts production launches to head; purity is not worth a silent
  production-behavior change, and drift already discloses divergence.
- **Snapshot-aware pruning** (pruneRevisions consults snapshots so referenced
  revisions never age out): deferred — it inverts a host←feature dependency;
  v1 fails honest-and-named at apply. Recorded follow-on.
- **Re-validating restored definitions against the current contract** (the
  rollback route's posture): not applicable — restore re-points to an
  EXISTING revision row and never mutates head; it is the same class as
  launching a published old revision (replay honesty). Rollback's
  re-validation guards head mutation, which restore never performs.
- **Per-environment runtime workflow state** (true forked environments):
  out of scope — 0387's model is one live config per tenant, versioned by
  snapshots; this ADR keeps that shape.

## Open questions / follow-ons

1. Snapshot-referenced revision retention (above) — revisit if pruned-pin
   409s appear in practice.
2. Chain-instantiated workflows: their pins ride the same ownership rows, no
   special-casing; co-registered sub-chain children are independently owned
   rows and snapshot independently. Verified in tests.
3. Windmill-style git-lane (snapshot → PR) — a later phase candidate, not
   this ADR.

## Review fold-in (both rounds applied in this PR)

Code review (2 HIGH + 2 MED, all folded):
- **H1** — `setPublishedRevision` was a get→put racing the builder autosave's
  `recordOwnership` sticky merge (the old pin could resurrect after a green
  apply). Now a 4-attempt CAS loop (the environments `setProtection` pattern);
  persistent contention returns false → a NAMED per-item failure.
- **H2** — revision EXISTENCE was validated but not TENANCY, while
  `resolveLaunchWorkflow` checks both and silently falls back to HEAD on
  mismatch — a foreign-tenant revision row (real via the dual-ownership edge
  + `recordRevision`'s first-writer dedupe) produced a green apply that
  launched head. Import now requires `revision.tenantId === tenantId`
  (regression-tested with a dual-ownership fixture).
- **M1** — gone-vs-foreign split: a workflow with NO owner (deleted since the
  snapshot) is SKIPPED (the publishPointers lifecycle precedent — failing
  forever would brick every older snapshot); only a workflow owned by ANOTHER
  tenant fails named. `applyToLive`'s 409 copy no longer promises retry for
  unretryable failures.
- **M2** — malformed payload entries now FAIL NAMED instead of being silently
  filtered before the loop (the never-swallow rule applied to the domain's
  own first line).

UX review (1 CRITICAL + fold):
- **Critical** — `confirmApplyBody` claimed "toggles AND publish pointers not
  in the snapshot are cleared": provably false for both pointer domains under
  the two-register doctrine, on the feature's most dangerous confirm.
  Rewritten ×4 locales to state each register's actual behavior.
- The "removed" half-truth: `restore: 'exact-match' | 'apply-only'` is now a
  TYPED field on `ConfigDomain` (the next domain must declare its register),
  exposed through the environments list payload; the FE renders apply-only
  domains' removed counts as "kept (not in snapshot — apply never clears)".
- Per-domain breakdown also renders in the history ledger (details/summary);
  preview gets `role="status"` + a no-changes empty state; es toggle
  terminology unified; en label "Published workflow pins" (backend parity).

## Recorded follow-ons

1. Snapshot-referenced revision retention (OQ1) — unchanged.
2. **Apply-to-live pre-confirm diff** (ux #3b): the direct-apply flow still
   confirms on hash alone; extending /preview to snapshot-vs-live is the
   follow-on. The honest confirm copy is the interim floor.
3. **Per-domain drift breakdown** (code L3): drift is one boolean chip; after
   an apply-only restore it can stay honestly-but-unactionably lit.
4. Export-time dangling-pin filter (code L2): an already-dangling live pin
   snapshots as an entry that fails named at apply; filtering at export is
   the alternative if this bites.

## Implementation record

This PR: domain + CAS seam + typed restore register + contract-comment
correction + 0387 correction note + FE per-domain diff (preview + ledger,
honest apply-only labels, aria-live, empty state) + i18n ×4 + tests
(determinism, apply-only, named foreign-revision/malformed failures,
gone-workflow skip, cross-tenant isolation, service round-trip).


## Grade-trio fold-in (2026-07-24, whole-program grade)

- **H2 (cross-phase)** — `setPublishedRevision`'s CAS (0479 H1) could still be
  clobbered by `recordOwnership`'s blind get→put: a concurrent builder autosave
  or the collab derive's `recordOwnership` could revert a pin AFTER a green
  apply (the B4 half-truth this ADR closes). `recordOwnership` is now a CAS
  loop too, so BOTH pin writers compare-and-swap; and the workflow-pins domain
  now REFUSES to apply a pin for a workflow in a live collab room (the room's
  derive owns that head — named, retryable after the session). Regression:
  `environments-workflow-pins.test.ts` concurrent-recordOwnership case.
