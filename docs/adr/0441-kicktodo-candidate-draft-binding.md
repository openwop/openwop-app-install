# ADR 0441 — KickTodo candidate→draft binding (the TD1 slice that unblocks publication submit)

| | |
|---|---|
| **Status** | **implemented** — 2026-07-19 (unblocks ADR 0437 UX-2.6 submit/complete-publication) |
| **Feature** | Backend candidate-lifecycle binding in the EXISTING `kicktodo-creator` package + the FE submit/approve flow on the candidate workspace. No new toggle, no new package. |
| **RFC verdict** | **Host work, no RFC.** `kicktodo-creator` is host-ext (`/v1/host/openwop-app/kicktodo/creator/*`), not the OpenWOP wire; the candidate record + draft ref are host-ext `DurableCollection` state. Nothing on `/.well-known/openwop`, no run-event, no envelope kind. |
| **Composes** | ADR 0415 (Challenge Factory — the candidate/plan/publish pipeline), ADR 0437 (Creator Studio experience — UX-2.6 gate center), ADR 0414 (`kicktodo-core` — `createDraft`, the single challenge owner) |
| **Relates to** | KTFULL-**TD1** (candidate lifecycle) — this is the *minimal* slice of TD1 needed to unblock the publish flow, not the full projectId/run/release-ref lifecycle. |

---

## 1. Why this exists

ADR 0437's Creator Studio surfaced every phase except the **submit/complete-publication**
sub-affordance of UX-2.6, which stayed honest read-only. The verified reason:
`submitForPublication(tenantId, candidateId, challengeId, challengeVersion, submittedBy)`
(`publishService.ts`) needs a **challenge draft ref**, but `draftFromPlan`
(`planService.ts:184`) called `createDraft()` and returned the draft **without binding
it to any candidate** — `FactoryCandidate` had no draft field, and the `decompose`
surface method took only `{plan, authorSubject}`. So the FE had no way to obtain the
`challengeId/version` to fill the submit call, and per the ADRs' anti-dishonesty law a
submit button the server would refuse must not be shown. That gap is TD1's
"candidate→plan→challenge binding."

## 2. Boundaries audit — what already exists

- **`createDraft` is the ONE challenge owner** (`kicktodo-core/challengeService.ts:139`) — this ADR adds no second draft/challenge store; the candidate gains only a *ref*, not a copy.
- **`creatorService` is the ONE candidate owner** — the binding lives on the candidate row it already owns (`DurableCollection` `kicktodo-candidates`), via a CAS setter mirroring `__setCandidateWithdrawn`.
- **`candidateId` is already threaded through the workflow** (`builtinWorkflows.ts:25` declares it; `:37` feeds it to `plan-generate`) — it was simply not wired into the `decompose` node. This ADR extends the existing thread one node further; it stands up no new workflow.
- **submit/complete-publication routes already exist** (`kicktodo-creator/routes.ts`), gated + separation-of-duties enforced server-side. This ADR does not touch their contract; it only lets the FE reference the bound draft.

## 3. Decision (the `/architect` verdict — Option A: workflow-threaded auto-bind)

Bind the draft to its candidate **at the moment of decomposition**, in the surface method that owns the composition:

1. `FactoryCandidate.draft?: { challengeId, challengeVersion }` — an optional ref, absent until the plan is decomposed.
2. `setCandidateDraft(tenantId, candidateId, challengeId, challengeVersion)` (`creatorService`) — a CAS setter: stamps the ref, advances `state → planned`, refuses a rebind for **terminal** states (`published`/`withdrawn`), idempotent **latest-wins** on re-decompose.
3. The `decompose` surface method (`surface.ts`) forwards `candidateId` (from the node) and calls `setCandidateDraft` after `draftFromPlan`. `candidateId` is now an input of the `decompose` node (`builtinWorkflows.ts`) + the node pack forwards it (`feature.kicktodo.nodes/index.mjs`).
4. `getCandidate` already returns the full record → the FE reads `candidate.draft`.
5. **FE (UX-2.6 gate center):** the workspace shows "Submit for publication" only when a draft ref exists and the candidate is non-terminal → `submit-publication` → on `submitted`, "Approve & publish" (separation of duties) → `complete-publication`. The server re-checks the hard gates (409) and enforces a distinct approver (403); the FE surfaces those honestly and never presents either as bypassable.

**Alternatives weighed:** (B) an explicit REST decompose action needs the transient plan artifact persisted first (more surface, FE doesn't hold the plan); (C) a creator-drafts read + manual selection breaks the "drafts never leak" policy and is error-prone. A wins on single-source-of-truth + `candidateId` already being in scope.

## 4. Invariants

- **Replay/fork:** the `draft` ref is a durable stamp read verbatim, never re-resolved. **Non-determinism — RESOLVED (KT-EXP-8, this batch):** `createDraft` used to mint `chal:${randomUUID()}`, so a re-decompose produced a *different* draft id and orphaned the old row. `draftFromPlan` now derives a **deterministic** id — `chal:ktc-${sha256(tenant|candidateId)}` — passed via a new optional `id?` on `CreateChallengeInput` (the manual-authoring route keeps random ids). So a candidate has exactly ONE draft id: a re-decompose overwrites it — deterministic, and **zero orphans** (supersession moot). The load-bearing guard: `createDraft` **refuses to overwrite a non-draft row** at that id (`status !== 'draft'` ⇒ return the existing frozen row), so a re-decompose can never clobber the immutable PUBLISHED version. Pinned in `kicktodo-creator-plan.test.ts` (same-id idempotency, bare-random fallback, published-immutability guard).
- **Idempotency:** the deterministic id makes re-decompose overwrite the single draft; no orphan hidden rows accumulate.
- **Authz/tenant:** the binding write rides the workflow's own gates and the tenant-keyed CAS; submit/complete stay `gate`+separation-of-duties.

## 5. Implementation record

| Piece | File | Test |
|---|---|---|
| candidate `draft` field + `setCandidateDraft` CAS | `creatorService.ts` | `kicktodo-creator-plan.test.ts` — binding, latest-wins, terminal-safe, null |
| decompose binds via the surface | `surface.ts` | `kicktodo-builtin-workflow-dataflow.test.ts` (unchanged green) |
| `candidateId` wired to the decompose node | `builtinWorkflows.ts` + `packs/feature.kicktodo.nodes/index.mjs` | dataflow test |
| FE submit/approve flow | `kicktodo-studio/CandidateWorkspacePage.tsx` + `kicktodoStudioClient.ts` (`submitPublication`/`completePublication`) | build gate + spine test |

## 6. Open questions

- **OQ1:** the full TD1 (projectId + run/release refs + the linked-Project board) is still open; this ADR is the minimal draft-binding slice. The remaining TD1 surface (ADR 0437 §5 candidate workspace's linked board) stays deferred.
- **OQ2 (B7):** the publication *gate matrix* is still not backed by the full independent evaluations (KTFULL-B7); the gate center shows honest state and submit routes to the approval queue — B7 is what lets the matrix show real green. Not required for the submit mechanics this ADR unblocks.
