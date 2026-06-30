# ADR 0103 — Priority schedule status (target dates + ahead/behind derivation over priority ideas)

**Status:** implemented (Phases 1–3 complete — model + derivation + REST, surface + node + agent allowlists, frontend; see § Implementation ledger)
**Date:** 2026-06-22
**Toggle:** none new — **rides the existing `priority-matrix` toggle** (ADR 0058). This is
an *extension* of an installed feature-package (`backend/typescript/src/features/priority-matrix/`),
not a net-new surface. When `priority-matrix` is OFF, every route/surface/node here is
inert (same gate).
**Capability:** no new `AgentCapabilityId`; no wire capability. Extends the existing
`ctx.features.priority-matrix` surface (ADR 0014) with a read (`getScheduleStatus`) + a
write (`setIdeaSchedule`); both auto-advertised with the surface at `/.well-known/openwop`.
**Depends on / composes:**
ADR 0058 (Priority Matrix — `PriorityList`, `IdeaScore`, ideas-are-`host.kanban`-cards),
ADR 0049 / `host.kanban` (the board, columns-as-statuses, **`terminal` lanes** = the
"done" signal, `completedAt`), ADR 0006 (RBAC — `workspace:read|write`), ADR 0015
(workspace = tenant scoping), ADR 0046 (`project` Subject — the *optional* cross-check
against linked-project milestones), **ADR 0079/0080 (Strategy `get-health`)** — a
**complementary** signal (project-health rollup), explicitly *not* duplicated here.
**Surface:** host-internal, under `/v1/host/openwop-app/priority-matrix/*` (the existing
audited prefix). No public/unauthenticated surface.
**RFC gate:** **NO new RFC.** Host-extension only — a new stored overlay + a derived read
on an already-host-internal feature. No run-event field, capability flag, event type,
endpoint contract, or normative MUST. See § "RFC gate".

---

## Why this exists

A user asked their chief-of-staff agent (Iris) to *"analyze the current list of priorities
to see if we are ahead or behind schedule based on dates and status."* Today that is
**impossible**: a priority "idea" is a `host.kanban` card (ADR 0058), and a card carries
`completedAt` but **no target/due date** — there is no date to be ahead or behind *of*.
The card's column (`status`) is pure workflow-state, not a schedule. So "behind schedule"
cannot be derived, and an agent that claimed it would be inventing the signal.

This ADR adds the missing, minimal thing — an **optional target-date overlay on a priority
idea** plus a **pure derivation** of an ahead/behind/at-risk state from `(target date,
card status, completedAt)` — and exposes it as one read on the existing surface + one node,
so any agent (Iris, the Prioritization Analyst) can answer the question honestly. Setting a
date stays a normal authorized write; the agent only *reads* and *reports*.

## Goal

Give a priority idea an optional **target date** (and optional start date), derive a
per-idea **schedule state** (`on-track` / `at-risk` / `behind` / `done-early` / `done-late`
/ `unscheduled`) from that date + the card's status, roll it up per list, and surface it as
a read node so chat-driven agents can report list schedule health — **without** a parallel
board, a parallel date store, or a duplicated project-health rollup.

---

## Boundaries audit (what already exists — reuse, do not fork)

- **Ideas already carry a "done" signal.** `host.kanban` `terminal` columns (ADR 0049)
  mark Won't Do / Done; cards carry `completedAt`. Schedule-done = the card is in a
  `terminal` lane — **do not add a parallel "completed" flag** ([[no-parallel-architecture]]).
- **`IdeaScore` is the established per-idea overlay pattern** (ADR 0058 — keyed by
  `(listId, cardId)`, cascades on card delete). The schedule overlay follows it verbatim;
  no new storage seam invented.
- **Strategy already rolls up *project* health** (`feature.strategy.nodes.get-health`,
  ADR 0080 — on-track/at-risk/off-track from linked-project milestones). That is a
  **different layer** (strategy → projects). This ADR is idea-target-date → idea-state. We
  **compose, not duplicate**: when an idea's list is project-scoped (`PriorityList.projectId`,
  ADR 0046), the derivation MAY cross-check the linked project's milestone dates as a
  secondary signal, but the primary input is the idea's own target date.
- **`host.kanban` has no native card due-date today.** If it later grows one, this overlay
  migrates onto it (a note for future hygiene) — for now the feature owns the date, keyed by
  `cardId`, exactly as it owns `IdeaScore`.
