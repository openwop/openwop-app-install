# Canvas packs (C5) — chat-first port review

**Scope:** `backend/typescript/src/features/canvas-packs/feature.ts` +
`frontend/react/src/features/canvas-packs/` (Tier-1 FE-less canvas types,
ADR 0310 Phase D). Toggle `canvas-packs` (OFF, per-tenant). Reviewed on its
merits despite being toggled off.

## What this feature IS (contract scouting)

`canvas-packs` is **infrastructure, not a domain feature**: a canvas-editor
*factory* that lets an artifact-type pack declare a canvas type (the
`x-openwop-app.canvas` vendor extension) and get a full editor with **zero
frontend code**. It ships **no agent pack, no workflow, no node pack** of its
own — confirmed by grep: nothing in `src/features/canvas-packs/` references
`agentProfile`, `registerFeatureAgentTool`, `startWorkflowRun`,
`WorkflowDefinition`, or any node/agent pack. That absence is the headline: a
feature that declares no orchestration cannot host orphaned orchestration, so
there is **no THEATER surface possible here**.

Every capability it exposes is a *pass-through to a shared owner*:

- **Editor route family** — `feature.ts:78` calls the shared
  `registerCanvasEditorRoutes` (`canvasEditorRoutes.ts:155`), the same machine
  the app-builder, slides, drawings, CAD, document-editor, and KickTodo types
  ride. One registration = catalog, blank-create, from-artifact, GET/PATCH,
  delete+cascade+share-purge, version history, restore, present-remote — all
  toggle- and `authorizeOrgScope`-gated, tenant-scoped, type-pinned
  (`canvasEditorRoutes.ts:184`). Nothing is re-implemented.
- **Closed-world catalog** — `feature.ts:73` calls the shared
  `registerCanvasComponents` (`host/canvasComponentCatalog.ts`), gated by a
  **host-wins ownership check** (`feature.ts:67-71`): a pack claiming a
  first-party id (e.g. `canvas.app-builder`) is skipped with a warning so it
  can never shadow a first-party editor. This is the "instantiate, never
  shadow" rule enforced in code.
- **Save validator** — the pack's *own* artifact JSON Schema is the editor-doc
  validator (`feature.ts:88-96`, `validateArtifact`). No second validation
  language; a schema ajv can't compile fails as a typed 422, never a 500 or a
  success-with-empty (SSoT test passes).
- **FE** — one generic route `/canvas/:typeId/:canvasId` (`routes.tsx:13`)
  mounts the **shared** `CanvasEditorPage` (`PackCanvasEditorPage.tsx:92`); the
  runtime definition is synthesized from the catalog's `editor` hints by
  `packDefinition.tsx` — explicitly "the one deliberate data seam," with untrusted-hint
  narrowing + prototype-key screening (`packDefinition.tsx:36-79`).
