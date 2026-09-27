# KickTodo Organizations (unit G8) — chat-first port review

**Scope (single-feature mode):** backend `backend/typescript/src/features/kicktodo-organizations`; frontend `frontend/react/src/features/kicktodo-admin` + `frontend/react/src/features/kicktodo-org-programs`.

**Headline:** This unit already rides the engine. It is an **org-admin configuration + read-projection + operator-console** surface with **no agents, no workflows, and no model output of its own** — so there is essentially nothing to port *into* chat. Its one human-decision surface (the Safety inbox) correctly composes the ONE shared review store. The only real findings are (a) a declared composable node with **no igniter or agent** (uncomposed catalog inventory), and (b) two governed REST capabilities (cohort-link, brand ref) that have **no in-app surface at all**. No PARALLEL architecture found; nothing to demolish.

---

## Step 1 — Contract scouting (pinned evidence)

**The feature declares zero orchestration.** `kicktodo-organizations/feature.ts:11-27` registers only `registerRoutes` + a read-only `surface`; there is **no `registerAgent`, no `WorkflowDefinition`, no `registerFeatureAgentTool`, no `startWorkflowRun`** anywhere in the package (grep of the package dir returned empty). It is a REST config feature composing three owners it correctly rides:
- Orgs/members → `accessControl` (rows keyed by its `orgId`, never a second org model) — `orgProgramService.ts:29-32` (`${tenantId}::${orgId}` keys), documented `orgProgramService.ts:1-12`.
- Cohorts → the ADR 0419 primitive; the link stores only a `circleId` and re-resolves through `getCohortDetail` / `resolveCircleByOpaqueId` (`orgProgramService.ts:114-133`), never a second cohort entity.
- Catalog → `kicktodo-core` `listPublished` as a curation overlay (`orgProgramService.ts:94-110`).

**Authorization is a single composed predicate, route-shared.** Every mutation goes through `authorizeOrgScope(req, FEATURE, 'host:org:manage')`; reads through `'manifest:read'` (`routes.ts:43,54,72,80,93,109,117,132`). Consent is **re-verified on every read** of the report, not just at link time (`orgProgramService.ts:193-200`, the ARCH-M5 fix), and link/unlink are ownership-symmetric (`orgProgramService.ts:122-128,146-158`). This is a clean authority story.