- **Reuse verbatim:** the surface seam (`ctx.features.priority-matrix`), `requiredPacks`
  (`feature.priority-matrix.nodes`), `loadListScoped` org-gating + IDOR pattern (ADR 0058
  post-review hardening), the pure-module test style (`scoring.ts` → `schedule.ts`).

## Decision

Add a small, optional **`IdeaSchedule` overlay** + a **pure `schedule.ts` derivation** +
**one read method / node** (`getScheduleStatus`) and **one write method / route**
(`setIdeaSchedule`) on the existing `priority-matrix` feature. No new toggle, no new board,
no new entity beyond the overlay.

### Data model (additive)

```
IdeaSchedule                      // optional schedule overlay on one idea (= kanban card)
  listId, cardId                  // same key shape as IdeaScore; cascades on card delete
  targetDate: string             // ISO date — the date this idea is meant to be done by
  startDate?: string             // ISO date — optional, for elapsed/% context only
  setBy: string
  updatedAt: string
```

A separate overlay (not a field on `IdeaScore`) keeps **scoring and scheduling orthogonal**
— you can date an idea you have not scored, and vice-versa. Absence = `unscheduled`.

### Derived schedule state (pure, in `schedule.ts`)

`deriveScheduleStatus(card, schedule, now, columns) → ScheduleStatus` where:

```
ScheduleState =
  | 'unscheduled'   // no targetDate
  | 'on-track'      // targetDate in the future, card not blocked
  | 'at-risk'       // within ATRISK_WINDOW_DAYS of targetDate and not done, OR card in a 'Blocked' column
  | 'behind'        // targetDate in the past and card NOT in a terminal lane (overdue)
  | 'done-early'    // card in a terminal 'done' lane, completedAt <= targetDate
  | 'done-late'     // card in a terminal 'done' lane, completedAt > targetDate

ScheduleStatus = { cardId, state, targetDate?, dueInDays?, overdueByDays?, completedAt? }
```

- "Done" = the card sits in a **`terminal` lane** (ADR 0049) — reused, not re-flagged.
  Won't-Do (terminal, non-completing) reads as `unscheduled`-equivalent (excluded from
  behind/at-risk — you cannot be late for something cancelled).
- `now` is the **server clock at read time** (this is a *live* read, see Replay below).
- `ATRISK_WINDOW_DAYS` is a small constant (proposed default **3**), overridable later.

### Rollup

`getScheduleStatus(listId)` returns per-idea `ScheduleStatus[]` **and** a list rollup
mirroring strategy's `get-health` shape for consistency:

```
{ behind, atRisk, onTrack, doneLate, doneEarly, unscheduled, total,
  health: 'on-track' | 'at-risk' | 'behind' }   // worst-wins: any 'behind' ⇒ 'behind', else any 'at-risk' ⇒ 'at-risk'
```

### Chat-drivability (the original motivation)

One new read node:

- **`feature.priority-matrix.nodes.schedule-status`** (role: read) → `ctx.features
  .priority-matrix.getScheduleStatus(listId)`. Added to the **Prioritization Analyst**
  allowlist **and** the **Chief of Staff (`feature.assistant.agents.chief-of-staff`)**
  allowlist, so Iris answers the ahead/behind question from real data.

Setting a target date is a **write** (`PUT …/lists/:listId/ideas/:cardId/schedule` →
`setIdeaSchedule`). It is deliberately **not** added to Iris's allowlist in v1 — she
*reports* schedule, the principal (or the Prioritization Analyst, draft-gated) *sets* it.
A future `set-schedule` node can be added if an agent should propose dates.

> **Interim note (no-code-yet):** until this ships, the chief-of-staff prompt already
> instructs Iris to attribute schedule risk to *linked-project health* (`get-health`) and
> to **not** claim an idea is "behind schedule" from status alone — the honest stopgap.
> When this ADR lands, that caveat is replaced by the real per-idea signal.

## Phased plan

- **Phase 1 — model + pure derivation + REST.** `IdeaSchedule` type; `schedule.ts`
  (`deriveScheduleStatus` + rollup, pure, fully unit-tested incl. boundary/timezone cases);
  `setIdeaSchedule` + `getScheduleStatus` on `priorityMatrixService`; routes
  (`PUT/DELETE …/ideas/:cardId/schedule`, `GET …/lists/:listId/schedule`) with RBAC +
  `loadListScoped` org-gating; cascade-on-card-delete. Service + route tests.
