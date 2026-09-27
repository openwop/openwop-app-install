# Drawings + CAD (unit C4) — chat-first port review

**Scope:** `backend/typescript/src/features/{drawings,cad}` +
`frontend/react/src/features/{drawings,cad}`, their packs
(`packs/feature.{drawings,cad}.{nodes,agents}`), and the shared canvas chassis
they ride. Both toggles ship `status: 'on'`.

**One-line verdict:** the *canvas* half of both features already rides the real
owners cleanly (canvas chassis editor, versioning, collab, artifact registry,
Media for mesh/BOM) — but the **AI-generation half that both toggles advertise
first ("generate them with the AI chat") is THEATER**: the Illustrator and CAD
Modeler agents are handed a `toolAllowlist` of pack-node typeIds
(`…nodes.render`, `core.coordination.canvasRead`, and CAD's six extra nodes)
that are **never projected as conversational tools**, so they are silently
dropped at dispatch and the agents can emit nothing.

---

## Step 1 — Contract scouting (pinned)

### What the packs DECLARE
- `drawings` feature declares `feature.drawings.nodes` + `feature.drawings.agents`
  (`backend/typescript/src/features/drawings/feature.ts:30-33`). Node pack ships ONE
  node, `feature.drawings.nodes.render`, role `action`
  (`packs/feature.drawings.nodes/pack.json`), which emits
  `{ artifact: { artifactTypeId: 'canvas.drawing', payload } }`
  (`packs/feature.drawings.nodes/index.mjs:41-49`). Agent pack ships the
  **Illustrator** with `toolAllowlist: ["openwop:core.coordination.canvasRead",
  "openwop:feature.drawings.nodes.render"]`
  (`packs/feature.drawings.agents/pack.json:24-27`).
- `cad` feature declares `feature.cad.nodes@1.5.0` + `feature.cad.agents@1.5.0`
  (`backend/typescript/src/features/cad/feature.ts:33-36`). Node pack ships SEVEN
  action nodes: `render`, `mesh-import`, `mesh-export`, `bom-generate`,
  `dimension-suggest`, `sketch-solve`, `material-recommend`
  (`packs/feature.cad.nodes/pack.json`). Agent pack ships the **CAD Modeler** whose
  `toolAllowlist` is `canvasRead` + all seven CAD nodes
  (`packs/feature.cad.agents/pack.json:29-40`).
- **No `WorkflowDefinition` is declared by either feature** — grep for
  `workflowId`/`startWorkflowRun` over both packages hits only
  `canvasTypeId`/`artifactTypeId` registrations
  (`backend/typescript/src/features/{drawings,cad}/{routes,artifactTypes}.ts`).

### What actually creates runs / offers tools — the load-bearing gap
The ignition path for "generate via chat" is the agent tool loop. Both entry
points build the offered tool surface **identically**:
- inline chat turn: `compileAgentTools(agent, builtinAgentToolIds(), toolProvider.resolveTool, effectiveToolAllowlist(...))` (`backend/typescript/src/host/conversationToolLoop.ts:304`), and if the result is empty the turn returns `null` and takes NO tool loop (`:305`).
- @mention deep-investigation: the agent-mention workflow wraps `agent-runner`
  (`backend/typescript/src/host/agentMentionWorkflows.ts:24-40`), whose node passes
  `availableTools: [...builtinAgentToolIds()]` and a BUILTINS-only resolver
  (`backend/typescript/src/host/agentRunnerNode.ts:116-139`).

`filterTools(available, allowlist)` is a plain set-intersection —
`available.filter(t => allow.has(t))` (`backend/typescript/src/host/agentDispatch.ts:185-189`).
`available` is `builtinAgentToolIds()` = `BUILTINS.keys()`
(`backend/typescript/src/host/agentToolProvider.ts:426-428`), and `resolveTool`
is `(name) => BUILTINS.get(name)?.def` (`:505`). `BUILTINS` is the static builtin
map (`:413-422`) plus whatever features register via `registerFeatureAgentTool`
(`:441-443`).

**Pinned fact:** neither `openwop:core.coordination.canvasRead` nor
`openwop:feature.drawings.nodes.render` nor any `openwop:feature.cad.nodes.*`
is in `BUILTINS` and **none is registered by any `registerFeatureAgentTool`
caller** (full enumeration of every registered tool id — 38 tools across
`features/*/agentTools.ts` + `workflowComposeTool.ts` + `walkthroughAuthorTool.ts`
— contains no `canvas*` and no drawings/cad `render`). `canvasRead`/`canvasWrite`/
`canvasCreate` exist only as **workflow nodes** in `packs/vendor.myndhyve.canvas/index.mjs:67-201`,
runnable by the executor, invisible to the chat tool loop. The ADR 0315 baseline
that every agent also gets (`DEFAULT_ON_AGENT_TOOL_IDS`,
`backend/typescript/src/host/agentToolAllowlistService.ts:62-69`) is `kanban.add-todo`,
`documents.draft`, `email.draft`, `notifications.notify-me`,
`tasks.schedule-followup`, `ai.research.web` — its own comment states
"ids that don't resolve on this host are inert" (`:60-61`).

**Consequence:** the Illustrator/CAD Modeler agents resolve to **only the six
generic baseline tools** — none of which produces a `canvas.drawing`/`canvas.cad`
artifact. The prompts instruct the model to "call
`openwop:feature.drawings.nodes.render` exactly once"
(`packs/feature.drawings.agents/prompts/illustrator.md`) / read via `canvasRead`
before revising — tools the runtime never offers. This is the **same phantom
allowlist the LLM-EXCHANGE-AUDIT itself named** in Wave 1 (`XCH-ADS-1`), and the
Wave-4 "canvasRead allowlisted on cad/drawings" line (`docs/steward/LLM-EXCHANGE-AUDIT.md:151`)
edited pack.json without wiring resolution.

**Independent corroboration:** the a10 review (interactive-artifacts, same
Visualizer pattern) reached the identical verdict citing the same lines —
`docs/chat-first-port/a10-interactive-artifacts-code-exec.md:96-97,125-130`.

### What the canvas half DOES ride (clean)
- Both register a `CanvasEditorDefinition` and mount the shared `CanvasEditorPage`
  (`frontend/react/src/features/drawings/definition.tsx:148-226` +
  `DrawingsEditorPage.tsx:11-13`; `frontend/react/src/features/cad/definition.tsx:87-138`).
- Backend routes are a pure call into the shared `registerCanvasEditorRoutes`
  factory, type-pinned + `collab:true` + `collabShape` + closed-world `validate`
  (`backend/typescript/src/features/drawings/routes.ts:12-27`;
  `backend/typescript/src/features/cad/routes.ts:32-44`). Version history, blank
  state, CAS save, collab socket, tenancy — all inherited from the chassis.
- The ONE scene renderer is shared between the chat artifact card and the editor
  preview (`DrawingContentView` / `CadContentView`, imported by both the
  definition and `chat/artifacts/{DrawingPreview,CadPreview}.tsx`).
- CAD's three host-extension routes (`/canvases/import`, `/:id/export`,
  `/:id/bom`, `/meshes/:id`) are real and reachable from the editor toolbar
  (`InteractiveCad.tsx:141,181`), content-address + Media-capability-URL backed
  (`backend/typescript/src/features/cad/routes.ts:45-141`).

