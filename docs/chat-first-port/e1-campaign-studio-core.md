# Campaign Studio core (unit E1) — chat-first port review

**Scope:** `backend/typescript/src/features/{campaigns, campaign-studio}` +
`frontend/react/src/features/{campaigns, campaign-studio}` and their two packs
(`packs/feature.campaign-studio.{nodes,agents}`). Two features share the name:

- **`campaign-studio`** — the ADR 0153 in-chat **canvas** (`canvas.campaign`) + the
  ADR 0310 full-screen **editor**. This is the substantive half.
- **`campaigns`** — a **frontend-only console** (ADR 0200) that tabs the *other*
  `campaign-*` chain features (Briefs/Performance/Intelligence — those are separate
  review units). Backend `feature.ts` is toggle-only.

**Headline verdict:** the full-screen editor and its collab/graph/validation genuinely
**ride the shared canvas chassis** — nothing to port there. But the flagship capability
the feature advertises everywhere — *"design a multi-channel campaign by chatting with
the Campaign Strategist"* — is **THEATER**: the agent's two allowlisted tools resolve to
**nothing** in the chat tool loop, no workflow ignites the render node, and no
`registerFeatureAgentTool` bridge exists. A user can select "Campaign Strategist" in the
ONE chat, ask for a campaign, and **no `canvas.campaign` artifact is ever produced**. The
in-chat card and its "Open in editor" button (real, registered UI) are consequently
**unreachable**.

---

## Verdict table

| # | Capability | Today | Verdict | Port target |
|---|---|---|---|---|
| 1 | Full-screen editor (channels/funnel/assets lists, objective/audience, undo/redo, version history) | `registerCanvasEditorRoutes` → `CanvasEditorPage` | **RIDES** | Leave. Real canvas-chassis consumer (ADR 0310 Phase C). |
| 2 | Create a blank campaign canvas (creation hub / direct nav) | `creatableTypes.ts` + `blankState` | **RIDES** | Leave. Chassis creation path, agent-independent. |
| 3 | Funnel board (graph trait, x/y positions) | `campaignGraph` graph trait | **RIDES** | Leave (ADR 0360). |
| 4 | Real-time collaboration on a campaign | `collab: true` / `collab: 'elements'` | **RIDES** | Leave (ADR 0359 Phase 5/6). |
| 5 | Closed-world validation → 422 | `validateCampaignDoc` (hand-mirror of the artifact schema) | **ADAPTER** | Leave; drift-pinned by `promptCatalogParity`/cap tests. Watch the hand-mirror. |
| 6 | Export (json/pdf) | artifact-type `export: ['json','pdf']` (pdf via Documents render) | **ADAPTER** | Leave; rides the shared export path. |
| 7 | **Design a campaign by describing intent in chat** | Campaign Strategist agent + `feature.campaign-studio.nodes.render` | **THEATER** | Register a real render deliverable tool (app-builder `renderDesign` precedent) so the agent can actually emit `canvas.campaign`. |
| 8 | **Revise an existing campaign in chat** (read-before-write) | `core.coordination.canvasRead` in the allowlist | **THEATER** | Ship a feature-local `get-design`/canvas-read tool; the invariant can't even run today. |
| 9 | In-chat inline campaign card + "Open in editor" | `CampaignPreview` + `registerArtifactRenderer` | **PAGE-LEGIT** (but currently dead) | Keep the renderer; it is honest — it is simply never fed. Fixing #7 makes it reachable. |
| 10 | Campaign Studio console (tabbed hub) | `visibleHubRoutes(FEATURES, …)` projection | **PAGE-LEGIT** | Leave. Hub projection over the FEATURES SSoT, honest empty state, no wire/store. |

**VERDICTS: R=4 A=2 P=0 T=2 PL=2.**

This is an **under-built THEATER, not an over-built PARALLEL** — there is nothing to
demolish. The bespoke surfaces (console, editor, inline card) are all legitimate; the
defect is a *missing* bridge between three real pieces (persona, node, renderer) that
were shipped but never connected.

---

