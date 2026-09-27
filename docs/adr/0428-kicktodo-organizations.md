# ADR 0428 — `kicktodo-organizations`: org challenge libraries, org cohorts, branding, and k-anonymous reports

Status: **implemented** (P1–P5, 2026-07-18; record below)

**Requirements source:** `docs/kicktodo-prd.md` §12 Wave 4 ("Organizational challenge libraries, cohorts, branding, and aggregate privacy-preserving reports").
**Depends on:** `accessControl` (the SINGLE org/team/member owner — `accessControlService.ts:297+ createOrg/listOrgs/createTeam/createMember`), ADR 0419 (cohorts are the group primitive), ADR 0414 (enrollment/progress), the brand resolver (`check-brand-resolver` lane), ADR 0415 (the published catalog libraries curate).
**Surface:** host-extension. **NO new RFC.**

## Why this exists

Wave 4's B2B leg: an organization curates which challenges its people see, runs cohorts against them, brands the surface, and reads outcome reports — without EVER reading an individual's progress. The privacy floor is absolute: the PRD promises "aggregate privacy-preserving reports", and 0419 already established that group visibility is granted, never inherited from org membership (§6.6: org membership is "the wrong abstraction" for accountability).

## Boundaries audit (verified against live code)

- **Orgs/teams/members have ONE owner** — `accessControl` (`src/host/accessControlService.ts`). This package stores org-scoped KickTodo rows KEYED BY the accessControl `orgId`; it never models membership, roles, or a second org entity (the orgs↔accessControl collision is the repo's cautionary tale).
- **Route namespace:** `/v1/host/openwop-app/kicktodo/org-programs` — deliberately NOT `/kicktodo/orgs` (concept clarity vs the top-level `/orgs` surface); grep clean; joins the collision union + reserved-namespace guard.
- **Cohorts:** reuses the ADR 0419 cohort primitive (capacity CAS, grants, conversation binding) — an org cohort is a cohort whose creation is org-admin-gated; no second cohort model.
- **Branding:** rides the existing brand resolver surface; this feature stores only an org→brand-profile reference, never CSS/assets.
- **Individual data:** reports read counts through the owning services; no route in this package returns a participant-level row.

## Decision + data model

New feature package `src/features/kicktodo-organizations/`:

```text
OrgChallengeLibrary  tenantId, orgId (accessControl's), curated entries [{challengeId, version, addedBy, addedAt}],
                     mode: allowlist          // Discover inside the org shows ONLY library entries when a library exists
OrgCohortLink        tenantId, orgId, cohortId (ADR 0419's), teamId?
OrgBrandRef          tenantId, orgId, brandProfileId
OrgReport            — NOT stored: computed on read; k-floor ≥5 (enrollment count, completion rate,
                     active streak distribution — buckets only, never rows; below floor ⇒ withheld)
```

- **Library curation** is org-admin-gated (accessControl role check via the existing scope helpers) + tenant-scoped; Discover composes the library as a filter — `kicktodo-core` stays the catalog owner.
- **Org cohorts**: creation binds an 0419 cohort to the org; participant JOINING still follows 0419's consent/grant flow — org linkage never auto-grants visibility (the §6.6 rule, enforced by construction because grants live in 0419).
- **Reports**: k-anonymity floor **≥5 participants per cell**, buckets only; a cell below floor renders "insufficient cohort size", never a smaller number. Test-pinned.

## Phased plan

| Phase | Ships |
|---|---|
| **P1** | Package + library CRUD (org-admin-gated) + the Discover library filter + collision/RBAC/IDOR tests. |
| **P2** | Org cohorts (0419 binding; consent flow proven unchanged by test) + brand ref. |
| **P3** | k-anonymous reports (floor test-pinned; below-floor withholding). |
| **P4** | Frontend: org-program admin page (library, cohorts, brand pick) + report view; i18n ×4. |
| **P5** | `ctx.features.kicktodo-organizations` reads + node additions (pack bump + pin lockstep); LLM-EXCHANGE row. |

## Implementation record

| Phase | Landed |
|---|---|
| P1 — org libraries (allowlist overlay on the kicktodo-core catalog; idempotent entry set; org-admin `host:org:manage` via the ONE composed gate `authorizeOrgScope`; member reads `manifest:read`) | kicktodo/0428-p1p3 |
| P2 — org cohort links binding EXISTING 0419 cohorts (joining stays 0419's consent flow — a link grants nothing) + brand ref | kicktodo/0428-p1p3 |
| P3 — k-anonymous computed-on-read reports: a NEW counts-only aggregate seam in 0419 (`cohortOutcomeAggregate` — identities never cross the package boundary; the ungated grant read is package-internal + documented), k≥5 ACTIVE floor per cell, below-floor WITHHELD (test-pinned), payload pinned identity-free | kicktodo/0428-p1p3 |
| P4 — Org-programs admin page (`/kicktodo/org-programs`, KickTodo nav group, toggle-gated): org picker, library curation with `aria-pressed` chips + curated/uncurated state stated plainly, k-anonymous report view (withheld cells labeled, never small numbers); i18n ×4; ux-review CLEAR | kicktodo/0428-p4p5 |
| P5 — read-only `ctx.features.kicktodo-organizations` (catalog, report) + `feature.kicktodo.nodes.org-report`; pack **v1.8.0** pin-lockstepped across all six kicktodo consumers (parity-enforced); LLM-EXCHANGE row | kicktodo/0428-p4p5 |

**Correction (2026-07-22, chat-first-port G8):** the `feature.kicktodo.nodes.org-report`
node was **dropped** from the pack (bump `1.21.0 → 1.22.0`, 7 pins repinned). The port
map found it *uncomposed* — no agent allowlisted it and no workflow ran it, so it was an
igniter-less "catalog inventory" node that surfaced the org report a third way with no
consumer. The report itself is **unchanged**: still reachable through the governed REST
route and the `ctx.features['kicktodo-organizations'].report` surface (the service
`orgReport` stays). Re-add the node — allowlisted onto a named org-steward agent (and
confirm it projects into a conversational tool) — only if "ask the org's outcomes in chat"
becomes a real need.

## Feature matrix

1. Package ✔. 2. Toggle `kicktodo-organizations`, **OFF**, `bucketUnit: tenant`, dependsOn `kicktodo-core`, `kicktodo-accountability`. 3. `ctx` surface: P5 reads. 4. Node pack: extends `feature.kicktodo.nodes`. 5. Envelopes: none. 6. Agent pack: none new. 7. Public surface: none. 8. RBAC: library/cohort/brand mutations org-admin-gated through accessControl scopes; reports org-admin-read; participant rows unreachable by construction; fail-closed. 9. Replay/fork: no run coupling. 10. Frontend: an admin surface + Discover composition; no new nav group.

## Alternatives weighed

- **A KickTodo-local org model** — rejected outright: accessControl owns orgs; a second owner is the worst outcome (drift + disagreement).
- **Org membership ⇒ progress visibility** — rejected: violates the PRD §6.6 abstraction rule and 0419's consent law; visibility only ever flows through grants.
- **Stored/materialized reports** — rejected: computed-on-read keeps no aggregate at rest to leak and no staleness to reconcile; revisit only if read cost proves real (falsifiable).

## Open questions

1. k-floor value: 5 chosen (common small-team floor); operators with tiny orgs simply see withheld cells — acceptable? (Recommend yes; configurable floors invite misconfiguration.)
2. pt/es content expansion (same PRD §12 line) is content ops on the existing i18n/CMS lanes — no code decision here; flagged for the operator register.

## RFC verdict

**Host work, no new RFC.** Composes accessControl, 0419, and the brand resolver; nothing on the wire.