---

## Step 2/3 — Verdict table (per capability, with the ten tests folded in)

| # | Capability (today) | Verdict | Port target |
|---|---|---|---|
| 1 | **Drawings — "generate a drawing with the AI chat"** (Illustrator agent → `render` node) | **THEATER** — render tool unresolvable, dropped (`agentToolProvider.ts:505`, `agentDispatch.ts:185`); no workflow igniter either | register `openwop:drawings.render` via `registerFeatureAgentTool` (the `app-builder.render` precedent, `app-builder/agentTools.ts:44`) that runs the render node + emits the artifact + `workflow_run` turn |
| 2 | **Drawings — agent reads current shapes before revising** (`canvasRead`) | **THEATER** — `canvasRead` is a workflow node, never a chat builtin | a shared `openwop:canvas.read` builtin (cross-cutting — see Deferred) |
| 3 | Drawings — full-screen create/edit (adders, property panel, direct-manipulation, ink tools, undo/redo depth 200, grid/guides/symmetry) | **RIDES** | leave — `CanvasEditorPage` + `CanvasEditorDefinition` |
| 4 | Drawings — version history | **RIDES** | leave — chassis |
| 5 | Drawings — real-time collab | **RIDES** | leave — ADR 0359 `collab:'elements'` / `collabShape` |
| 6 | Drawings — inline safe-SVG chat card (`DrawingContentView`, the one renderer) | **RIDES** | leave — ADR 0069 artifact workbench |
| 7 | Drawings — "Open in editor" deep-link from chat card | **PAGE-LEGIT** | keep — `/drawings/:id` deep-link |
| 8 | Drawings — `canvas.drawing` artifact type + closed-world validation | **RIDES** | leave — host artifact registry |
| 9 | Drawings — image shape via media library (mediaRef widget) | **RIDES** | leave — Media owner |
| 10 | **CAD — "generate a 3D model with the AI chat"** (CAD Modeler → `render`) | **THEATER** — same unresolved-tool drop | register `openwop:cad.render` builtin, same shape as #1 |
| 11 | CAD — full-screen editor (solids/dimensions/materials, direct-manipulation) | **RIDES** | leave — chassis + two element collections |
| 12 | CAD — version history | **RIDES** | leave — chassis |
| 13 | CAD — real-time collab | **RIDES** | leave — ADR 0359 |
| 14 | CAD — inline orthographic projection chat card (`CadContentView`) | **RIDES** | leave — ADR 0069 |
| 15 | CAD — "Open in editor" deep-link | **PAGE-LEGIT** | keep |
| 16 | CAD — `canvas.cad` artifact type + validation | **RIDES** | leave |
| 17 | CAD — mesh import (STL/OBJ/GLTF → content-addressed asset + new canvas) via editor toolbar route | **ADAPTER** | leave — thin route over Media/content-address |
| 18 | CAD — mesh export (STL/GLB → Media capability URL) | **ADAPTER** | leave — deterministic codec, slides pattern |
| 19 | CAD — BOM generate + CSV (deterministic host generator → Media asset) via editor toolbar | **ADAPTER** | leave |
| 20 | CAD — mesh-asset META read route | **PAGE-LEGIT** | keep — read-only projection, 404 cross-tenant |
| 21 | **CAD — the six advanced agent tools** (`mesh-import/export`, `bom-generate`, `dimension-suggest`, `sketch-solve`, `material-recommend`) offered to the CAD Modeler | **THEATER** — all six are pack-node ids, unresolvable as chat tools; the model is told it can call them and cannot | register the value-adding ones as real builtins alongside #10; `dimension-suggest`/`sketch-solve`/`material-recommend` already exist as **editor-side** compute (`cad/cadDims.ts`, `cadSketch.ts`, `cadMaterials.ts`) so the capability is real in the editor — only its *agent* projection is fake |

