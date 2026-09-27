# App Builder (unit B2) — chat-first port review

Scope: `backend/typescript/src/features/app-builder` + `frontend/react/src/features/app-builder`.
Reference status per CLAUDE.md: the A+ "catalog → get-design → render(validate/repair/CAS)" implementation (ADR 0358), graph-first + Screens rail (ADR 0337), editor-parity program (ADR 0305 A-H), GitHub publish (0306), two-way sync (0393), governed deploy (0424).

**Headline verdict: this unit already rides the engine.** The AI authoring is the ONE chat driving a real agent with action tools; the editor is a canvas-chassis consumer; the multi-stage design pipeline is a real workflow chain on shared HITL gates; export/publish/sync/deploy are thin adapters over the owning primitives. No PARALLEL and no true THEATER were found. The one honest gap is that the *deliberate* researched/audited/reviewed chain is not chat-ignitable — the chat agent only reaches the fast direct-compose path.

## Verdict table

| Capability | Today | Verdict | Port target / note |
|---|---|---|---|
| Design an app by describing intent (App Architect) | ONE chat, agent pack `feature.app-builder.agents.default` with real tools | **RIDES** | Leave. Tools are `render`/`catalog`/`get-design` (`agentTools.ts:44-46`); no bespoke "talk to AI" surface exists |
| `render` an authored design → real canvas | agent tool → `renderCore.renderDesign` (normalize→`validateAppDoc`→CAS) (`agentTools.ts:189`, `renderCore.ts:42`) | **RIDES** | Leave. Action tool, fails typed, one repair loop; owner-stays-human provenance (`agentTools.ts:182`) |
| `catalog` / `get-design` schema + state reads | agent read tools over `projectComponentCatalog` / `getCanvasForTenant` (`agentTools.ts:93,111`) | **RIDES** | Leave. Read tools fail EMPTY when disabled (`feature_disabled`), share the route's `resolveEffectiveAccess` predicate (`agentTools.ts:80-83`) |
| Multi-stage design chain (PRD→research→plan→render→audit→review) | `app-builder.design` builtin workflow, gallery-instantiable, real BYOK AI (`designWorkflow.ts:35`, chain pack `pack.json`) | **RIDES** | Leave. Uses `core.approvalGate` ×2 + `core.clarificationGate` (shared HITL, parent-run gates); render/validate/CAS shared with the agent tool |
| Full-screen editor (palette, drag/drop, outline, properties, undo/redo, versions, share) | `CanvasEditorPage` chassis driven by typed `appBuilderDefinition` (`AppBuilderEditorPage.tsx:15`, `definition.tsx:175`) | **RIDES** | Leave. Canvas-framework consumer #1 (ADR 0310); frames+tree traits, no shadow editor |
| Graph / Screens-rail flow view + Data workspace | `appBuilderGraph` + `workspaceTabs` on the chassis definition (`definition.tsx:207,212`) | **RIDES** | Leave. Screen=node, connector=edge over the chassis graph |
| MCP control lane (7 tools) | expose-tool meta-workflows + thin backing nodes over owners (`mcpControlWorkflows.ts:44`, `mcpControlNodes.ts:57`) | **RIDES** | Leave. Backing nodes are a few lines each over `canvasSurface`/`renderCore`/share-projection/`resolveAndResume`; `resolve-paused-task` narrowed to app-builder chain interrupts (`mcpControlNodes.ts:169`) |
| Governed deploy verbs (deploy/rollback/status) | surface ops, sub-toggle `app-builder.deploy`, honest-off provider, idempotent CAS (`surface.ts:119`, `deployService.ts`) | **RIDES** | Leave. OFF by default; symbolic-env-keys-only, no credential rides input |
| Code export (framework-native ZIP) | route + `surface.export` → secret-scrubbed ZIP as Media asset + capability token, lineage side-collection (`routes.ts:104`, `surface.ts:25`) | **ADAPTER** | Leave; watch for drift. Rides Media owner + capability-token; lineage never bumps canvas version |
| GitHub publish (governed vendor write) | route-only `publishToGitHub` over `github` connection (adapterOnly, token host-side) (`routes.ts:148`, `publishService.ts`) | **ADAPTER** | Leave. Rides the governed connection owner; zero consumer nodes |
| Two-way GitHub sync (binding + webhook + push) | binding routes + public webhook lane, `host:code-sync:manage` RBAC, OFF by default (`routes.ts:50,172`) | **ADAPTER** | Leave. Rides connection + webhook lane; toggle-honest 404 on disabled tenant |
| Interactive preview + public share page | `previewRuntime` (closed action/state) + `projectAppForShare` sanitized projection (`definition.tsx:215`, `shareProjection.ts`) | **PAGE-LEGIT** | Keep. Read-only; share mint rides the sharing owner (`definition.tsx:241`) |
| Export history / lineage | side collection, newest-last read (`routes.ts:137`, `export/lineage.ts`) | **PAGE-LEGIT** | Keep. Honest provenance read |

