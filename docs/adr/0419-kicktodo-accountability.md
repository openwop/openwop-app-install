# ADR 0419 — `kicktodo-accountability`: consensual, graduated accountability (partner / circle / cohort / coach)

Status: **implemented** — P1–P5 landed 2026-07-18 (phase record at the end of this file); activation stays Wave-2-gated (toggle OFF)

**Requirements source:** `docs/kicktodo-prd.md` §4.5, §6.6, §8.5.3, §10, §12 Wave 2 (the F1 gate in `docs/kicktodo-implementation-plan.md`).
**Depends on:** ADR 0414 (`kicktodo-core` — enrollments/progress are what gets shared), the conversation owner (RFC 0005; `host/conversationStore.ts` + `conversationVisibility.ts`), notifications (ADR 0010), consent, access control (ADR 0006/0015).
**Surface:** host-extension `/v1/host/openwop-app/kicktodo/circles/*` + `/kicktodo/coach/*` (inside the ONE KickTodo prefix; route tables join the collision-test union). **NO new RFC** (see verdict).

## Why this exists

Accountability is KickTodo's Wave-2 differentiator and its highest-risk privacy surface. The PRD's contract: **consensual and graduated** (five levels: personal → partner → circle → cohort → coach), scope-explicit invitations, immediate revocation, and NEVER an org-membership alias — a friend seeing one challenge must not become a workspace member (PRD §6.6: "Adding a friend to an organization would grant a much broader relationship and is therefore the wrong abstraction").

## Boundaries audit (Step 3 — verified against live code)

- **Membership model exists but is SAME-TENANT:** `ConversationMeta.participants[]` with `subjectRef` checks (`conversationVisibility.ts:34,39,53`) authorize within the caller's active tenant; the generic chat routes resolve storage from the caller's tenant. **A cross-workspace circle does not work today** — exactly the PRD §6.6 finding. The net-new seam is the **resource-conversation binding**: resolve the circle's OWNING tenant from the opaque circle id, prove the caller's LIVE grant, then call the existing conversation store/service under that tenant. The generic chat API is NOT weakened to accept client-supplied tenant ids (test-enforced).
- **Grants are NOT `accessControl` orgs/members:** `accessControlService` owns workspace membership (roles, ≥1-owner invariants) — a deliberately heavier relationship. `AccountabilityGrant` is a PRODUCT resource (field-scoped, revocable, per-enrollment); composing accessControl here would be the orgs↔accessControl cautionary tale in reverse. Single owner: `kicktodo-accountability` owns circles/grants; conversation transcripts stay with the conversation owner (KickTodo stores `conversationId` only — PRD §9.7).
- **Progress projections already exist:** `progressFor` (ADR 0414 C3) is the rebuildable source; the accountability projection is a **field-allowlist filter over it** (PRD §10.2: "generated from a field allowlist, not by asking a model to 'remove sensitive information'"). Check-ins/journals are excluded by default; `note` text requires the explicit `check-in-note` scope.
- **Notifications:** the emit seam (`getNotificationEmitter`) handles nudges/digests; no delivery ledger here.
- **Route namespace:** no existing `/kicktodo/circles` or `/kicktodo/coach` registrant; tables join `ALL_KICKTODO_ROUTE_TABLES`.

## Decision + data model

New feature package `src/features/kicktodo-accountability/` owning (PRD §6.6):

```text
AccountabilityCircle
  id, tenantId (the OWNING tenant), enrollmentId|cohortId, ownerSubject
  type: partner|circle|cohort|coach
  members[]: { subjectRef (opaque {kind,id} — never email/auth identity), roleLabel, status: invited|active|revoked }
  conversationId          -> the conversation owner's id, resource-bound (below)

AccountabilityGrant
  id, tenantId, circleId, enrollmentId, grantorSubject, granteeSubject
  scopes[]: progress-summary|action-status|check-in-note|message|coach-plan-proposal
  invitedAt, acceptedAt?, expiresAt?, revokedAt?
```

