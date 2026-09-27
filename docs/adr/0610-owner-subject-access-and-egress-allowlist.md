# ADR 0610 — owner-subject access predicate + routed-egress allowlist

Status: implemented (Phase 1 #3499; Phase 2 #3504; Phase 3 #3515; Phase 4 this PR — all D1–D6 + the SLC-1 collab-lane sibling #3507 shipped)

## Implementation record

| Phase | What | Commit / PR |
|---|---|---|
| **1** — read doors (D1/D2/D3′) | All 5 delinquent read doors over project-owned rows now consult the existing `host/subjectAccess.ts` `resolveSubjectAccess` seam: documents (get/list/versions/locate), canvas (the `loadCanvas` choke threaded through 11 call sites), priority-matrix (`loadListScoped`/`readableLists` **+** the `loadListForRead`/list-lists agent tools), work-selection `readBoardRanking` (threaded `callerSubject`), artifact projection (`authorizeDocument` **+** the Library `listArtifacts`). Closes **WSC-1 / CPC-14 / CPC-15**. Adversarial review caught + closed 2 missed sibling doors (Library list + pm agent tools). 30 tests across 3 witness files, each born-red + sabotage-verified. | **#3499** `b32deac3` |
| **2** — MRC routed-target allowlist (D4) | model-router routed-provider entitlement check at write + dispatch; reconcile ADR 0130 | **#3504** |
| **3** — PMC-1 safe-mode capability class (D5) | safe mode gates the host-mediated egress CLASS (`gateHostMediatedEgress` on the firewall hook, RAW `resolveToolCapability` classification so unclassified reads are not mass-deferred), not a hard-coded name set — a new egress tool is gated the day it ships. Adversarial review caught + closed a `treat-as-risky` over-block. | **#3515** |
| **4** — CDC-2 FE tier alignment (D6) | the chat-deployment console + its two subsumed surfaces (scheduled-agent-chats, chat-widget — both `workspace:write` on the backend, their sole authority) were FE `tier:'admin'`, unreachable by an entitled `workspace:write` non-admin (the admin rail is admin-only: `AdminLayout` rejects non-admins + the Sidebar Admin entry is `isAdminCaller`-gated). FE `tier` is the single knob for rail+layout+access, so the fix RELOCATES all three to the workspace rail: `tier:'workspace'`, `archetype:'standard-index'` (the `admin` archetype means "on the admin rail"), `nav.group:'Workspace'` (`Platform` is admin-only). The #3493 tier-aware tab projection already renders workspace tabs to all. Witness: a non-admin now sees both console tabs (`adr0145-rehoming.test.ts`). FE-only. | **this PR** |
| deferred | **SHR-OWN-1** — sharing user-owned-document mint gate (D3 note) | _backlog_ |


> Architecture-review decision for a batch of grade-loop security findings that
> all share one shape: **a door authorizes on the wrong scope.** Pure host work —
> no OpenWOP wire change (see § RFC assessment). Supersedes nothing; extends
> ADR 0054 (project visibility ≠ authority) and reconciles ADR 0130 (model
> router). Findings: `WSC-1`=`CPC-14`, `CPC-15`, `MRC-2/3`, `PMC-1`, `CDC-2`.

## Context

Four clusters of "gate on the wrong scope" findings, surfaced by the 71-feature
grade loop:

1. **Project-owned rows authorized on ORG scope only (the sharp one —
   `WSC-1`/`CPC-14`/`CPC-15`).** A kanban board (`ownerSubject:{kind:'project',id}`,
   `priorityMatrixService.ts:246`), a priority list, a document, and a canvas can
   all be **project-owned**, but their read/write/share doors gate on org/tenant
   scope and never on **project membership**. So a `private` project's rows are
   readable/mutable by any org member. The canonical rule already exists —
   `resolveProjectAccess(tenantId, projectId, callerSubject) → 'write'|'read'|'none'`
   (`features/projects/projectsService.ts:341`, ADR 0054 D5: WRITE ⟺
   `workspace:write` in the project's org; READ = write ∨ (org-visible ∧ org-read)
   ∨ (`private` ∧ caller is a people-member); fail-closed on unknown) — but the
   doors don't consult it uniformly:
   - `features/work-selection/agentTools.ts:54` `readBoardRanking(tenantId, boardId, now)`
     gates on `board.tenantId` ONLY; its signature carries no `callerSubject`, so it
     **structurally cannot** check membership.
   - `features/priority-matrix/routes.ts:78` `loadListScoped` authorizes on
     `hasOrgScope(list.orgId)` only; the KB projection inherits it
     (`priorityMatrixKnowledgeService.ts:205`).
   - `features/documents/routes.ts:84` (+ `?ownerKind=project&ownerId=` at :39 is an
     enumeration primitive), `features/canvasEditorRoutes.ts:68,90`,
     `features/documents/artifactRoutes.ts:54`→`host/artifactProjection.ts:341`.
   - **Worst — public exfil:** `features/sharing/sharingService.ts:713` refuses to
     mint a public share link only when `ownerSubject.kind==='user'`. A
     `kind:'project'` canvas **falls through** and is mintable by any
     `workspace:write` member — a private project's canvas can be made world-readable.
   - The correct counter-example already shipped: `features/notebooks/routes.ts:108`
     gates through `resolveProjectAccess`.

2. **Model-router routed-target egress (`MRC-2`/`MRC-3`).** Config-write is
   **already** `workspace:write`-gated (`model-router/routes.ts:19,22` — so `MRC-1`'s
   "non-admin editor" framing is **stale**, corrected here). The live gap: **no
   allowlist/catalog on the routed TARGET** — a `workspace:write` user can author a
   rule that routes org prompt data to an arbitrary external vendor on the run's
   existing BYOK `credentialRef`. ADR 0130 matrix #8 claims a `credentialRef`-in-tenant
   validation the shipped schema dropped.

3. **Chat safe-mode (`PMC-1`).** Safe mode gates a hard-coded 4-name tool set, not
   the resolver's egress **class**; host-mediated egress (email/slack/sms/a2a/mcp)
   proceeds UNASKED in safe mode on a default tenant.

4. **Chat-deployment console tier (`CDC-2`).** The FE console is `admin`-tier while
   the two subsumed backend surfaces (scheduled-chats, chat-widgets) require only
   `workspace:write` — an over-restriction (an entitled `workspace:write` non-admin
   cannot reach a surface the backend would serve them), not a leak.

## Decision

### D1 — consult the EXISTING `resolveSubjectAccess` seam; wire the delinquent doors

> **CORRECTION (pre-implementation, 2026-08-28).** The first draft proposed a NEW
> `resolveOwnerSubjectAccess` helper. The boundaries/duplication audit found the
> seam **already exists** and is already the ADR 0054 D5 canonical rule:
> `host/subjectAccess.ts` `resolveSubjectAccess(tenantId, subject, callerSubject)
> → AccessLevel | null` + `levelSatisfies(have, need)`, with a **per-kind resolver
> registry** (`registerSubjectAccessResolver`). Projects registers `'project'`
> (`features/projects/feature.ts:47`, delegating to `resolveProjectAccess`);
> advisory-board registers `'board'`. It returns `null` for a subject that is NOT
> membership/org-scoped ⇒ fall back to the legacy tenant/personal gate. Building a
> second predicate would have been the exact parallel-system anti-pattern this ADR
> is closing. **There is no new helper. The fix is wiring.**

The seam is ALREADY consulted by `routes/kanban.ts`, `features/notebooks/routes.ts`,
`routes/chatSessions.ts`, `routes/scheduler.ts`, `features/kb/*`,
`host/conversationVisibility.ts`, and others. The finding is that **five doors over
the same rows bypass it** (measured — zero `resolveSubjectAccess` references in each):
`features/sharing/sharingService.ts`, `features/work-selection/agentTools.ts`,
`features/priority-matrix/routes.ts`, `features/documents/routes.ts`,
`features/canvasEditorRoutes.ts`. Each must, for a row carrying an `ownerSubject`
(a `Subject` — board `ownerSubject`, canvas/doc `ownerSubject`), call
`resolveSubjectAccess(tenantId, ownerSubject, callerSubject)` and, when the result
is **non-null**, enforce `levelSatisfies(level, need)` for the door's action
(read-door → `'read'`; write/mint-door → `'write'`). A **null** result means the row
is not membership-scoped ⇒ preserve today's org gate unchanged.

**Blast radius bounded:** null-owner rows (org-owned, no `ownerSubject`) behave
IDENTICALLY to today — this tightens only project/user-owned rows. This is the same
technique ADR 0054 used to unify the projects list door + scan; the "two doors, same
rows, opposite answers" class closes structurally by removing the second, seam-less
door — not by adding a predicate.

### D2 — the agent-tool door gets acting-user identity; reports empty, never throws

`readBoardRanking` must take `callerSubject`. The conversation tool loop HAS the
acting user (`registerFeatureAgentTool` tools share their HTTP route's access
predicate per CLAUDE.md); it is dropped at this boundary. Thread it through. When
`board.ownerSubject.kind==='project'`, gate through `resolveSubjectAccess`;
on `'none'` **return `[]`** — consistent with the door's existing fail-closed posture
("return `[]` for unknown OR cross-tenant boards without distinguishing them").
This is the "gate at the one composition owner" + "report the refusal, don't throw
it" lesson: the surface op and the tool both keep calling the one predicate.

### D3 — sharing mint: the REAL gap is the DOCUMENT user-owner check; the project branch is a no-op

> **CORRECTION (pre-implementation, 2026-08-28) — verified against the route gate.**
> The first cut said "a private project's canvas becomes mintable only by a member,
> closing the exfil." **That is a no-op.** The mint route already requires
> `workspace:write` (`sharing/routes.ts:46`), and under ADR 0054 WRITE is
> **org-scoped** — `resolveSubjectAccess` on a `kind:'project'` owner returns
> `'write'` for ANY authorized minter. So the project branch never denies. Making
> mint require project **membership** would *contradict* ADR 0054 (membership never
> grants write); that is a new policy, not this fix. **The project-owner exfil lives
> in the READ doors, not mint** (see D3′). The one REAL mint gap: a **user-owned
> document** (`ownerSubject.kind==='user'`) has **no** owner check — any
> `workspace:write` member can mint a public link to another user's document (the
> DATA-finding-6 class that canvas/conversation already close). **DEFERRED to a
> follow-up** (`SHR-OWN-1`): closing it cleanly needs the approved/final-doc mint
> setup a witness requires (`publicDocumentView` gates mint on approved/final), so
> it is tracked separately rather than shipped untested inside the read-door PR. The
> project branch would be a no-op regardless (write-gated), so nothing security-real
> is deferred — only the user-owned-document owner-only restriction.