- **Tier-2 preview** — reuses the ui-plugins `PluginFrame`
  (`PackCanvasEditorPage.tsx:18`, "OWNED by ui-plugins — reused here, never
  forked"). Sandboxed render surface, not a parallel canvas.
- **In-chat AI grounding is inherited, not shipped** — the shared agent
  schema-lookup tool (`host/agentToolProvider.ts:369-395`, `kind:"canvas-component"`)
  returns `{components, promptSchema}` for **any** registered canvas type,
  pack types included; and `host/canvasFromArtifact.ts:33-34` seeds an editable
  copy from any `canvas.*` artifact a run produces. So an agent *can* discover a
  pack type's schema and its output *can* open into the editor — the chassis
  provides it, canvas-packs neither adds nor blocks it.

**Executor/chassis constraints that bound any future port (honest limits):**
real-time collab is **fail-closed-by-absence for pack types** — the chassis
`collab` opt-in is documented as "first-party types only; the pack registration
path never sets this" (`canvasEditorRoutes.ts:80-84`); `feature.ts` never
passes `collab`. Phase D supports the **elements trait only** (positional,
schema-mirror); tree/frames pack editing is a recorded follow-up
(`host/canvasPackTypes.ts:9-12`). Both are deferred honestly, not painted.

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Register per-type editor route family | `registerCanvasEditorRoutes` (`feature.ts:78`) | **RIDES** | none — shared owner |
| Register pack component catalog (host-wins guarded) | `registerCanvasComponents` (`feature.ts:73`, guard `:67`) | **RIDES** | none |
| Structural editing (adders/fields/undo/redo/props) | shared `CanvasEditorPage` (`PackCanvasEditorPage.tsx:92`) | **RIDES** | none — structural editing *is* the canvas trait, the correct chat-first answer |
| Save validation = pack's own artifact schema | `validateArtifact` (`feature.ts:88`) | **RIDES** | none — one SSoT, typed 422 |
| Create blank canvas (Documents gallery) | `blankState` route (`canvasEditorRoutes.ts:215`) fed by `blankFromHints` (`feature.ts:32`) | **ADAPTER** | keep; blank is validated like a save, fails closed (`:234`) |
| FE data→definition synthesis from hints | `parsePackEditorHints`/`buildPackDefinition` (`packDefinition.tsx:42,126`) | **ADAPTER** | keep — the one deliberate seam, untrusted-input narrowed |
| Open run artifact → editable copy | `seedCanvasFromArtifact` (`canvasFromArtifact.ts`) | **RIDES** | none |
| Version history + non-destructive restore | shared version routes (`canvasEditorRoutes.ts:352-384`) | **RIDES** | none |
| Delete + cascade + share-link purge | shared delete (`canvasEditorRoutes.ts:333`) | **RIDES** | none |
| present-remote (QR phone remote) | shared route (`canvasEditorRoutes.ts:279`), 400 for types w/o outline provider | **RIDES** | none |
| Tier-2 sandboxed preview plugin | ui-plugins `PluginFrame` (`PackCanvasEditorPage.tsx:76`) | **RIDES** | none — reused, not forked |
| In-chat schema discovery for pack canvas | shared schema-lookup tool (`agentToolProvider.ts:369`) | **RIDES** | none — inherited from chassis |
| List editable pack types for gallery | `/orgs/:orgId/types` → `servedTypes` (`feature.ts:52-57`) | **PAGE-LEGIT** | keep — read-only enumeration backing the Documents "New" list, toggle-gated, real read |
| One toggle gates all pack editors | `toggleDefault` (`feature.ts:101`) | **RIDES** | none |

## Blockers (from scouting) — with honest alternatives

**None that block a port, because there is no port to do.** The two chassis
limits below are pre-existing design boundaries, correctly deferred, not
defects introduced here:

1. **Pack canvases get no real-time collab.** `canvasEditorRoutes.ts:80-84`
   excludes the pack path from `registerCollabCanvasType` (fail-closed by
   absence). *Honest alternative if ever wanted:* the chassis already accepts a
   `collabShape`/`collabDerive` per type; a future phase would need a pack to
   declare its Y-shape as data and the loader to validate it — an additive
   chassis hook, not a rewrite. Deferred honestly today.
2. **Elements trait only.** Tree/frames pack editing is unsupported
   (`canvasPackTypes.ts:9-12`); the loader hard-rejects non-elements editors
   (`artifactTypePackLoader.ts:190-192`). Honest typed rejection, not a silent
   drop.

## Demolition list (with regression pins)

**Empty.** There is no bespoke "talk to AI" surface, no form hiding a model
call, no parallel approval/version/canvas store, no orphaned workflow, and no
toothless agent to demolish. `PackCanvasEditorPage.tsx` renders only the shared
`CanvasEditorPage`, `StateCard`, and `Notice`. The existing guards that a
regression suite already pins (and that must stay green):

- **Host-wins ownership** (`feature.ts:67-71`) — a test asserting a pack
  claiming `canvas.app-builder` is skipped and does **not** register routes /
  poison the catalog.
- **Blank fails closed** (`canvasEditorRoutes.ts:234-238`) — a pack whose
  derived blank can't satisfy its own schema returns 422, not a persisted
  invalid doc.
- **Slug pinning** (`packDefinition.tsx:36`, `feature.ts:50` comment) — a
  crafted `:typeId` can't steer the client onto another API path.
- **Type-pin 404** (`canvasEditorRoutes.ts:184-193`) — a shape-only canvas of
  the wrong type is a uniform 404, no existence leak.

## New-code inventory

**Zero.** "Already rides the engine" is the finding. The correct chat-first
architecture for this unit is exactly what exists: structural editing → the
canvas trait (shared `CanvasEditorPage` over `host.canvas`); AI grounding →
inherited chassis schema-lookup tool + from-artifact seed; one validated SSoT →
the pack's artifact schema; human decisions (delete) → the shared editor's own
confirm. Nothing here substitutes for a primitive the platform owns; it
*instantiates every owner*.

## Phased plan

No phases. This unit is a correct, honest adapter over the canvas chassis and
requires no chat-first remediation. The only forward-looking work is the two
chassis limits above, and both are **out of scope for canvas-packs** and
already recorded as ADR 0310 follow-ups (tree/frames packs; pack collab). If
either is picked up, it is an additive chassis hook reviewed under the canvas
chassis unit, not a demolition here.

## Deferred honestly

- **Real-time collab for pack canvases** — excluded by design
  (`canvasEditorRoutes.ts:80-84`); would require a pack-declared, validated Y-shape.
- **Tree/frames pack editing** — Phase D is elements-trait only
  (`canvasPackTypes.ts:9-12`); loader rejects other traits with a typed error.
- **In-chat *authoring* of a pack canvas by a first-party agent** — a pack that
  wants an agent to author its canvas from chat must ship its **own** agent pack
  (the ADR 0058 "agent + nodes" pattern); canvas-packs correctly does not ship a
  domain agent. The schema-discovery and from-artifact rails it would use are
  already present and shared. Honest by-design boundary, not a gap in this unit.