## Contract scouting — pinned evidence

### The declared chat orchestration
- The `campaign-studio` feature declares an agent pack + node pack as `requiredPacks`
  (`backend/typescript/src/features/campaign-studio/feature.ts:31-34`).
- The **Campaign Strategist** agent allowlists exactly two tools
  (`packs/feature.campaign-studio.agents/pack.json` → `toolAllowlist`):
  `openwop:core.coordination.canvasRead` and
  `openwop:feature.campaign-studio.nodes.render`.
- Its prompt instructs the model to "call `openwop:feature.campaign-studio.nodes.render`
  exactly once" and to read via `openwop:core.coordination.canvasRead`
  (`packs/feature.campaign-studio.agents/prompts/campaign-strategist.md:11-17`).
- The render node is a valid pure transform that emits
  `{ artifactTypeId: 'canvas.campaign', payload, title }`
  (`packs/feature.campaign-studio.nodes/index.mjs:56-70`).

### What actually creates runs of it — nothing
- The chat tool loop compiles an agent's tools as
  `compileAgentTools(agent, builtinAgentToolIds(), resolveTool, …)`
  (`backend/typescript/src/host/conversationToolLoop.ts:304`), which does
  `filterTools(available, allow)` = **set-intersection**
  (`backend/typescript/src/host/agentDispatch.ts:185-189`, `481-489`), then resolves each
  survivor via `resolveTool = BUILTINS.get(name)`
  (`backend/typescript/src/host/agentToolProvider.ts:505`).
- `builtinAgentToolIds()` returns only the `BUILTINS` map keys
  (`agentToolProvider.ts:413-428`): `knowledge.search`, `schema.lookup`, `ai.research.web`,
  `core.openwop.http.fetch`, `code-exec.nodes.run`, `kanban.add-todo`, the RAG retrievers,
  the workflow-compose tool, and the **two** projectable compute nodes
  (`PROJECTABLE_COMPUTE_NODE_TYPE_IDS = [insights-suite.variance-compute,
  insights-suite.talent-score]`, `agentToolProvider.ts:45-48`) — plus whatever features
  register via `registerFeatureAgentTool`.
- **Neither `core.coordination.canvasRead` nor `feature.campaign-studio.nodes.render` is in
  that set.** `campaign-studio` has **no `agentTools.ts`** and calls
  **`registerFeatureAgentTool` zero times** (its `feature.ts:15-18` registers only the
  artifact type + editor routes). Grep across `backend/typescript/src` +
  `packs` + `examples` finds **no `startWorkflowRun`, no `builtinWorkflows`, and no workflow
  definition** referencing `feature.campaign-studio.nodes.render` — the only two mentions are
  the node pack's own export and the agent prompt.
- **Consequence:** `filterTools` drops both ids → the Campaign Strategist compiles to an
  **empty toolset**. The model is told to call a tool that is never advertised to it, so it
  cannot; it can only emit prose. No `canvas.campaign` artifact is created from chat, ever.

### Why the tripwire missed it (the real lesson)
`backend/typescript/test/agent-prompt-tool-ids.test.ts` (the XCH-AGT-1 lint) builds its
"resolves" universe from **(1) every pack-declared node typeId, (2) host-registered nodes,
(3) host agent tools** (lines 28-54). `feature.campaign-studio.nodes.render` is a
*pack-declared node typeId*, and `core.coordination.canvasRead` is declared by
`vendor.myndhyve.canvas` — so **both pass the lint** (line 60-65). The lint proves an id
*exists somewhere*; it does **not** prove the id is **projectable into the chat context
where the prompt runs**. A node typeId is chat-callable only if it is in
`PROJECTABLE_COMPUTE_NODE_TYPE_IDS`, registered via `registerFeatureAgentTool`, **or**
reachable through a workflow the chat can ignite. The campaign render node is none of the
three. **This is the missing tripwire** (see Deferred).

