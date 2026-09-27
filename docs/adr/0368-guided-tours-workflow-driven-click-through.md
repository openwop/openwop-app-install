# ADR 0368 — Guided Tours: workflow-driven, watchable click-through automation

> **Terminology (2026-07-16, ADR 0376):** "tour" is now called **"walkthrough"** in
> source (files, symbols, components, i18n keys, the `/walkthroughs` route). The
> persisted ids this ADR names remain accurate as the PRE-migration values
> (`ui.tour.step`/`ui.tour.checkpoint` node types, the `tour-step` interrupt kind,
> the `guided-tours` toggle, `tour.campaign-studio.first-brief`) — ADR 0376 tracks
> their migration to `walkthrough*` values with back-compat aliases. This ADR is
> not rewritten; read "tour" as "walkthrough".

Status: implemented (Phases 1–6, 2026-07-15/16). P6d shipped as a READ-only
`ctx.features.guidedTours` surface, NOT the originally-named `ctx.guidedTours.launch`
(dishonest — a run has no live player; see the P6d correction note at matrix row 3).

| Phase | PR | Landed |
|---|---|---|
| 1 step nodes + action registry | #1847 | ui.tour.step/checkpoint, tour-step kind, notification suppression, /test-runner audit correction |
| 2 player core | #1848 | perform/resolve loop, HITL wait, needs-update honesty, sessionStorage re-attach |
| 3 player chrome | #1849 | scrim/cutout, gliding cursor, caption bar, reduced-motion, a11y |
| 4 reference tour + /test Play | #1852 + #1853 | Campaign Studio brief tour (real HITL + checkpoint), data-tour anchors, coverage pin, entry-budget hotfix |
| 5 progress + headless replay | (this PR) | progress rows + resume-or-restart + completed chip, TOUR_E2E replay harness |
| 6 record-mode + Tour Author + ctx surface | 6a #1872 · 6b #1873 · 6c #1875 · 6d (this PR) | 6a recorder engine (registry reverse-lookup, anti-rot, no input values); 6b record→transient-draft→promote MVP (no AI); 6c `tours.register-draft` agent tool driven through the ONE chat (composerSeed handoff) — LLM enriches narration/HITL/checkpoints. 6d **READ-only `ctx.features.guidedTours`** (`listTours` + tenant-level `tourProgress`) — the honest replacement for `ctx.guidedTours.launch` (a run can't launch a tour; it CAN read tour state to gate a branch) |
Date: 2026-07-15
Feature: `guided-tours` (new feature package + toggle)
RFC verdict: **host work only — rides already-Accepted wire (runs, run events, interrupts); NO new RFC.**

## Why this exists

Multi-step product flows (the motivating example: setting up a campaign in
Campaign Studio — brief → personas → channels → campaign) are hard to learn by
reading and expensive to demo by hand. The proposal (in-conversation PRD,
2026-07-15): the user presses **Play** and the app *drives itself* through the
real flow while they watch — an animated cursor performs each click, a caption
narrates, and the run **pauses for human-in-the-loop steps** (choose a file,
name the brief) then resumes when the user acts. The same scripts double as
executable specs: a headless runner can replay them as end-to-end tests.

The load-bearing design choice, taken from the PRD and confirmed by this
repo's own law (no parallel orchestration): **the backend engine for a tour is
the OpenWOP workflow engine itself.** Each UI step is a workflow node; pause,
resume, durability, history, and HITL all come from primitives the app already
ships instead of a bespoke frontend tour state machine.

## Boundaries & pre-existing-surface audit (mandatory, ADR 0001 discipline)

- **Route namespace** — `grep -rn "guided-tours" backend/typescript/src` → no
  registrant; `/v1/host/openwop-app/guided-tours/*` is unclaimed. 103 feature
  packages checked; no concept collision.
- **Orchestration owner** — the workflow engine + run store own sequencing,
  suspension, and resumption. Tours are **ordinary workflow definitions**, not
  a new entity: authored/shipped like every other chain via the `tmpl.*`
  template-pack pipeline (ADR 0032 Phase 2.0; `host/exampleWorkflows.ts:49`)
  and the ADR 0190 gallery. This feature adds **no second workflow store**.
- **HITL owner** — interrupts. The FE already resolves them:
  `frontend/react/src/client/interruptsClient.ts:16` (`resolveByRun(runId,
  nodeId, {resumeValue})`), built for the chat's interrupt cards. The tour
  player reuses this client verbatim.