### D3′ — the READ doors are the real project-scope leak (the primary Phase-1 fix)

A `private` project's row must be READABLE only by a `workspace:write` holder (org
authority) OR a project member (membership read). `resolveSubjectAccess` returns
`'none'` for a `workspace:read`-only org **non-member** on a private project's owner
subject — but the READ doors gate on `workspace:read` org-scope ONLY, so they leak.
Fix the read doors to consult the seam when the row carries an `ownerSubject`:
`features/documents/routes.ts` (GET), `features/canvasEditorRoutes.ts` (GET),
`features/documents/artifactRoutes.ts`→`host/artifactProjection.ts`,
`features/priority-matrix/routes.ts` (`loadListScoped`), and the
`features/work-selection/agentTools.ts` `readBoardRanking` door (D2). **Build the
born-red witness FIRST** (a workspace:read-only non-member reads a private project's
document → currently 200, must become 404) — a door already denying it is not a leak.

### D4 — model-router routed-target allowlist (host), reconcile ADR 0130

Add a **routed-provider entitlement check**: the routed target MUST be in the
tenant's configured provider catalog (the same catalog BYOK/Connections resolve
against), validated at **rule-write** time (typed failure, not silent drop) AND
re-checked at **dispatch** (defense-in-depth — the app-builder `validate→CAS→
re-verify` shape). Keep the `workspace:write` write-gate. Reconcile ADR 0130
matrix #8 with an inline correction note (restore the intent as an allowlist, not
a dropped `credentialRef` facet). **Host work** — routing config is a
host-extension surface, not the wire.