**Tally: RIDES = 11 · ADAPTER = 3 · PARALLEL = 0 · THEATER = 3 · PAGE-LEGIT = 3.**

Port-test notes worth surfacing:
- **Agency test (fail):** both personas are read-only-in-practice — every
  action tool they declare is inert, so they are toothless (rows 1,2,10,21).
- **Ignition test (fail):** the `render` nodes have **no igniter at all** — not
  the agent (dropped), not a declared workflow (none exists), not the scheduler.
  The only live consumer is a user hand-wiring the node in the builder catalog.
- **HITL / SSoT / authority-parity tests (pass):** canvas save is the chassis
  CAS validate→persist; no bespoke approve/submit buttons; validators are the
  closed-world SSoT with FE bounds explicitly mirrored + drift-pinned
  (`definition.tsx:75-90`, `drawingBounds.test.ts`).
- **Card-mechanism test (pass):** the drawing/CAD cards are app-known typed
  shapes rendered by a typed registered renderer — correct per the ten-point
  matrix; no A2UI misuse.

---

## Blockers (from scouting) — each with the honest alternative

- **B1 — the advertised primary capability is unwired.** "Generate with the AI
  chat" cannot work while `render`/`canvasRead` sit in the pack allowlist as
  bare node typeIds. **Alternative (proven):** copy the app-builder reference —
  `registerFeatureAgentTool({ name: 'openwop:drawings.render', … run: runs the
  render node under a synthesized `NodeContext` and returns the emitted
  artifact })`, then point the pack allowlist + prompt at that builtin id. The
  `computeNodeTool` helper (`agentToolProvider.ts:50-80`) is 90% of the body;
  the only addition is surfacing the `artifact` output as a chat `workflow_run`
  turn so it renders in the card (the emit path the render node already returns).