### The working contrast (so the alternative is grounded)
- **app-builder** ships the correct bridge: `registerAppBuilderAgentTools()` registers a
  catalog tool, a `get-design` (read-before-write) tool, **and** a render deliverable tool
  that resolves the render node via `getNodeRegistry()`, executes it, persists a real
  canvas, and returns `{ canvasId, url }`
  (`backend/typescript/src/features/app-builder/agentTools.ts:91-160`;
  `renderCore.ts:42-70`).
- **slides** does not register a render tool either, but it *does* register a real
  `builtinWorkflows: [slidesDesignWorkflowDefinition]`
  (`backend/typescript/src/features/slides/feature.ts:54-55`,
  `designWorkflow.ts:28-31`) — a genuine igniter path. **campaign-studio has neither** the
  registered tool nor the builtin workflow.

### The dead card (honesty loop open)
- The FE renderer is correctly registered:
  `registerArtifactRenderer({ artifactTypeId: 'canvas.campaign', … CampaignPreview })`
  (`frontend/react/src/chat/artifacts/defaultRenderers.tsx:79`;
  routing in `ArtifactViews.tsx:34`).
- `CampaignPreview` renders a provenance-gated **"Open in editor"** →
  `/campaign-studio/new?fromArtifact=<runId:nodeId>`
  (`frontend/react/src/chat/artifacts/CampaignPreview.tsx:96-111`).