## Blockers (from scouting) — each with the honest alternative

1. **The chat agent cannot ignite the deliberate design chain.** The App Architect's tool allowlist is `render`/`catalog`/`get-design` only (`pack.json:25-29`); it composes a design in-context and renders directly. The researched/audited/per-screen-reviewed `app-builder.design` chain (with `core.approvalGate` HITL) is only reachable by manual gallery instantiation. So "build me an app" in chat yields the fast path, never the rigorous one. *Honest alternative:* this is a capability gap, not theater — both paths ignite and share the render/validate/CAS owner. If desired, add a `run-workflow`-style action tool (or reuse an existing launch tool) scoped to `app-builder.design` so the agent can offer the deliberate chain; the chain's parent-run gates already render inline via the shared HITL machinery. Deferred-honestly below.

2. **`app-builder.repair` has no programmatic igniter.** It is registered as a builtin (`designWorkflow.ts:137`) and allow-listed by `resolve-paused-task` (`mcpControlNodes.ts:169`), but nothing starts runs of it — the design chain repairs inline via `feature.app-builder.nodes.repair` + `apply-repair` nodes, not a subworkflow call. *Honest alternative:* it is gallery-instantiable (a real user igniter) and its nodes are real, so it is a watch-item, not THEATER. Either confirm the gallery entry is intended or drop the standalone registration if the inline repair fully subsumes it.

## Demolition list (with regression pins)

None. No bespoke "talk to AI" surface exists in this unit (the removed `AiAuthorPanel` precedent did not recur here — `definition.tsx` toolbar extras are export/publish/sync buttons driving routes, not model calls). The editor is chassis-driven; there is no parallel chat, no bespoke approve/submit button, no shadow owner to demolish.

Regression pins already present that keep it honest: `catalogParity.test.ts`, `promptCatalogParity`/`agent-prompt-tool-ids` (SSoT↔prompt), `repairLoop.test.ts`, `childConstraints.test.ts`, `templatesAndChain.test.ts` (chain is real chatCompletion not mock), `capabilityManifest.test.ts`.

## New-code inventory (should be SMALL)

- (Optional, gap #1) One agent action tool to launch `app-builder.design` from chat + its allowlist entry in `pack.json`. Reuses `startWorkflowRun` + the authoritative `workflow_run` turn; no new owner.
- (Optional, gap #2) Delete the standalone `app-builder.repair` registration OR add a documented igniter. One-line change either way.
- No new stores, no new HITL machinery, no new render/validate paths — all exist and are shared.

## Phased plan (only if the gaps are pursued)

- **Phase 1 (gap #1, additive):** add the scoped launch tool to the App Architect; verify the chain's `core.approvalGate` interrupts render inline in the same conversation; close with `/code-review` + `/ux-review`.
- **Phase 2 (gap #2, cleanup):** resolve `app-builder.repair`'s igniter question — pin whichever way with a test. No demolition precedes a working replacement (there is nothing to demolish).

## Deferred honestly

- Chat-ignition of the deliberate design chain (gap #1) — a real enhancement, not a defect; the fast direct-compose path is fully functional today.
- Standalone `app-builder.repair` igniter (gap #2) — gallery-instantiable; confirm-or-remove pending.
- `app-builder.deploy` (ADR 0424) and `code-sync` (ADR 0393) ship OFF by default — a rollout state, honest-off without an operator provider / admin opt-in, not theater.