- **Known hazard: interrupt-card scoping.** The chat renders open interrupts
  as cards keyed `interrupt.<kind>` (`chat/a2ui/interruptBridge.ts:4`). Tour
  steps raise interrupts on runs the *player* owns; those MUST NOT surface as
  chat cards. Mitigation (§Data model): tour runs are stamped
  `run.metadata.guidedTour = true` at creation, and the tour interrupt kind is
  namespaced (`tour-step`); the chat's card registry does not register a
  `tour-step` renderer, and the player subscribes only to runs it launched.
  Test-pinned in Phase 1.
- **Helper reuse** — `featureRoute` (`requireFeatureEnabled`, org scoping),
  `streamsClient` SSE (direct `*.run.app` posture), `DurableCollection` for
  the tiny progress store, the ADR 0292 demo seeders for sandbox data
  contexts. Run creation goes through the existing runs surface — the feature
  adds **no parallel run-launch path**, only a catalog + guardrail wrapper.
- **Capability honesty** — nothing new advertised at `/.well-known/openwop`.
  Tours consume capabilities (runs, interrupts) the host already advertises
  and honors.

## Decision

One new feature package, `src/features/guided-tours/` + `frontend/react/src/
features/guided-tours/`, toggle `guided-tours` (default OFF, `bucketUnit:
tenant`, category `Platform`, salt `guided-tours`), plus one **chassis seam**
in the frontend: the **UI action registry**.

### The step contract (ONE mechanism for scripted and HITL steps)

Every tour step is a node from the `feature.guided-tours.nodes` pack that
raises an interrupt and waits:

```
ui.tour.step {
  actionId:  'campaign-studio.new-brief.click',   // semantic, registry-resolved
  narration: i18n key — the caption the player shows,
  hitl:      false | { prompt: i18n key },         // true ⇒ only the USER resolves
  prefill?:  Record<string, unknown>               // e.g. demo text typed into a field
}
```

- **Scripted step** (`hitl: false`): the player navigates/highlights/animates
  a cursor to the action's element, performs the verb (click / fill / select),
  then resolves the interrupt. Resume value: `{ acked: true, actionId }`.
- **HITL step** (`hitl: {...}`): the player spotlights the control, shows the
  prompt, and *stops driving*. The interrupt resolves only when the real user
  acts (the registry action reports completion — e.g. the file input fired).
  Resume value carries what the user did (never file contents — a media ref).
  Browsers require a user gesture for file pickers anyway; platform constraint
  and design agree.