- Both are honest UI — but their **producer (#7) never fires**, so the entire inline-card
  path is unreachable through the chat the feature points users at.

### The editor is real and agent-independent
`registerCanvasEditorRoutes` binds `canvas.campaign` to the shared canvas-editor factory
with `collab: true`, `validate: validateCampaignDoc`, and a `blankState`
(`backend/typescript/src/features/campaign-studio/routes.ts:12-27`); the FE
`campaignStudioDefinition` is a genuine multi-collection elements-trait consumer
(`frontend/react/src/features/campaign-studio/definition.tsx:49-104`). Reachable via the
creation hub (`creatableTypes.ts:35`) and direct nav — this half needs no port.

---

## Blockers (from scouting) — each with the honest alternative

- **B1 — The render node is not chat-callable.** `feature.campaign-studio.nodes.render`
  is a pack node typeId, not a builtin agent tool, so the chat loop can never advertise it
  (`agentToolProvider.ts:413`, `agentDispatch.ts:185`). *Alternative:* register a
  feature-local render deliverable tool from a new `campaign-studio/agentTools.ts`,
  mirroring `renderCore.renderDesign` — resolve the node via `getNodeRegistry()`, execute
  with a synthesized ctx, return the `canvas.campaign` artifact so it emits inline. Toggle-
  gated (`campaignStudioEnabled`), sharing the editor route's access predicate.

- **B2 — `core.coordination.canvasRead` is not a builtin tool anywhere.** It is a
  `vendor.myndhyve.canvas` node typeId (`packs/vendor.myndhyve.canvas/pack.json`), mapped
  as a *surface prefix* only (`bootstrap/hostSurfaceMap.ts:109`). **No** host builtin named
  `canvasRead` exists — and slides/drawings/cad/interactive-artifacts allowlist the same
  phantom id. *Alternative for E1:* ship a feature-local `campaign-studio.get-design` tool
  (app-builder `get-design` precedent) so "read before you write" holds without waiting on
  the platform. The shared `canvasRead` builtin is a **cross-cutting hole to file**, not to
  fix inside this feature (see Deferred).

- **B3 — No igniter and no builtin workflow.** Unlike slides, `campaign-studio/feature.ts`
  registers no `builtinWorkflows` and nothing calls `startWorkflowRun`. *Alternative:* the
  register-a-tool path (B1) is the smaller, better-precedented fix than standing up a design
  workflow; the render node is a single pure transform, so a tool wrapper is sufficient.

- **B4 — The lint that should catch this is structurally blind to it.** `agent-prompt-tool-
  ids.test.ts` treats any declared node typeId as "resolves." *Alternative:* add a
  chat-resolvability assertion (below) — this is the regression pin that makes #7's fix
  durable and would have failed the day the persona shipped toothless.

---

## Demolition list (with regression pins)

Nothing bespoke to demolish — the console, editor, and inline card are all keep-worthy.
The pins here **lock the THEATER fix in place**, so a regression re-toothless-es CI:

- **Pin P1 (the missing tripwire):** a test asserting **every id in every canvas agent
  pack's `toolAllowlist` is chat-resolvable** — i.e. present in `builtinAgentToolIds()`
  after feature init (or explicitly ignited by a registered `builtinWorkflows` entry).
  Scoped to `feature.campaign-studio.agents` for E1; generalizable. **Fails today**, passes
  once B1/B2 land. This is the highest-value single artifact of the review.
- **Pin P2:** an integration test that dispatching the Campaign Strategist against a
  "make me a launch campaign" task produces a `canvas.campaign` artifact (asserts the
  emit path, not just prose). Fails today.
- **Pin P3 (drift guard, already partially present):** keep `promptCatalogParity.test.ts`
  pinning the channel/stage vocab to `validateCampaignDoc`; extend it so a render-tool
  input schema (if added) is generated from / pinned to the artifact-type SSoT, never
  hand-copied.

---

## New-code inventory (small)

- **`backend/typescript/src/features/campaign-studio/agentTools.ts`** — NEW.
  `registerCampaignStudioAgentTools()` registering:
  - a **render** deliverable tool (validate → execute the render node → emit
    `canvas.campaign`), toggle-gated, sharing the editor route predicate;
  - a **get-design / canvas-read** tool (read-before-write), feature-local until the
    platform `canvasRead` builtin exists.
- **`campaign-studio/feature.ts`** — one line: call `registerCampaignStudioAgentTools()`
  in `registerRoutes` (the `registerSlidesAgentTools()` precedent).
- **Agent pack** — repoint `toolAllowlist` to the real registered tool ids (drop the
  phantom `core.coordination.canvasRead` if the feature-local read tool is used); update
  the prompt to name them.
- **Tests** — Pins P1/P2 above (P3 already exists, extend).
- **No new wire, no RFC** — this is host-side tool wiring on an already-Accepted seam
  (ADR 0308 `registerFeatureAgentTool` / ADR 0058 chat-drivability).

---

## Phased plan (gated on real gates; compliance seams first)

1. **Phase 0 — expose the lie.** Land Pin P1 (chat-resolvability lint) + P2 (emit
   integration test) *red*. This makes the THEATER a failing gate before any fix, and
   prevents a "green by narrowing" regression. Close with `/code-review`.
2. **Phase 1 — the bridge.** Add `agentTools.ts` (render + get-design), wire from
   `feature.ts`, repoint the pack allowlist + prompt. P1/P2 go green. `/code-review` +
   `/ux-review` (the inline card + "Open in editor" now reachable — verify the round-trip
   into the editor loads the artifact payload).
3. **Phase 2 — grade + harden.** `/grade-ai-exchange` on the new render tool (schema from
   SSoT, one bounded error-fed repair, validated persist), `/grade-code`. Apply fixes.
4. **No demolition phase** — nothing to remove.

---

## Deferred honestly

- **Shared `core.coordination.canvasRead` builtin is a platform hole, not an E1 fix.**
  slides, drawings, cad, and interactive-artifacts all allowlist the same phantom id; their
  real authoring rides `builtinWorkflows` / other igniters, and their prompts may run in a
  workflow-run context (`agentRunnerNode.ts:132`) whose `availableTools` differ from the
  free chat loop — so I am **not** asserting those features are equally broken in every
  context without dispatch-tracing each. **File a cross-cutting TODO:** either promote a
  real `canvasRead` builtin or audit each canvas agent's chat-vs-workflow dispatch path.
  E1 ships a feature-local read tool in the meantime.
- **Whether the other canvas personas are toothless in the *free chat* loop** is an audit
  follow-up beyond this unit's scope; flagged, not fixed here.
- **The `campaigns` console** legitimately shows a designed empty state when no `campaign-*`
  sub-feature is enabled (`CampaignStudioHubPage.tsx:47-48`) — that is honest, not deferred.