- **B2 — `canvasRead` (read-before-write) is a platform hole, not a local fix.**
  Five agents (drawings, cad, slides, campaign-studio, interactive-artifacts)
  allowlist it and none can call it. **Alternative:** a single shared
  `openwop:canvas.read` builtin that shares the canvas route's access predicate
  (one helper, route + tool both call it; fail-EMPTY without an acting user).
  File it as a cross-cutting TODO; until it lands, the "read the real current
  shapes before revising" prompt rule is a lie and should be dropped from the
  prompts.
- **B3 — no factory workflow to fall back on.** Because neither feature ships a
  `WorkflowDefinition`, there is no non-chat ignition either. Not a blocker to
  fix directly (the chat tool is the right primitive), but it means B1 is the
  *only* path to the advertised capability — there is no hidden second one.

---

## Demolition list (with regression pins)

Little bespoke UI to demolish — the editors are legitimate canvas-chassis
consumers. The demolition here is of **dishonest declarations**, not screens:

1. Remove `openwop:feature.drawings.nodes.render` / `…cad.nodes.*` /
   `core.coordination.canvasRead` from the two agent packs' `toolAllowlist`
   **once replaced** by the registered builtins (B1) — or they remain phantom.
   **Pin:** extend the repo-wide `agent-prompt-tool-ids` test so every
   `toolAllowlist` entry MUST resolve against `builtinAgentToolIds()` — a
   phantom entry fails CI. (This test would have caught the whole class today.)
2. Drop the "call `openwop:feature.…render` / `canvasRead`" instructions from
   `illustrator.md` / `cad-modeler.md` until the real tools exist. **Pin:** the
   existing `promptCatalogParity.test.ts` per feature, extended to assert the
   prompt only names **resolvable** tool ids.

---

## New-code inventory (small)

- `features/drawings/agentTools.ts` — one `registerFeatureAgentTool` for
  `openwop:drawings.render` (runs `feature.drawings.nodes.render`, returns the
  artifact); wire it from `drawings/feature.ts` `registerRoutes`.
- `features/cad/agentTools.ts` — `openwop:cad.render` plus the value-adding CAD
  builtins that have no editor equivalent (`bom-generate`, `mesh-export`); the
  three deterministic FE-covered ones (dims/sketch/materials) are optional.
- **Cross-cutting (shared, not in this unit's budget):** one
  `openwop:canvas.read` builtin (B2) + the `agent-prompt-tool-ids` resolvability
  assertion.
- Prompt edits: point both prompts at the new builtin ids; remove the uncallable
  `canvasRead` rule until B2 lands.

Everything else (editors, renderers, routes, artifact types, mesh/BOM adapters)
is **untouched** — it already rides the owners.

---

## Phased plan (gated on real gates)

1. **Phase 1 — stop lying (compliance-first).** Extend `agent-prompt-tool-ids`
   to fail on any unresolvable `toolAllowlist` id; that turns the current state
   red. Drop the uncallable ids/prompt rules so the suite is honest-green.
   Gate: `npm run ci`.
2. **Phase 2 — ignite drawings.** Add `openwop:drawings.render` builtin +
   `registerFeatureAgentTool`; repoint the Illustrator allowlist + prompt; assert
   an end-to-end dispatch test that the agent call emits a valid `canvas.drawing`
   artifact + a `workflow_run` turn. Gate: backend vitest + `/code-review`.
3. **Phase 3 — ignite CAD.** Same for `openwop:cad.render` (+ `bom`/`mesh-export`
   if desired). Gate: vitest + `/code-review` + `/ux-review` on the chat card.
4. **Phase 4 — file the cross-cutting `canvas.read` TODO** (B2) and, if picked
   up, add the shared builtin with route-predicate parity + fail-empty test.

Each phase closes with `/code-review` + `/ux-review` and fixes applied; no
demolition (Phase 1 prompt-rule removal) precedes its replacement landing
(Phase 2/3), except the honest removal of claims that never worked.

---

## Deferred honestly

- **`openwop:canvas.read` as a conversational capability (B2)** is a
  platform-wide gap touching five features; deferred to a cross-cutting change,
  stated as a filed TODO rather than a local drawings/cad workaround. Until it
  lands, "the agent reads the real current canvas before revising" is **not
  true** for either feature and the prompts must not claim it.
- **`dimension-suggest` / `sketch-solve` / `material-recommend` as agent tools**
  are deferred, not faked: the underlying compute already exists and is reachable
  in the editor (`cad/cadDims.ts`, `cadSketch.ts`, `cadMaterials.ts`); only the
  agent projection is missing, and it is optional value, not the headline.