### D5 — safe-mode gates the egress CLASS, not a name set

Drive the safe-mode confirmation gate from the tool's **capability classification**
(the egress/side-effecting class the resolver already knows) rather than a
hard-coded 4-name set: safe mode requires confirmation for ANY tool whose class is
host-mediated egress. "Gate the class, not the instance." Host work.

### D6 — chat-deployment: backend is authority; align the FE tier to it

Per the CLAUDE.md "backend is authority" invariant, the FE tier must not claim
more than the backend requires. The subsumed surfaces are `workspace:write`; set
the console/tabs tier to `workspace` so an entitled non-admin reaches them, with
the per-surface backend check remaining the sole authority. FE-only. (Interacts
with the ADR 0610-sibling tier-aware projection just merged in #3493 — `workspace`
tier is visible to all, so the projection already handles it once the tier is
corrected.)

## RFC assessment

**None of D1–D6 need an OpenWOP RFC.** All are host authorization policy over
host-internal state and host-extension routes (`/v1/host/openwop-app/*`,
model-router config, tool-gating, FE tiers). No run-event field, capability advert,
event type, endpoint contract, auth/scale profile, or normative MUST changes. The
`resolveProjectAccess` rule is ADR 0054 host policy; principals stay opaque
(RFC 0048). State recorded here so a reviewer does not re-open the RFC gate.

