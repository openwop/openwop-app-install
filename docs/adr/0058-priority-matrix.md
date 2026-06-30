# ADR 0058 — Priority Matrix (weighted idea prioritization, configurable criteria, planning sessions)

**Status:** implemented (Phases 1–4 complete — REST + surface + node/agent packs; see § Implementation ledger)
**Date:** 2026-06-16
**Toggle:** `priority-matrix` — a toggle-gated **feature-package** under
`backend/typescript/src/features/priority-matrix/` (net-new product surface, ADR 0001).
Default **OFF**, `bucketUnit: 'tenant'` (a shared B2B surface, ADR 0015), `salt: 'priority-matrix'`.
**Capability:** no new `AgentCapabilityId`; no wire capability. Advertises a
`ctx.features.priority-matrix` surface at `/.well-known/openwop` (auto, via the feature's
`surface` declaration — ADR 0014).
**Depends on / composes:**
ADR 0001 (feature-package), ADR 0006 (RBAC — `workspace:read|write` + a config-authority
predicate), ADR 0015 (workspace = tenant — scoping), ADR 0014 (`ctx.<feature>` surface),
**ADR 0049 / `host.kanban`** (the board, columns-as-statuses, `terminal` lanes, card
assignment — **reused, not forked**), ADR 0046 (`project` Subject — optional list scoping +
board `ownerSubject`), **ADR 0053 (Documents & Templates)** (the `board-agenda` kind — the
planning session composes it instead of forking an agenda store).
**Surface:** host-internal, under `/v1/host/openwop-app/priority-matrix/*` (route prefix
audited clean). No public/unauthenticated surface.
**RFC gate:** **NO new RFC.** Host-extension only — no wire field, event type, capability
flag, or normative MUST. Composes core (`host.kanban`) + accepted feature surfaces. See
§ "RFC gate".

---

## Why this exists

The plan (this conversation, 2026-06-16):