**There is a composable node that reads the feature surface, but no one runs it.** `packs/feature.kicktodo.nodes/pack.json:215-218` declares `feature.kicktodo.nodes.org-report`, backed by `packs/feature.kicktodo.nodes/index.mjs:356-373` reading `ctx.features['kicktodo-organizations'].report` (surface built at `surface.ts:11-17`). **No agent allowlists this node** (grep of `feature.kicktodo.agents/pack.json` for `org-report`/`nodes.` = empty; the pack's nine agents are all authoring/accountability personas, `pack.json:24-175`) and **no workflow creates runs of it**. So the node is uncomposed catalog inventory: available to a workflow author, ignited by nobody.

**Cross-cutting drop pattern (lead's note): N/A here, verified.** The "toolAllowlist lists a node typeId that is never projected → silently dropped at dispatch" failure requires an agent that *lists* the node. **No agent in this unit lists `org-report` (or any org node),** so nothing is dropped and no model is lied to. Stated explicitly because its absence is the finding.

**Two backend capabilities have no surface.** The cohort link/unlink routes (`routes.ts:69-104`) and brand get/set routes (`routes.ts:105-126`) are governed and correct, but the only FE consumer — `OrgProgramsPage.tsx` — surfaces **only** library-curation + the report (`OrgProgramsPage.tsx:32-42,110-154`). `kicktodoOrgClient.ts` exposes only `getOrgLibrary`/`setOrgLibraryEntry`/`getOrgReport`. Cohort-linking and branding are reachable only by calling the API directly.

**Executor/chassis constraints on any future port:** none introduced by this unit — it owns no runs, no gates, no canvas. A future chat port would ride the *existing* KickTodo agents pack + node catalog, not new machinery.

---

## Step 2–3 — Capability inventory, verdicts, port tests

| # | Capability | Today | Verdict | Port target / note |
|---|---|---|---|---|
| 1 | Curate org challenge library (allowlist overlay) | `OrgProgramsPage.tsx:110-130` toggle chips → `POST /library` (`routes.ts:52-67`) | **PAGE-LEGIT** | Config editing over a known catalog; honest curated/uncurated read (`surface`→`libraryCatalog` `orgProgramService.ts:94-110`). Optional agent-tool overlay noted, not required. |
| 2 | Read k-anonymous org outcome report | `OrgProgramsPage.tsx:132-154`; `orgReport` `orgProgramService.ts:187-218` | **PAGE-LEGIT** | Read-only reporting; withheld cells shown as withheld (`OrgProgramsPage.tsx:148-150`), computed-on-read from the 0419 aggregate, k≥5 floor. Honesty loop closes. |
| 3 | Link / unlink org cohort | REST only (`routes.ts:69-104`), **no FE surface** | **ADAPTER** | Thin governed wrapper over the 0419 cohort owner; ownership-gated + consent re-verified. Correct — but has no igniter (no UI, no agent). Deferred-honestly below. |
| 4 | Set / get org brand ref | REST only (`routes.ts:105-126`), **no FE surface** | **ADAPTER** | Stores only an org→brand-profile reference over the brand resolver (`orgProgramService.ts:164-172`); never CSS/assets. No igniter. Deferred-honestly below. |
| 5 | Safety & approvals inbox | `SafetyInboxPage.tsx:20-79` | **RIDES** | Composes the ONE shared review store `useReviewStatusStore` + `ReviewCard` (`SafetyInboxPage.tsx:20-21,73`), filtered to KickTodo `kind`s (`kicktodoReviewKinds.ts:10-14`). Explicitly **not** a parallel queue; authority server-enforced (honest note `SafetyInboxPage.tsx:55-57`). Textbook RIDES. |
| 6 | Admin overview + Exception Ledger | `AdminOverviewPage.tsx:38-158` | **PAGE-LEGIT** | Read projection (`listExceptions`, ADR 0460) + deep-links; degraded sources surfaced, never painted green (`AdminOverviewPage.tsx:73-77`). Honest deferral notes (`:153-157`). |
| 7 | Catalog & content-health lens | `CatalogHealthPage.tsx:21-124` | **PAGE-LEGIT** | Composes existing reads (`getFactory` + `listChallenges`); floored cells render "withheld" (`:97-100`). |
| 8 | Audit & metrics lens | `AuditMetricsPage.tsx:22-90` | **PAGE-LEGIT** | Verifier-quality read + link to the owned `/audit-log`; disagreement rate marked "indicative, not audited" when unsampled (`:70-74`). |
| 9 | AI & connections status | `AiConnectionsPage.tsx:19-77` | **PAGE-LEGIT** | Reads REAL calendar transport state; "awaiting adapter" is the honest default, "connected" only when truly wired (`:54-62`). Model honesty loop closes. |
| 10 | Commerce reconcile + payout runs | `AdminCommercePage.tsx:42-259` | **ADAPTER** | Composes the existing admin reconcile + seat client + ADR 0445 payout runs; money truth stays the server order-row CAS (`:254-256`), operator only triggers/reports; no second money path. Results reported honestly (scanned-vs-repaired, post-state not fabricated deltas `:166-168`). |
| 11 | `org-report` composable node | `pack.json:215-218` + `index.mjs:356-373` | **THEATER** (low severity) | Declared node reading the feature surface, but **no agent allowlists it and no workflow runs it** — an uncomposed catalog entry. Not a lie to any model (nothing dispatches it), but a capability surfaced a third way with no user. Ignite-or-note (see deferred). |

**Port tests, applied where they bite:**
- **Interface test:** every user action here is *structural config editing* (allowlist toggle, brand ref) or *reading* (reports, health, audit) or *deciding* (Safety inbox). None is "describe intent," so none demands a conversation. The Safety decision correctly lands as an interrupt/review card, not chat prose.
- **Agency test:** no agent exists in this unit → nothing to fail. (The unit's PAGE surfaces do not need one.)
- **Ignition test:** the only declared runnable (`org-report` node) has **no igniter** → the lone THEATER finding (#11).
- **HITL test:** the one human checkpoint (safety/publish/community/seller approvals) rides the shared review machinery with durable decision records — passes (#5). No bespoke approve/submit button duplicating it.
- **Honesty-loop test:** every displayed state is backed by a real read (calendar transport #9, verifier sample #8, k-floor #2/#7, degraded sources #6). No painted-green surface found.
- **Authority-parity test:** routes + reads share `authorizeOrgScope` / `manifest:read` (`routes.ts`); admin pages gate on `<AdminLayout>`/`isAdminCaller` and the backend re-enforces (`SafetyInboxPage.tsx:11-13`). No forgotten chassis surface (this unit exposes no canvas/collab/export).
- **Card-mechanism test:** the Safety inbox uses the **typed `ReviewCard`** for app-known, i18n-critical decision kinds — the correct pick; no A2UI misuse, no bespoke second renderer.

---

## Blockers (from scouting) — each with the honest alternative

**None that block a port** — because there is no chat capability here to port. The two scouting facts worth recording as constraints:

1. **Assumption "the org node proves org data is chat-drivable" fails.** `org-report` is declared but **no agent lists it and no workflow runs it** (`feature.kicktodo.agents/pack.json` grep empty). Honest alternative if org reporting should ever be conversational: add the node to a named KickTodo org-steward agent's `toolAllowlist` **and** confirm it projects into a conversational tool (else it is dropped at dispatch) — but only if a real "ask the org's outcomes in chat" need exists. Today, don't: the page path is the honest surface.
2. **Assumption "cohort-link / branding are complete capabilities" fails at the UI layer.** The routes are governed and correct, but there is no FE and no agent tool. Honest alternative: either surface them on `OrgProgramsPage` (structural editors, PAGE-LEGIT) or delete the routes if unused — do not leave them as reachable-only-by-curl indefinitely.

---

## Demolition list (with regression pins)

**Empty.** No PARALLEL surface, no bespoke approvals queue, no fake "talk to AI" panel, no shadow owner. The Safety inbox is the surface most at risk of being a parallel queue and it is not — it composes `reviewStatusStore` + `ReviewCard`. The existing pin to preserve: `kicktodoReviewKinds.test.ts` keeps the filter unit-pinned to the real backend kinds (`kicktodoReviewKinds.ts:1-9`); any regression that re-forks a KickTodo-local queue would have to bypass that store. Recommend keeping that test as the standing guard.

---

## New-code inventory

**None required.** A verdict-driven port of this unit produces zero new tools, nodes, workflows, or reads. The only *optional* items, both deferred:
- (if org reporting is ever wanted in chat) one line adding `org-report` to a named org-steward agent's allowlist + a projection assertion — **not** recommended without a real need.
- (if cohort-link/branding should be operable) small structural editors on `OrgProgramsPage` reusing the existing client + routes — no backend work.

---

## Phased plan

There is no port to phase. The honest close-out actions (all optional, none blocking, each its own tiny PR):

1. **Resolve the uncomposed `org-report` node (#11).** Decide: allowlist it onto a named agent (only with a real chat need) **or** drop the node from the pack and keep the REST→page path as the single reporting surface. Gate: `grade-node-packs` parity (a node no surface/agent consumes is a coverage smell). Close with `/code-review`.
2. **Close the surface-less capabilities (#3, #4).** Either add the structural editors to `OrgProgramsPage` or remove the unused routes. Gate: frontend `npm run build` + i18n 4-locale parity. Close with `/ux-review`.

Neither phase demolishes anything; both are additive/subtractive housekeeping.

---

## Deferred honestly

- **Org cohort link/unlink has no in-app surface** (`routes.ts:69-104`) — a governed REST capability reachable only by direct API call. Stated, not faked.
- **Org branding ref has no in-app surface** (`routes.ts:105-126`) — same.
- **`feature.kicktodo.nodes.org-report` is an uncomposed node** (`pack.json:215`) — declared, ignited by nobody; not chat-drivable and not claimed to be.
- **No chat/agent expression of org programs exists, by design today.** If the product later wants "curate the Sales org's library" or "how are our cohorts doing" as conversation, that is a *future* agent-pack addition riding the existing KickTodo nodes — recorded here as a possibility, not a gap being papered over.