## Implementation plan (ordered by irreversibility / blast radius)

- **Phase 1 — the project-vs-org class (highest blast radius: cross-tenant data +
  public exfil).** (a) NO new helper — the `resolveSubjectAccess` seam exists. (b) Wire the
  **sharing mint** door first (most irreversible). (c) Then the read/write doors:
  documents, canvas, artifact projection, priority-matrix list. (d) Then the
  agent-tool door (thread `callerSubject`, report-empty). Each door gets a
  **route-level** test (authz is only observable at the HTTP boundary) with a
  born-red witness (a non-member is denied a private project's row / a public mint).
  Effort: L.
- **Phase 2 — MRC routed-target allowlist** (write-time + dispatch re-check) +
  ADR 0130 correction note. Effort: M.
- **Phase 3 — PMC-1 safe-mode capability-class gate.** Effort: M.
- **Phase 4 — CDC-2 FE tier alignment.** Effort: S.

Phases are independently shippable behind their own PR + full `npm run ci`. Phase 1
leads because a leaked public share link is the one unrecoverable outcome in the set.

## Open questions / decisions checklist

- [x] D1: RESOLVED — the seam is `host/subjectAccess.ts` `resolveSubjectAccess` (core
      host, not a feature), so the delinquent feature doors import DOWN into core — no
      feature→feature cycle. Projects registers the `'project'` resolver at boot.
- [ ] D2: confirm the tool loop exposes the acting subject to `registerFeatureAgentTool`
      handlers (it must, per the shared-predicate rule) so `readBoardRanking` can receive it.
- [ ] D4: locate the tenant provider catalog the allowlist reads (BYOK/Connections
      resolver) and whether the routed target is a provider id or a model id.
- [x] D5: RESOLVED (#3515) — the safe-mode gate is `SENSITIVE_APPROVAL_TOOLS` in
      `firewallHook.ts`; the resolver (`toolCapabilityResolver.ts`) exposes `egress` on the
      RFC 0078 descriptor. Gated on the RAW classification (no `treat-as-risky` fallback) so
      unclassified reads are not mass-deferred.
- [x] D6: RESOLVED (this PR) — no security reason. ADR 0145 grouped these under `Platform`
      as a pure INFORMATION-ARCHITECTURE declutter ("The pain is purely information
      architecture"), not a security decision; the backend surfaces are `workspace:write`
      (their sole authority). Relocated to the workspace rail.

## Implementation record

_(phase → commit/test table, filled as phases land)_