> We need a Priority Matrix feature for capturing, scoring, and prioritizing ideas and
> project requests, then turning a prioritized selection into a planning-session agenda.
> Ideas are scored with a configurable weighted model (WSJF/SAFe-style); an authorized
> user tunes criteria weights on 1–10 sliders. Lists are freely named ("Strategic
> Initiatives", "Priority Guidance"). A planning session lets someone select which ideas
> to address and generates a meeting/strategy-session agenda. Every idea carries a status;
> the statuses render as columns on a Kanban board.

Two caller decisions are fixed inputs (this conversation):

1. **Scoping is workspace-first.** A list does **not** have to belong to a project. If a
   `projectId` is present, the list is scoped to that project; otherwise it is
   workspace(org)-scoped.
2. **Scoring is criteria weighted 1–10 via sliders**, but the model and UX must follow
   **industry best practice** (synthesized in § "Scoring model").

## Goal

Submit ideas/requests → score them against a configurable, weighted criteria set →
rank them → run a planning session that turns a selection into a meeting agenda, with
status tracked on a Kanban board.

---

## Boundaries audit (what already exists — reuse, do not fork)

`Explore` sweep over `backend/typescript/src` (2026-06-16):

- **Route namespace is clean.** `/priority`, `/ideas`, `/criteria`, `/planning`,
  `/agenda`, `/matrix` — no registrant. (`/chat/sessions` is the only `sessions` match,
  unrelated.) Prefix `/v1/host/openwop-app/priority-matrix/*` is free.
- **`host.kanban` already models statuses-as-columns.**
  `host/kanbanService.ts:36` — `KanbanColumn { id, name, triggerWorkflowId?, terminal? }`;
  `:67` — `KanbanCard { ..., assigneeId?, assigneeRole?, completedAt?, labels?, dependsOn?, order }`;
  `:114` — `KanbanBoard { id, tenantId, name, columns[], ownerSubject?, ... }`.
  Columns are **free-form names**, `terminal` marks done-lanes (ADR 0049), `ownerSubject`
  can be a `{kind:'project'}` (ADR 0045/0046), `triggerWorkflowId` is **optional**. This
  is exactly the status/board/card primitive the plan asks for — building a parallel board
  would violate [[no-parallel-architecture]].
- **`board-agenda` is already a documented document kind** (ADR 0053 / `documents`
  feature). The planning session composes Documents' `generateFromTemplate` rather than
  forking an agenda store.
- **Genuinely new** (no existing owner): configurable **weighted criteria sets**,
  **per-idea scoring + ranking**, and **planning-session selection**. The assistant's
  `features/assistant/prioritization.ts` weighted-sum scorer is **hardcoded to the
  briefing layer** — not a reusable service; we do not couple to it (and do not fork it —
  the math here lives in a small pure module the feature owns).
- **Established wiring to reuse verbatim:** `BackendFeature` + `BACKEND_FEATURES`
  (`features/index.ts`), `toggleDefault` (advisory-board `feature.ts` shape),
  `authorizeOrgScope` / `requireOrgScopeFor` / `resolveOne` (`features/featureRoute.ts`),
  the `surface: { id, build }` seam (`host/featureSurfaces.ts`), `requiredPacks`
  (`feature.<id>.{nodes,agents}`), `FrontendFeature` + `FRONTEND_FEATURES`
  (`frontend/react/src/features/registry.ts`).

## Decision

A single feature-package `priority-matrix`. It **owns only what is new** — lists, criteria
sets, idea scores, planning sessions — and **rides `host.kanban` for the board, the cards
(= ideas), and the statuses (= columns)**.

### Data model

```
PriorityList                       // the named container ("Strategic Initiatives", …)
  id, tenantId, orgId
  projectId?: string               // present ⇒ project-scoped (board ownerSubject = project)
  name: string                     // free-form, creator-named
  boardId: string                  // the provisioned host.kanban board (statuses = columns)
  criteriaSetId: string
  createdAt, createdBy, updatedAt

CriteriaSet                        // configurable weighted criteria, per list
  id, listId
  presetId?: 'weighted' | 'wsjf' | 'rice' | 'value-effort' | 'ice'   // seed template
  aggregation: 'weighted-sum' | 'ratio'   // sum (default) vs benefit÷cost (WSJF/RICE)
  criteria: Criterion[]

Criterion
  id, name, description?
  weight: number                   // 1..10 (the slider)
  direction: 'benefit' | 'cost'    // higher-better vs higher-worse (cost/effort/job-size)
  scaleHint?: string               // anchor text for the 1..10 score input

IdeaScore                          // the scoring overlay on a kanban card (= an idea)
  id, listId, cardId               // cardId IS the idea (host.kanban card)
  scores: Record<criterionId, number>   // 1..10 per criterion
  computedPriority: number         // derived + cached; recomputed on score/weight change
  updatedAt, updatedBy

PlanningSession
  id, listId, name
  selection: { mode: 'top-n' | 'manual' | 'both'; n?: number; cardIds: string[];
               sort?: 'priority'|'created'|'owner'|'status'|'title'; sortDir?: 'asc'|'desc' }
               // `sort` orders the SAVED agenda doc (default `priority` = rank order);
               // the live table is independently click-sortable. Snapshot for replay.
  criteriaSnapshot: CriteriaSet    // IMMUTABLE snapshot at generation (replay/audit)
  agendaDocumentId?: string        // when `documents` enabled (ADR 0053 board-agenda)
  agendaMarkdown?: string          // fallback when `documents` is OFF
  status: 'draft' | 'generated'
  createdAt, createdBy
```

**An idea is a `host.kanban` card.** Submission creates a card in the `New` column;
status = the card's column; "drag between columns" = the existing kanban move; done/won't-do
= `terminal` columns (ADR 0049); assignment = `assigneeId`/`assigneeRole` (ADR 0049 — free
bonus). The feature stores **no parallel idea entity** — only the `IdeaScore` overlay keyed
by `cardId`. Card deletion cascades to its `IdeaScore`.

**The board is a real `host.kanban` board**, provisioned per list, seeded with default
columns mapping to the requested status set (renameable/extensible — kanban already
supports free-form columns):

`New · Under Review · Urgent · In Process · Blocked · Deferred · Won't Do (terminal) · Done (terminal)`

If `projectId` is set, the board's `ownerSubject = {kind:'project', id:projectId}`;
otherwise it is a workspace board (org-scoped, no subject owner).

### Scoring model (industry best-practice synthesis)

The plan named "WSJF" but described **1–10 weighted sliders** — mechanically that is
**Weighted Scoring**, not WSJF (which is *Cost of Delay ÷ Job Size*, a ratio). We make the
honest, configurable choice used by Productboard / Aha! / Jira Product Discovery / Airfocus:
a **generic weighted engine with named presets**.

- **Default — Weighted Scoring** (`aggregation: 'weighted-sum'`):
  `priority = Σ(score_i × weight_i) / Σ(weight_i)`, with `cost`-direction criteria
  inverted (`(11 − score)`), so weights stay 1–10 and the result is comparable across lists.
- **Ratio presets** (`aggregation: 'ratio'`) for frameworks that divide:
  - **WSJF (SAFe):** `CoD / JobSize`, CoD = user-business value + time-criticality +
    risk-reduction/opportunity-enablement (benefit), JobSize (cost).
  - **RICE:** `(Reach × Impact × Confidence) / Effort`.
  - **ICE:** `Impact × Confidence × Ease` (weighted-sum or product variant).
  - **Value vs Effort:** two criteria, rendered as a 2×2 quadrant.
- A **preset seeds** the criteria + sensible default weights; an authorized user then tunes
  weights on 1–10 sliders or adds/removes/renames criteria (cost, ROI, urgency,
  compliance/legislative risk, strategic alignment, …).

**UX best practice (drives the frontend phase):** sliders for *weights* (config-authority
only) are separated from the per-idea *score* grid (the "matrix": ideas × criteria);
show live computed priority **and relative rank** (not just raw decimals — avoid false
precision); anchored 1–10 scales with `scaleHint` descriptors reduce score-gaming; warn
when a weight change re-ranks an open list. Defaults are framework-anchored, not blank.

## Phased plan

- **Phase 1 — REST + model + scoring.** `priority-matrix` feature-package: `PriorityList`
  CRUD (provisions the kanban board), `CriteriaSet` (presets + custom weights), idea
  submit/list as kanban cards, `IdeaScore` set/get, ranked list (read). Pure scoring module
  (`scoring.ts`, weighted-sum + ratio). RBAC on every route. Service + HTTP-route tests.
- **Phase 2 — Planning sessions + agenda.** Select ideas (top-N by `computedPriority` /
  manual / both) → generate a `board-agenda` via the **Documents** feature
  (ADR 0053 `generateFromTemplate` — *assemble in route, generate in a run*, per the KB
  §Correction lesson). Snapshot `criteriaSnapshot` into the session (immutable). **Degrade
  gracefully:** if `documents` is OFF, return/persist `agendaMarkdown` inline (no hard dep).
- **Phase 3 — Frontend.** `priorityMatrixClient.ts` + `PriorityMatrixPage` (the
  ideas×criteria matrix grid + weight sliders + ranked view + the existing kanban board
  view for statuses) + `routes.tsx` (`FrontendFeature`, `featureId: 'priority-matrix'`,
  nav via the menu registry). `ui/` cohesion + tokens + a11y (`/ux-review`, `DESIGN.md`).
- **Phase 4 — Core-app extension surface.** `ctx.features.priority-matrix`
  (read: `listLists`, `listRankedIdeas`, `getScores`; write: `submitIdea`, `scoreIdea`,
  `generateAgenda`) behind the same toggle + RBAC; `feature.priority-matrix.nodes` signed
  pack (submit-idea, score-idea, rank-ideas, generate-agenda); AI-chat envelopes
  (`priority-matrix.create-idea`, `.score`, `.plan`); auto-advertised at `/.well-known/openwop`.
  `feature.priority-matrix.agents` (a "Prioritization Analyst" that recommends scores /
  drafts an agenda — capability stays core per [[agent-capability-core-not-named]];
  **deferrable** if not an AI surface day-1).

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (0001) | `src/features/priority-matrix/` (service + `routes.ts` + `feature.ts` + `surface.ts`); appended to `BACKEND_FEATURES`/`FRONTEND_FEATURES`; no core route/nav edits; features→core only. |
| 2 | Toggle + admin UI | id `priority-matrix`, **OFF**, `bucketUnit: 'tenant'`, `salt`; managed in `FeatureTogglePanel`. |
| 3 | Workflow surface (0014) | `ctx.features.priority-matrix` (reads + writes above), same toggle + RBAC, advertised at `/.well-known/openwop`. |
| 4 | Node pack | **Shipped** — `feature.priority-matrix.nodes` (list-lists / list-ranked-ideas / submit-idea / score-idea / generate-agenda) over the surface, declared in `requiredPacks`. Dev-mounts from `packs/`; the signed-registry round-trip is a publish-time concern, not a code change. |
| 5 | AI-chat envelopes | **Correction:** this host has **no separate envelope-acceptor seam**. Chat-drivability is the agent-pack + node-pack path — the Prioritization Analyst's `toolAllowlist` → `feature.priority-matrix.nodes` → `ctx.features.priority-matrix`. The "envelope" language in ADR 0014/0023 is aspirational (pending an RFC 0021 AI-envelope wire shape); implemented here as agent + nodes. |
| 6 | Agent pack | **Shipped** — `feature.priority-matrix.agents` Prioritization Analyst (RESEARCH, recommend-only; `prompts/prioritization-analyst.md`); capability core, persona via the manifest. |
| 7 | Public surface | **None.** Internal authed surface only. |
| 8 | RBAC + isolation (0006) | read = `workspace:read`; submit/score = `workspace:write`; **change criteria/weights = `workspace:write` + config-authority** (list creator or org admin); fail-closed; tenant+org+project IDOR-guarded; card-scope reused from ADR 0049. |
| 9 | Replay / fork safety | Planning-session agenda generated **in a run** (Documents path); `criteriaSnapshot` frozen on the session so later weight changes never rewrite a generated agenda. Scores influence content, not run-dispatch variants ⇒ no `featureVariant` stamp needed. |
| 10 | Frontend | `priorityMatrixClient.ts` + page + `routes.tsx`; nav via menu registry (`GROUP_ORDER`); reuses the kanban board UI for the status view; tokens/a11y. |

## RFC gate

**Host-extension only — no new RFC.** All routes live under
`/v1/host/openwop-app/priority-matrix/*` (non-normative). The feature composes core
`host.kanban` and the already-shipped `documents`/`projects` surfaces; it adds no
run-event field, capability flag, event type, endpoint contract, or normative MUST. The
`ctx.features.priority-matrix` surface is advertised honestly (only when wired). If a future
phase needed cross-host portfolio prioritization on the wire, *that* would need an RFC in
`../openwop/RFCS/` first — out of scope here.

## Alternatives weighed

- **Idea as its own entity + mirrored board** vs **idea = kanban card** → chose the card.
  Strongest no-parallel stance, zero new "idea" store, free status/assignment/terminal
  reuse. *Trade-off:* rich idea fields are limited to card fields (title/description/labels/
  priority/dependsOn) in v1; structured business-case fields deferred.
- **New agenda store** vs **compose Documents `board-agenda`** → chose compose (ADR 0053),
  with an inline-markdown fallback when `documents` is OFF (no hard dependency).
- **Single weighted-sum** vs **dual-mode (weighted-sum + ratio)** → chose dual-mode so WSJF
  and RICE are honest presets, not a misnamed sum.
- **Parallel board** vs **`host.kanban`** → `host.kanban` ([[no-parallel-architecture]]).

## PRD-vs-architecture corrections

- "WSJF (SAFe)" + "1–10 sliders" → **Weighted Scoring is the default engine; WSJF/RICE/ICE
  are ratio presets** (honest terminology; matches the slider UX).
- "statuses … fixed set" → mapped to **free-form `host.kanban` columns** seeded with the
  requested defaults (renameable/extensible), not a new enum.
- "submitted to a workspace or maybe a project?" → resolved: **workspace by default;
  `projectId` present ⇒ project-scoped** (caller decision).
- "a meeting agenda is created" → **compose Documents `board-agenda`** (generate-in-run),
  not a bespoke agenda artifact.

## Open questions

- [x] **`Urgent` as a status vs urgency as a criterion** — RESOLVED (2026-06-16): statuses
      are pure workflow-state; `Urgent` removed from the default columns. Urgency stays a
      scoring criterion that drives computed priority. Seed-only change (existing boards
      keep their columns).
- [x] **Multi-voter scoring** — addressed in the **ADR 0059** follow-on (per-user
      `IdeaVote` + mean/median aggregation, opt-in per list). v1 single-score path kept.
- [x] **Portfolio / cross-list rollup** — split (2026-06-16): **intra-host cross-list** rollup
      (aggregate/rank ideas across a workspace's lists) is host-internal → **ADR 0060**.
      Only **cross-HOST** portfolio federation would touch the wire (RFC-gated) — still parked.
- [x] **Agent pack scope** — shipped (Prioritization Analyst).
- [x] Confirm config-authority predicate: list-creator **or** org-admin role (ADR 0006) —
      CONFIRMED (2026-06-16). `requireListConfigAuthority` (`routes.ts`) grants when
      `list.createdBy === actor` OR the caller holds `host:org:manage` in the list's org;
      gates criteria/weights, voting mode/aggregation, per-voter weights, and delete.

## Implementation ledger

Shipped 2026-06-16 (this conversation). Backend `tsc` clean; full backend suite
**1727 passed / 10 skipped / 0 failed**; frontend `npm run build` green (tsc + token/CSS
gates + vite + bundle/CSP checks).

| Phase | What landed | Artifacts |
|---|---|---|
| 1 — REST + model + scoring | Lists CRUD (provisions a real `host.kanban` board with status columns), criteria sets (presets + custom weights), ideas as cards, score set/get, ranked read, config-authority gate | `features/priority-matrix/{types,scoring,priorityMatrixService,routes,feature}.ts` |
| 2 — Planning sessions + agenda | top-N / manual / both selection → deterministic agenda markdown, **ordered by `selection.sort`** (priority / created / owner / status / title — the saved doc honors the chosen order, not only rank; default `priority`); a `Submitted:` date line makes by-date/owner order legible; **re-order in place** via `PATCH /lists/:id/sessions/:sessionId` (mutates the same session — a reorder must not spawn a duplicate); **composes Documents `board-agenda`** when `documents` is ON, inline-markdown fallback when OFF; immutable `criteriaSnapshot` | `priorityMatrixService.{createPlanningSession,updatePlanningSession,orderAgenda}` |
| 3 — Frontend | `PriorityMatrixPage` (criteria weight sliders, idea grid with per-criterion score inputs, ranked table, status select, planning-session agenda render) + client + `routes.tsx` + registry | `frontend/react/src/features/priority-matrix/*` |
| 4 — Extension surface + packs | `ctx.features.priority-matrix` (listLists / listRankedIdeas / submitIdea / **scoreIdea** / generateAgenda), toggle-gated, auto-advertised at `/.well-known/openwop`; **`feature.priority-matrix.nodes`** (5 nodes) + **`feature.priority-matrix.agents`** (Prioritization Analyst) dev-mounted via `requiredPacks` | `features/priority-matrix/surface.ts`, `packs/feature.priority-matrix.{nodes,agents}/` |
| Tests | route harness (gating · scoping · **cross-org isolation** · ranking · config-authority · status move · agenda inline + **Documents-compose**) + pure scoring unit tests + **node/agent pack tests** | `test/priority-matrix-{route,scoring,packs}.test.ts` (18 tests) |

**Post-review hardening (code-review pass):** per-list routes gate on the **list's
org** (`loadListScoped` — no-existence-leak 404 + write→403, mirroring the projects
feature) rather than tenant-only, closing a cross-org gap for project-scoped lists;
the Documents compose rolls back an orphan `board-agenda` doc on a partial write
failure. **UX-review (DESIGN.md §5.1):** the score matrix reuses the shared
`<DataTable>` primitive (per-cell render fns; controlled inputs synced to server
values), the list selector is the sanctioned `.tabs`/`.tab` strip (`role="tablist"`),
and the add/planning forms use `.surface-form` — no hand-rolled table/tab/form.

**Phase 4 completed (follow-on, this conversation):** the `feature.priority-matrix
.{nodes,agents}` packs now ship — 5 nodes over the surface + a Prioritization Analyst
agent whose `toolAllowlist` is those nodes. There is **no separate AI-chat-envelope seam**
in this host; chat-drivability is exactly this agent + node path (the ADR 0014/0023
"envelope" language is aspirational, pending RFC 0021). Signing is a publish-time concern
(packs dev-mount from `packs/` unsigned). **Multi-voter scoring** is the **ADR 0059**
follow-on. **Portfolio / cross-list rollup** and the **`Urgent`-status overlap** remain
parked (the former is the RFC-gated wire case).

## Next step

`/code-review` + `/nfr` pre-merge; `/ux-review` for the matrix/slider frontend (light + dark).
Hand the deferred node pack / chat envelopes to `/architect` if that wire-adjacent surface grows.
