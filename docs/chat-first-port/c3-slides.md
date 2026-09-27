# Slides (unit C3) — chat-first port review

Scope: `backend/typescript/src/features/slides` + `frontend/react/src/features/slides`
+ packs `feature.slides.nodes` / `feature.slides.agents`. Context: ADR 0328
(slides best-in-class). Feature toggle `slides` ships ON.

**Headline:** the *canvas/editor/present/export/share* half of Slides genuinely
rides the platform (canvas chassis, coordination tools, sharing/media owners) —
almost nothing to port there. But the **AI half is theater**: the Slide
Designer agent allowlists two tools that no registrant provides
(`feature.slides.nodes.render`, `feature.slides.nodes.restyle`) so they resolve
to nothing at dispatch, and the `slides.design` outline-first workflow (the
ADR 0328 P6 centerpiece, with its HITL outline gate) has **no chat-reachable
igniter**. This is the exact bug app-builder already found and fixed
(ADR 0358) — Slides only got half the fix.

---

## Verdict table

| # | Capability | Today | Verdict | Port target |
|---|---|---|---|---|
| 1 | "Quick deck now" from chat (Slide Designer → `render` node-tool) | Agent allowlists `openwop:feature.slides.nodes.render`; prompt says "call it exactly once" | **THEATER** — tool never resolves (`agentToolProvider.ts:505`); degrades to raw `canvasWrite` of a *persistent* canvas, never the inline chat artifact card the feature is premised on | Register a real `openwop:slides.render` deliverable tool (app-builder `renderCore` precedent): normalize → `validateSlidesDoc` → one repair loop → emit the `canvas.slides` artifact |
| 2 | Restyle a deck from chat (`restyle` node-tool) | Allowlisted `openwop:feature.slides.nodes.restyle`; prompt teaches it | **THEATER** — same non-resolution; content-preservation-by-construction is lost | Register `openwop:slides.restyle` (thin wrapper over the pack's restyle node via the executor, or a style-only canvasWrite path) |
| 3 | `slides.design` outline-first chain (brief→outline→**outline gate**→draft→deepen→notes→audit→**review**) | Declared as `builtinWorkflows` | **THEATER** — no igniter: builtins are omitted from the chat mention list (`workflows.ts:211`), the agent has no start/compose tool, no FE launcher, and the prompt tells the agent to "offer to start it" with no tool to do so | Give the agent a `startWorkflowRun`-backed tool (kicktodo `KICKTODO_REPLAN`/challenge-factory precedent) OR add builtins to the chat launcher |
| 4 | Edit an existing deck from chat | `canvasRead` + `canvasWrite` (both real, host.canvas surface) | **RIDES** | none |
| 5 | Fetch closed block catalog (`slides.catalog`) | `registerFeatureAgentTool`, generated from the SSoT | **RIDES** | none (this is the *one* correctly-wired agent tool) |
| 6 | Full-screen editor (slide strip, reorder/rename/duplicate, property panel, undo/redo, version history) | `CanvasEditorPage` bound to `slidesDefinition` | **RIDES** | none |
| 7 | Interactive preview | `CanvasPreviewPage` | **RIDES** | none |
| 8 | Present mode (presenter window, phone remote, kiosk, builds/transitions) | `CanvasPresentPage` + `presentOutline` projection | **RIDES** | none |
| 9 | Collab editing | chassis element-binding (`collab:true` / `collab:'elements'`) | **RIDES** | none |
| 10 | `canvas.slides` artifact type + inline `SlidesContentView` renderer | `registerArtifactType` + renderer registry | **RIDES** (but starved — nothing chat-reachable *emits* one; see #1/#3) | fixed once #1 or #3 lands |
| 11 | Toggle / admin gating | `toggleDefault` + `authorizeOrgScope` | **RIDES** | none |
| 12 | Export pptx/pdf | real route → Media asset via capability token | **ADAPTER** | none (watch for drift) |
| 13 | Import pptx (text-fidelity) | real parse → new canvas, honest `skipped[]` | **ADAPTER** | none |
| 14 | Public shared-deck viewer (notes-free pager + per-frame analytics) | `sharing` owner `createLink` + `SharedDeckViewer` | **PAGE-LEGIT** | none |

**Counts: R=8 A=2 P=0 T=3 PL=1**

---

## Blockers (from scouting) — each with the honest alternative

**B1 — The two headline agent tools do not exist at runtime.**
`packs/feature.slides.agents/pack.json` allowlists `openwop:feature.slides.nodes.render`
and `openwop:feature.slides.nodes.restyle`. Resolution is
`resolveTool = (name) => BUILTINS.get(name)?.def` (`agentToolProvider.ts:505`).
Those ids are (a) not in the static `BUILTINS` list, (b) not registered via
`registerFeatureAgentTool` — `slides/agentTools.ts:15-28` registers **only**
`openwop:slides.catalog`, (c) not in `PROJECTABLE_COMPUTE_NODE_TYPE_IDS`, which
holds only two insights-suite compute nodes (`agentToolProvider.ts:45-48`), and
(d) not matched by any `core.*` host-surface-map prefix (`hostSurfaceMap.ts:25-118`
— every node projection is `core.*`/`kanban.*`/`knowledge.*`, none `feature.*`).
So both resolve to `undefined` and are silently dropped from the turn's tool set.
This is verbatim the app-builder incident: *"the App Architect pack allowlisted
`openwop:feature.app-builder.nodes.render` — a tool NO host registrant provided —
so every chat turn resolved zero tools and fell back to a plain completion"*
(`app-builder/agentTools.ts:6-9`). App-builder fixed it with clean-id tools
(`registerAppBuilderAgentTools()` at `app-builder/feature.ts:41`). Slides' XCH-SLIDES-1
pass added only the *catalog* half of that fix (`slides/feature.ts:33`), never the
render/restyle deliverable tools.
**Honest alternative:** register `openwop:slides.render` and `openwop:slides.restyle`
exactly like `renderCore.ts` — validate (`validateSlidesDoc`) → one repair loop →
emit `canvas.slides`; gates mirror the HTTP editor path (`slides` toggle fail-closed,
acting user required, org RBAC). Repoint the pack allowlist + prompt to the clean ids.

**B2 — `slides.design` has no chat-reachable igniter.**
The only references to `SLIDES_DESIGN_WORKFLOW_ID` are its own definition
(`designWorkflow.ts:28,31`) and `feature.ts:55` (`builtinWorkflows`). The chat's
`@`/`/` picker sources workflows from `listWorkflowSummaries`
(`chat/lib/workflowMentions.ts`), which calls `GET /v1/host/openwop-app/workflows`
— and that route returns `listOwned(tenant)` only (`workflows.ts:211-235`).
Built-ins register with **no ownership row**, so they are structurally invisible to
the launcher (the same "listWorkflowSummaries omits builtins" trap logged in
ADR 0461). The Slide Designer's allowlist contains no `startWorkflowRun`/compose
tool, so the agent cannot start it either — yet the prompt instructs it to "offer
to start it with their brief" (`prompts/slide-designer.md`). Result: the entire
outline-first chain, including the HITL **outline gate** (`designWorkflow.ts:44-52`)
and **review gate** (`designWorkflow.ts:76-83`), is unreachable from the product's
chat-first surface.
**Honest alternative:** the kicktodo precedent — an agent tool that calls
`startWorkflowRun` for a named builtin and posts the authoritative `workflow_run`
turn (`KICKTODO_REPLAN_WORKFLOW_ID` in `kicktodo-core/agentTools.ts`,
`CHALLENGE_FACTORY_WORKFLOW_ID` in `kicktodo-creator/challengeAuthorService.ts`).
Grant the Slide Designer a `openwop:slides.design.start { brief }` tool. (Fixing
the launcher to include builtins is the broader platform fix — file it, don't
special-case it here.)

**B3 — The "inline deck in the chat artifact workbench" premise depends on B1/B2.**
`feature.ts:1-10` and `artifactTypes.ts:1-7` state the deck renders inline in chat
via a run emitting `canvas.slides` (run-output producer). Both emit paths are the
render node (B1) and the `slides.design` workflow (B2). With both dead, the agent's
only working authoring path is `canvasWrite`, which creates a **persistent** canvas
(`canvasSurface.ts`) reachable at `/slides/:canvasId` — not an inline `artifact.created`
card in the chat feed. So the flagship demo ("a deck rendered live in chat") does not
occur through any chat-reachable path today. Closing B1 **or** B2 restores it.

---

## Demolition list (with regression pins to add)

Slides has little bespoke UI to demolish — the editor/present/preview/share/export
surfaces are legitimate chassis pages. The demolition here is of **dead declarations**,
pinned so they cannot silently return:

- **Remove the node-typeid-shaped tool ids** from the agent allowlist once the
  clean-id tools land. **Pin:** a repo test asserting every `toolAllowlist` entry in
  every agent pack resolves via `resolveTool` (this class of bug shipped twice —
  app-builder and now slides — because no such test exists; `slides/__tests__/promptCatalogParity.test.ts`
  checks prompt↔catalog parity but never that the allowlisted tools *exist*).
- **Pin the igniter:** a test that starts `slides.design` through the same tool the
  agent uses and asserts a `workflow_run` turn + a suspended outline gate — so a
  future refactor that drops the start tool goes red.

Nothing else is a parallel implementation — do **not** demolish the editor, present,
export, import, or share surfaces (all RIDES/ADAPTER/PAGE-LEGIT).

---

## New-code inventory (small)

1. `slides/agentTools.ts` — add `registerSlidesRenderTool` + `registerSlidesRestyleTool`
   (mirror `app-builder/agentTools.ts` + `renderCore.ts`: validate → repair → emit,
   toggle/acting-user/org-RBAC gates). ~2 tools.
2. `slides/agentTools.ts` — add `registerSlidesDesignStartTool` (`startWorkflowRun` on
   the builtin + the authoritative `workflow_run` turn). ~1 tool.
3. `packs/feature.slides.agents/pack.json` — repoint `toolAllowlist` to the clean ids;
   update `prompts/slide-designer.md` accordingly; bump pack version.
4. Tests: allowlist-resolution pin (repo-wide) + `slides.design` ignition pin.

No new nodes (the pack nodes already exist), no new canvas type, no new owner, no
wire/RFC surface. Everything reuses existing primitives.

---

## Phased plan (gated on real gates)

- **Phase 1 — restore the render/restyle tools (B1).** Register clean-id deliverable
  tools; repoint pack + prompt; add the allowlist-resolution test. Gate: `npm run ci`.
  Close with `/code-review` + `/ux-review` (inline-card render check), apply fixes.
- **Phase 2 — ignite `slides.design` (B2/B3).** Add the start tool + the ignition
  test; verify the outline gate suspends inline in chat and the review gate renders.
  Gate: `npm run ci` + a live chat smoke. Close with `/code-review`, apply fixes.
- **Phase 3 — grade + sweep.** `/grade-ai-exchange` (the render tool is a model-facing
  surface — it needs its LLM-EXCHANGE-AUDIT row + tripwire) and `/grade-data` on any new
  provenance/metadata; apply fixes. No demolition precedes a working replacement.

---

## Deferred honestly

- **Making built-ins visible in the chat workflow launcher** is a platform-wide gap
  (`workflows.ts:211` lists owned-only), not a Slides bug — file it as a cross-layer
  TODO; the per-feature start tool (Phase 2) is the correct local fix and does not wait
  on it.
- **pptx import fidelity** is deliberately text-only (titles/paragraphs/notes; images/
  charts/tables recorded as `skipped[]`) — honest, not a defect; leave as-is.
- The **collab element-shape** drift pins (`collabTypes.test.ts`) are existing coverage;
  no port work needed.