- **Checkpoint step** (`ui.tour.checkpoint`): a server-side read (through the
  feature's own service, tenant-scoped) asserting expected state ("a brief now
  exists") so a diverged tour fails honestly instead of clicking into the
  wrong screen.

Pause/resume/reload fall out for free: an unresolved interrupt IS the paused
state; the run is durable; the player re-attaches by `runId` (kept in
`sessionStorage`) after a reload and continues from the open interrupt.

### The UI action registry (chassis seam — the anti-fragility decision)

Workflow payloads never contain CSS selectors. Features register **semantic
actions** in `frontend/react/src/tours/actionRegistry.ts`:

```
registerTourAction('campaign-studio.new-brief.click', {
  route: '/campaign-studio',
  resolve: () => /* element ref */, verb: 'click',
  hitlComplete?: (signal) => …   // for HITL actions: what "done" means
});
```

The registry drives both the spotlight geometry and the action execution, so
a UI refactor moves the registration alongside the component it targets, and a
test pins that **every actionId referenced by a shipped tour exists in the
registry** (the same convention-pinning pattern as the ADR 0190 catalog).
Second-order win: a tour script is an executable spec — Phase 5 replays the
same tours headlessly under Playwright as e2e coverage.

**Coverage correction (2026-07-15).** The P1 claim was vacuous until Phase 4
shipped the first tour (`tour.campaign-studio.first-brief`); and even then a
hand-maintained mirror list in the FE test could drift silently from the tour
definition (proving a proxy, not the feature). Closed by a THREE-part
tripwire, no half vacuous: (1) `backend/test/guided-tours-coverage.test.ts`
DERIVES the referenced ids from the shipped tour DEFINITION and pins them to a
canonical set + well-formedness (any def edit fails default CI); (2)
`frontend/.../tourCoverage.test.ts` derives from ONE exported canonical const
(`CAMPAIGN_STUDIO_TOUR_ACTION_IDS`) — no hand-mirror — and pins the FE
registration resolves EXACTLY that set (missing or orphan both fail); (3) the
opt-in `TOUR_E2E` replay runs the real tour, the true cross-half guard (the
registry actually resolves them at runtime). Backend pins WHAT is referenced,
FE pins the registry HAS them, e2e pins they RESOLVE live.

### Data model

| Store | Owner | Shape |
|---|---|---|
| Tour definitions | existing workflow/template store (`tmpl.*` pack) | ordinary workflow defs tagged `tour`, steps = `ui.tour.step` nodes |
| Tour runs | existing run store | ordinary runs; `run.metadata.guidedTour = true`, `run.metadata.tourId` stamped at creation (replay/fork-safe — read verbatim, never re-resolved) |
| Progress | NEW `DurableCollection('guided-tour-progress', …)` keyed `tenantId:tourId` | `{ status: 'started'|'completed', runId, updatedAt }` — powers "resume where you left off" + completion badges |

All user input made during HITL steps lands in interrupt **resume values** —
i.e. in the run's event log — so a tour run replays deterministically by
construction (the non-determinism is carried in the payload, per replay.md).

### Safety & data context

Tours drive REAL actions as the REAL user (server-side authz is completely
unchanged — the run only sequences; every mutation still flows through the
normal authed routes with the user's session). Guardrails:

- Launch surface labels tours that create data; default context is the
  current workspace with tour-created artifacts named recognizably
  (`"[Tour] …"`), and the launch card offers the demo workspace where the
  ADR 0292 seeders are present.
- Any user click outside the spotlight **pauses** the tour (the user can
  always grab the wheel); Stop abandons the run (normal run cancel).
- Player chrome: play/pause/step/stop, narration caption, progress dots;
  `prefers-reduced-motion` disables the cursor animation (spotlight jumps).

## Feature evaluation matrix (ADR 0001)

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | `src/features/guided-tours/` (catalog service + `routes.ts` + `feature.ts`); FE package + the `tours/actionRegistry.ts` chassis seam. Registered by appending to `BACKEND_FEATURES` / `FRONTEND_FEATURES`; no core edits. |
| 2 | Toggle | `guided-tours`, default **OFF**, `bucketUnit: tenant`, salt `guided-tours`; manageable in FeatureTogglePanel. |
| 3 | `ctx.<feature>` surface | **None in v1** (honest) — tours are launched by users, not orchestrated from other workflows. Candidate later: `ctx.guidedTours.launch`. **⟶ Correction (P6d, 2026-07-16):** the `launch` candidate was REJECTED as dishonest — a backend run has no live FE player to drive, so it can't imperatively launch a tour at a user (unlike sending an email). The honest surface shipped instead: READ-only `ctx.features.guidedTours` with `listTours()` (published, non-transient tour defs) + `tourProgress()` (**tenant-level** — the progress store is keyed `tenantId:tourId`, carries no userId), so an orchestrating workflow can *read* tour state to gate a branch. A future `suggestTour(userId,…)` (async enqueue, not launch) is deferred WITH its trigger: a per-*user* progress key **(met 2026-07-17 — ADR 0378 P3 shipped `tenantId:userId:walkthroughId` rows)** + a cross-user "offer the user something" channel (overlaps notifications — still the open half) + FE pending-pickup. |
| 4 | Node pack | `feature.guided-tours.nodes`: `ui.tour.step`, `ui.tour.checkpoint`. Signed via the registry pipeline. |
| 5 | Chat envelopes | **None.** Interrupt kind `tour-step` is namespaced away from chat cards (audit hazard above; test-pinned). |
| 6 | Agent pack | **None in v1** (honest). Phase 6 candidate: a Tour Author agent that drafts step sequences from a recorded session. |
| 7 | Public surface | **None.** Tours run authed, in-app. |
| 8 | RBAC | List/launch behind toggle + `workspace:read`; the tour's mutations are the user's own authed actions (no privilege change by construction). Progress rows tenant-keyed. |
| 9 | Replay/fork | `run.metadata.{guidedTour,tourId}` stamped at creation; HITL input in resume values (event log). Deterministic replay; fork reads metadata verbatim. |
| 10 | Frontend | `guidedToursClient.ts`, player chrome (spotlight/cursor/caption/controls — `ui/` primitives + tokens, no literals), catalog entry via the menu registry, full i18n ×4, reduced-motion + focus management per DESIGN.md §11. |

## Phased plan (each phase separately reviewable, toggle-gated)

| Phase | Scope | Gate |
|---|---|---|
| 0 | This ADR accepted | — |
| 1 | Action registry seam + `feature.guided-tours.nodes` (`ui.tour.step` interrupt round-trip) + chat-card scoping test + registry-coverage test | backend vitest + FE build |
| 2 | Player core: launch → SSE attach → perform/resolve loop → sessionStorage re-attach; toggle + routes + catalog service | two-step demo tour green in e2e |
| 3 | Player chrome: spotlight, animated cursor, narration, controls, pause-on-outside-click, reduced-motion, i18n ×4 | /ux-review |
| 4 | **Reference tour: Campaign Studio** brief → personas → channels → campaign, incl. one HITL upload step + checkpoints; data-context guardrail card | live click-through |
| 5 | Headless tour replay under Playwright (tours-as-e2e); progress store + completion badges | CI wiring |
| 6 (✅ shipped) | Record-mode authoring; Tour Author agent pack; ~~`ctx.guidedTours.launch`~~ → READ-only `ctx.features.guidedTours` (launch rejected as dishonest — see matrix row 3). Generated/recorded tours ride the **ADR 0369 transient lifecycle** (born `transient`, reviewed via real runs, **promoted** on user approval; discard = archive) | backend vitest (`guided-tours-surface.test.ts`) ✓ |

## Alternatives weighed

1. **Frontend-only tour engine** (driver.js-style JSON scripts in the SPA).
   Simpler day-1, but: a second orchestrator (violates the no-parallel-
   architecture law), no durable pause/resume, HITL is bespoke, nothing
   reusable as tests, and scripts live outside the template/pack pipeline.
   Rejected.
2. **Browser-automation replay** (Playwright in a cloud worker streaming
   video). Watchable but not *interactive* — the user can't take over for
   HITL steps in their own session; heavy infra. Rejected for the product
   goal; retained as the Phase 5 CI mode where non-interactivity is the point.
3. **Every step a plain node with FE polling** (no interrupts). Loses the
   free pause/resume/HITL semantics and invents a poll loop the engine
   already solves. Rejected.

## PRD-vs-architecture corrections

- *"the user can go into the **manual testing** and select play"* → there is
  no separate "manual testing" area; the player is a user-facing guided-tour
  surface (catalog + per-feature Play affordances). The testing value arrives
  as Phase 5's headless replay of the same scripts — a byproduct, not a
  second surface.
- *"when the new screen loads, the next step in the workflow resumes"* →
  inverted: the engine never watches the UI. The node WAITS on its interrupt;
  the player treats route-settle as its own readiness signal, performs the
  action, and resolves. The engine stays UI-agnostic (and therefore the same
  tour can be replayed headlessly).
- Screen/button targets are **semantic registry ids**, never selectors, so
  scripts survive refactors and are conventions-testable.

## Correction note — the "manual testing" surface EXISTS (2026-07-15, P1 audit)

The PRD-corrections section claimed "there is no separate manual-testing
area" — wrong: the **`/test` manual-test runner** (ADR 0183, the
`manual-tests` feature: Category → TestSuite → TestCase → TestStep human
checklists with progress + run logs, 39 suites) is exactly the surface the
PRD named. Corrected composition, honoring both owners:
- `manual-tests` stays the CHECKLIST owner; `guided-tours` is the ENGINE
  (nodes, interrupts, player, action registry).
- The **Play affordance lands in the `/test` runner**: a TestCase may carry
  a `tourId`; when the toggle is on, Play launches that tour through the
  player (Phase 4 wiring). A tour-backed case is David's original sentence
  verbatim: "go into the manual testing and select play."
- No separate tours catalog page ships; per-feature "Play tour" affordances
  remain Phase 4+ options.

## Correction note — composition with ADR 0369 (2026-07-15, same day)

ADR 0369 (transient workflow lifecycle) was authored hours after this ADR and
supplies the missing lifecycle for GENERATED tours: a record-mode or
Tour-Author draft registers `lifecycle.transient = true` (catalog-hidden,
runnable for review), and the user's save is 0369's `promote` verb — the
Workflow Builder → Dynamic → Saved pipeline applied to tours. Hand-shipped
tours (the `tmpl.*` pack path) are unchanged. This also answers "do manual
tests become saved workflows" explicitly: yes — a tour IS a saved workflow;
a *generated* one merely starts transient until approved.

## Open questions

1. Step pacing for a "watch only" fast mode — prefetch next-step payloads vs
   accept the ~100–300 ms interrupt round-trip per step (default: accept; the
   pacing reads as intentional in a guided demo).
2. Auto-pause timeout when a scripted step can't find its element (registry
   drift at runtime): pause + "this tour needs an update" notice (fail
   honest) — proposed default, confirm in Phase 2.
3. Multi-tab: second tab attaching to the same tour run — v1: the progress
   row records the owning runId; a second Play offers resume-or-restart.
4. ~~Whether the Campaign Studio tour defaults to the demo workspace or the
   user's own~~ — **DECIDED (David, 2026-07-15): the user's OWN workspace by
   default**, tour-created artifacts prefixed "[Tour]", with a demo-workspace
   switch on the launch card. Rationale: learning lands best in the user's
   real context; the naming keeps cleanup obvious.