- **Phase 2 — surface + node pack.** `ctx.features.priority-matrix.getScheduleStatus`
  (read) + `setIdeaSchedule` (write) behind the same toggle + RBAC; auto-advertised at
  `/.well-known/openwop`. `feature.priority-matrix.nodes.schedule-status` node; add to the
  Prioritization Analyst + Chief of Staff allowlists; pack tests.
- **Phase 3 — frontend.** Optional date input per idea in `PriorityMatrixPage` (the grid
  gets a target-date column) + a schedule-state chip (status→chip semantics, `ui/` tokens,
  light + dark, a11y; `/ux-review`, `DESIGN.md`). A list-level schedule rollup banner.

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (0001) | Extends `src/features/priority-matrix/` only (`types.ts` += `IdeaSchedule`, new `schedule.ts`, service + `routes.ts` additions, `surface.ts` += 2 methods). No core route/nav edits; features→core only. |
| 2 | Toggle + admin UI | **No new toggle** — rides `priority-matrix` (OFF default, `bucketUnit: 'tenant'`). |
| 3 | Workflow surface (0014) | `ctx.features.priority-matrix.getScheduleStatus` (read) + `setIdeaSchedule` (write), same toggle + RBAC, advertised at `/.well-known/openwop`. |
| 4 | Node pack | `feature.priority-matrix.nodes.schedule-status` (read) appended to the existing `feature.priority-matrix.nodes` pack; declared (already) in `requiredPacks`. |
| 5 | AI-chat envelopes | No separate envelope seam (ADR 0058 §5 correction). Chat-drivability = the node added to the Prioritization Analyst **and** Chief-of-Staff `toolAllowlist`. |
| 6 | Agent pack | No new agent. Reuses the Prioritization Analyst + the core Chief-of-Staff (capability stays core per [[agent-capability-core-not-named]]). |
| 7 | Public surface | **None.** Internal authed surface only. |
| 8 | RBAC + isolation (0006) | read schedule = `workspace:read`; set/clear a date = `workspace:write`; tenant+org+project IDOR-guarded via `loadListScoped` (no-existence-leak 404 → write 403); cascade on card delete. |
| 9 | Replay / fork safety | `getScheduleStatus` is a **live read** (depends on `now`) — like `get-health`, it is **never stamped into a replayable run artifact**. If a planning agenda wants to embed schedule state, it **snapshots** the computed `ScheduleStatus[]` at generation (the `criteriaSnapshot` precedent), so replay is deterministic. No `featureVariant` stamp. |
| 10 | Frontend | Per-idea target-date input + schedule chip + list rollup banner in `PriorityMatrixPage`; status→chip via `ui/`; tokens/a11y; light + dark. |

## RFC gate

**Host-extension only — no new RFC.** Routes stay under `/v1/host/openwop-app/priority-matrix/*`
(non-normative). It adds a stored overlay + a derived read to a host-internal feature; no
run-event field, capability flag, event type, endpoint contract, or normative MUST, and no
new wire surface. The surface methods are advertised honestly (only when wired). Only a
future **cross-host** portfolio-schedule rollup would touch the wire — out of scope, and
RFC-gated in `../openwop/RFCS/` if ever pursued.

## Alternatives weighed

- **Target date on `IdeaScore`** vs **a dedicated `IdeaSchedule` overlay** → chose the
  overlay: scoring and scheduling are orthogonal (date an unscored idea; score an undated
  one), and it keeps the scoring record's replay snapshot clean.
- **Reuse Strategy `get-health` only** (no new field) vs **a real per-idea date** → chose
  the date. `get-health` answers *project* health, not *"is this priority item behind?"*;
  using it alone would force every priority into a project and still could not date an
  individual idea. We *compose* `get-health` as a secondary signal for project-scoped lists,
  not as the answer.
- **Native `host.kanban` card due-date** vs **a feature overlay** → kanban has none today;
  adding one is a core change beyond this feature's scope. Overlay now; migrate onto a
  native field if/when ADR 0049's card model grows one ([[no-parallel-architecture]] — the
  overlay is keyed by the real `cardId`, so the card stays the single source of identity).
- **Let the agent infer "behind" from status columns** vs **derive from a real date** →
  rejected inference outright: it is the dishonest-signal failure this ADR exists to prevent.

## Open questions

- [ ] `ATRISK_WINDOW_DAYS` default (proposed **3**) — fixed constant v1, or per-list config
      under config-authority later?
- [ ] Should `Blocked`-column membership force `at-risk` regardless of date? (Proposed:
      **yes** — a blocked item is at-risk even if its target is far off.)