**The resource-conversation binding seam (the load-bearing piece):** a new host helper `resolveCircleConversation(circleId, caller)` → looks up the circle by opaque id across an id-keyed index (NOT tenant-scoped input), verifies a LIVE grant for the caller (`revokedAt` absent, not expired — checked on EVERY read, never frozen into a run), then returns `{owningTenant, conversationId}` for the existing conversation service to operate under. Uniform 404 for non-members (no existence oracle). Generic chat routes are untouched; a route-level test proves a foreign-tenant caller cannot reach the circle conversation through `/chat/*` directly.

**Privacy projection:** `projectProgressForGrant(grant, progress)` — a pure allowlist mapper (scopes → fields); journal text and measured values are NEVER in `progress-summary`/`action-status`. Revocation is immediate: the projection re-reads the grant per request.

**Coach flows:** a coach is a grantee with the `coach-plan-proposal` scope; proposals are INERT records the participant applies through the existing `applyPlanRevision` path (ADR 0414) — a coach never mutates a plan directly (PRD §13).

## Phased plan

| Phase | Ships |
|---|---|
| **P1** | Package + circles/grants CRUD (invite → accept → revoke; scope disclosure in the invitation payload); the binding seam + uniform-404 tests; generic-chat-unweakened test. |
| **P2** | Privacy projections (allowlist mapper, per-scope tests incl. journal-exclusion); partner/circle feeds; notification emits (nudge, weekly digest) behind quiet-hours prefs. |
| **P3** | Cohorts (time-bounded, capacity, one pinned challenge version) + coach console (caseload = grants held; flags from progress thresholds); coach plan-proposals (inert → participant applies). |
| **P4 (core-app extension surface)** | `ctx.features.kicktodo-accountability` (list/project/propose — read + propose only; grant WRITES stay route-level with the acting participant); `feature.kicktodo.nodes` additions (`accountability-summary` — the Steward skill's grounding); the Accountability Steward handoff skill joins `feature.kicktodo.agents` (scratchpad-only; may never expand grants — PRD §8.5.2). LLM-EXCHANGE row + parity tests. |
| **P5** | Web surfaces: Circle tab on Today, invitation accept page (public-ish: token-gated, uniform 404), coach console page; i18n ×4; manual-test suite cases. |

## Implementation record (phase → PR)

| Phase | Landed |
|---|---|
| P1 — circles/grants (`circleService.ts`: product-resource grants, LIVE-checked on every read; scope subsets only; owner-or-self revocation, immediate); **the binding seam** (`resolveCircleConversation`: opaque-id → owning-tenant pointer → live grant proof → conversation handle; the owning tenant is never accepted from or returned to the client); routes under `/kicktodo/circles/*` incl. the seam's HTTP face; uniform-404 everywhere. **Live catch:** the generic-chat-unweakened tripwire found that an UNOWNED conversation is tenant-visible (`conversationVisibility.ts` legacy posture) — the circle conversation is now created OWNED by the circle owner, so the whole workspace cannot read circle chat; access flows only through the seam (test-pinned) | kicktodo/0419-p1-circles |
| P2 — privacy projections + feed + nudge (`projectionService.ts`: `projectFields` — the PURE field-allowlist mapper, unit-tested per scope; floors that hold under EVERY scope: measured values never project, instructions never project, journal notes only under explicit `check-in-note`; the live feed re-reads the grant per request — revocation bites immediately; content-free nudges require the `message` scope and ride the centralized notification owner) | kicktodo/0419-p2-projections |
| P3 — cohorts + coach console + inert proposals (`cohortService.ts`: cohort detail pins ONE challenge version with EXACT CAS capacity — the third join into a 2-seat cohort is refused, test-pinned; the coach caseload resolves cross-workspace through a grantee-keyed pointer index with LIVE grant + `coach-plan-proposal` scope checks and a deterministic zero-progress flag; proposals are INERT — only the participant applies (via the ADR 0414 `applyPlanRevision` supersession path, revision bump test-pinned) or dismisses; a coach can never mutate a plan) | kicktodo/0419-p3-cohorts |
| P4 — extension surface (`ctx.features.kicktodo-accountability` — READ + PROPOSE only, grant writes stay route-level with the acting participant; `openwop:kicktodo.circles` chat tool — fail-empty, pre-projected feeds; `feature.kicktodo.nodes` v1.3.0 `accountability-summary` node; the Accountability Steward handoff skill in `feature.kicktodo.agents` v1.1.0 — scratchpad-only, drafts only, its prompt explicitly refuses out-of-scope inclusion and names the missing scope; pins bumped in lockstep across all three pinning features; LLM-EXCHANGE row updated; all parity sweeps green) | kicktodo/0419-p4-surface |
| P5 — web surface (`features/kicktodo-circles/`: create-from-enrollment, scope-explicit invitations — the chip toggles ARE the disclosure, aria-pressed; instant revocation; the "What they see" projected-feed preview shows the owner exactly what members see; loading + designed empty states; 4-locale i18n; nav under the KickTodo group gated on the accountability toggle; React-free `kicktodoCirclesClient.ts`) | kicktodo/0419-p5-web |

## Feature matrix

1. Package ✔ `src/features/kicktodo-accountability/`. 2. Toggle `kicktodo-accountability`, **OFF**, `bucketUnit: tenant` (a shared social surface). 3. Workflow surface: read/propose only (P4). 4. Node pack: extends `feature.kicktodo.nodes` (version bump + pin lockstep). 5. Envelopes: none (a `kicktodo.*` envelope kind would trigger an RFC — PRD §17). 6. Agent pack: Accountability Steward handoff skill (extends `feature.kicktodo.agents`). 7. Public surface: the invitation-accept token route only — `PUBLIC_PATH_PREFIXES` entry, tenant derived from the TOKEN's circle (never the request), single-use, uniform 404, rate-limited. 8. RBAC: every mutation route-gated (toggle + acting subject); grants checked LIVE; IDOR via opaque-id resolution + uniform 404; grantees cannot reshare/broaden (server-side scope subset check). 9. Replay/fork: accountability access is deliberately NOT frozen into runs (PRD §8.7 — revocation must bite immediately); notification emits are idempotent per (grant, digest-window). 10. Frontend: `kicktodoAccountabilityClient.ts` + pages; nav under the KickTodo group gated on the toggle.

## Alternatives weighed

- **Grants as accessControl org membership** — rejected (PRD §6.6): grossly over-broad; workspace membership grants nav/data far beyond one challenge.
- **A second transcript store for circle chat** — rejected: the conversation owner stays single (PRD §9.7); the binding seam is the entire novelty.
- **Freezing grant state into runs for replay purity** — rejected: revocation must be immediate (PRD §8.7 names accountability access as the live-checked exception).

## PRD-vs-architecture corrections

- The PRD's "resource ACL" is realized as product-resource grants + the binding seam over the EXISTING conversation owner — no new ACL engine; `conversationVisibility` gains one resource-bound entry point rather than a parallel authorizer.
- Cohort "project" composition (PRD §8.5.3) stays optional operator tooling (the existing Projects feature); the cohort RESOURCE here never becomes a project automatically.

## Open questions

1. Wave-2 coach model: one operator tenant vs cross-tenant professionals (PRD §19 Q5) — the seam supports both; onboarding/moderation differ. Recommend: operator-tenant coaches first.
2. Default partner scope: recommend `action-status` only (PRD §19 Q4's recommendation) — confirm at P2.
3. Invitation token TTL + single-use semantics (recommend 7 days, single-accept, revocable pre-accept).

## RFC verdict

**Host-ext, no RFC.** All resources and the binding seam are host-private; the conversation wire behavior (RFC 0005) is composed, not extended. The PRD §17 trigger — cross-HOST accountability membership semantics — stays out of scope; if two OpenWOP hosts ever need to share a circle, that is a new RFC first.

## Correction note (2026-07-19) — a grant is not a seat

An architect review of the KTFULL-B12 remediation surfaced an ambiguity this
ADR left open: it models GRANTS (access to a circle, with scopes) and cohort
CAPACITY (`seatsTaken`) without ever saying whether one implies the other. A
repair function written against this ADR reasonably assumed active grants were
the occupancy set, and was wrong — the generic accept route (`POST
/kicktodo/circles/:id/accept`) grants access to coaches and invitees who never
claim a seat, and lets an invitee bypass `joinCohort` entirely.

**The rule, stated explicitly:** a grant conveys ACCESS; a seat is a CAPACITY
claim; neither implies the other. Occupancy is recorded in its own
`kicktodo-cohort-seats` ledger (ADR 0431's correction note), and any derivation
must intersect that ledger with live access rather than substitute one for the
other.