- [ ] Project-scoped cross-check: when `PriorityList.projectId` is set, should an idea with
      no own `targetDate` inherit the nearest linked **project milestone** date (ADR 0046)
      as a fallback, or stay `unscheduled`? (Proposed: **stay unscheduled** in v1; inherit
      is a Phase-4 enhancement to avoid surprising derivations.)
- [ ] Won't-Do (terminal, non-completing) handling — confirmed excluded from behind/at-risk
      (cannot be late for a cancelled item). Confirm the rollup also excludes it from `total`.

## Implementation ledger

**Phase 1 shipped 2026-06-22.** Backend `tsc --noEmit` clean; `priority-matrix-schedule`
(15 pure cases) + `priority-matrix-route` schedule block (HTTP: ahead/behind/done-early,
rollup health, clear, date validation) green — **27 tests pass** in the two files.

| Phase | What landed | Artifacts |
|---|---|---|
| 1 — model + derivation + REST | `IdeaSchedule` overlay; pure `schedule.ts` (`deriveScheduleStatus` 6 states + at-risk window + blocked + cancellation, `rollupSchedule` worst-wins); `setIdeaSchedule`/`clearIdeaSchedule`/`getScheduleStatus` (live read, injectable `nowMs`) with `loadListScoped` RBAC; cascade on list delete; routes `PUT/DELETE …/ideas/:cardId/schedule` + `GET …/lists/:listId/schedule` | `features/priority-matrix/{types,schedule,priorityMatrixService,routes}.ts`; `test/priority-matrix-schedule.test.ts` + route-test schedule block |
| 2 — surface + node | **shipped 2026-06-22** — `ctx.features.priority-matrix.getScheduleStatus` (live read, role:"action" recorded-output); `feature.priority-matrix.nodes.schedule-status` node; added to **Prioritization Analyst** + **Chief-of-Staff (Iris)** allowlists; prompt updated to use it for schedule risk | `surface.ts`, `packs/feature.priority-matrix.nodes/{pack.json,index.mjs}`, `packs/feature.priority-matrix.agents/pack.json`, `packs/feature.assistant.agents/{pack.json,prompts/chief-of-staff.md}`; `test/priority-matrix-packs.test.ts` (6 tests incl. Iris allowlist) |
| 3 — frontend | **shipped 2026-06-22** — `ScheduleCell` (state chip + native date input + clear button) in a "Schedule" column of the ideas table; schedule rollup chip in the ranked-ideas header; one-fetch-per-list `getScheduleStatus` (graceful-degrade); i18n ×4 | `frontend/react/src/features/priority-matrix/{priorityMatrixClient,PriorityMatrixPage}.tsx` + `i18n/{en,es,fr,pt-BR}.ts` |

**Review cycle (per phase): `/architect` before · `/code-review` + `/ux-review` after.**
- **Phase 1** — architect: PASS (fixed classifyColumn id-preference + added RBAC-negative/cascade tests). FE/ux N/A.
- **Phase 2** — architect: PASS (corrected node to `role:"action"` for recorded-output replay). code-review: clean. ux N/A (no UI).
- **Phase 3** — architect: PASS. code-review: added explicit clear button + dedicated `saveScheduleFailed` copy. ux-review: CLEAR (0 hex/inline-color/emoji; chip text-not-color-only; date input themes via app `color-scheme`).
- **Gates:** backend `tsc` clean + priority-matrix/assistant suites green; frontend `npm run build` green (tsc + token/CSS/i18n integrity + vite + bundle/CSP).

**Resolved during Phase 1:** "Blocked-forces-at-risk" (open question) implemented as
**yes** — a `Blocked`-column open idea reads `at-risk` regardless of date. Cancellation
("Won't Do") detection is by terminal-lane + id/name match (`/won'?t\s*do|cancel/i`);
cancelled ideas are surfaced per-idea but excluded from rollup counts. Date-only targets
count the whole day as on-time (end-of-day UTC). Project-milestone inheritance + the
`ATRISK_WINDOW_DAYS` config remain open (deferred to a later phase as the ADR proposed).

## Next step

`/architect` is **not** required (no wire/capability/replay-of-the-protocol surface — pure
host-extension). On acceptance: implement Phase 1→3, then `/code-review` + `/nfr` pre-merge
and `/ux-review` for the date input + chips (light + dark). Add the `schedule-status` node
to the Chief-of-Staff allowlist in the same change that ships the node (the read tool is
already prompt-described in `packs/feature.assistant.agents/prompts/chief-of-staff.md`).
