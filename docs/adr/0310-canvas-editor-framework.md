# ADR 0310 — Canvas Editor Framework: the CanvasTypeDefinition contract + trait-based shared editor

Status: Accepted (2026-07-07)

## Context

The ADR 0305 parity program built a complete canvas-editing chassis — shell, toolbar,
undo/redo, palette, drag-and-drop, outline, frame tabs, catalog-driven properties,
version history, share, device preview, interactive viewer, announcer, validation
surfacing — **entirely inside `features/app-builder/`**. The other four canvas types
(`canvas.slides`, `canvas.drawing`, `canvas.cad`, `canvas.campaign`) are read-only
chat renderers; every future canvas type would rebuild the chassis.

The full analysis (three-scout deep dive + MyndHyve CanvasShell autopsy) is
[`docs/research/canvas-framework-rearchitecture.md`](../research/canvas-framework-rearchitecture.md)
— this ADR is its decision record. The backend was already framework-shaped
(`host.canvas` store, `canvasComponentCatalog` keyed by canvasTypeId,
`canvasFromArtifact`); the frontend was not. Prior-art lessons adopted as hard rules:

1. **No god store** — per-instance hook state only (MyndHyve's global fabric-store +
   module-level history singleton shared one undo stack across all open editors).
2. **No render modes in shared types** — MyndHyve's 11 `renderMode`s leaked every
   type's specifics into the shared config. We use three small orthogonal **traits**.
3. **No string-id plugin coupling in-tree** — typed `CanvasTypeDefinition` objects
   imported by each type's own routes; registries only at genuinely dynamic seams
   (chat renderer registry, the ADR 0300 ui-plugin loader).

## Decision

### The contract

`frontend/react/src/canvas/` (a SHARED layer — peer of `chat/`, `builder/`, `ui/`;
NOT a feature) exports `CanvasTypeDefinition`:

- identity: `canvasTypeId`, `toggleId`, `clientBasePath` (per-feature wire root);
- **one `Renderer`** (`{content, editPaths?}`) — the one-renderer/two-mounts rule:
  chat card, editor preview, and shared/public view mount the SAME component; edit
  mode stamps `data-cv-path` (selection/DnD) and `data-cv-nav` (tap-through);
- **traits** (all optional, orthogonal): `frames` (multi-frame docs — key, noun i18n
  key, max, home flag, per-type delete-cascade hook), `tree` (nested component docs —
  childrenKey + the host component catalog), `elements` (flat element docs — Phase C);
- seams: `validate`, `summarizeVersions`, `propertyWidgets` (registry additions),
  `toolbarActions` (typed, gateable slots), `preview` (device presets / theme
  override / hideOn), `share` (resourceType).

`CanvasEditorPage` composes per-instance hooks — `useCanvasDoc` (load/save with
optimistic 409 + generation-guarded dirty + reload-latest), `useHistoryState` (ui/),
`useCanvasSelection`, `useCanvasDnD`, `useAnnouncer`, `useEditorShortcuts` — around
the parametric components: `CanvasToolbar`, `Palette`, `FrameTabs`, `OutlineTree`,
`PropertyForm` + widget registry, `HistoryModal`, `DeviceFramePreview`,
`InteractiveViewer`. Pure helpers become factories: `treeOps({childrenKey})`,
`frameOps(framesTrait)`, `createCanvasClient({basePath})`.

Import boundary: `canvas/` imports `ui/` + `client/` only; features import
`canvas/`; `canvas/` never imports `features/*` or `chat/*` (the renderer arrives
via the definition).

### Backend

`features/canvasEditorRoutes.ts` (beside the existing `featureRoute.ts` shared
helper): `registerCanvasEditorRoutes(deps, { basePath, toggleId, canvasTypeId,
validate?, extraRoutes? , shareResourceType? })` provides catalog / from-artifact /
get / patch (validate + snapshot capture) / versions / get-version / restore /
delete (cascade + share-link purge). Everything rides `host.canvas` — no second
store. Host-ext only; **no RFC** (the standing non-normative-surface rule).

### Naming

The framework owns the generic vocabulary: `data-cv-path` / `data-cv-nav` attrs,
`.cv-*` CSS blocks, the `canvas` i18n namespace (framework-generic keys MOVED from
the app-builder namespace with translations copied verbatim ×4 locales). The
`.canvas-ab__*` renderer vocabulary stays app-builder's.

> **Correction (Phase A implementation).** Two refinements landed with the code:
> (1) type-VOCABULARY strings the chassis renders (screens vs slides, delete-doc
> wording, palette categories) stay in each type's namespace under a **fixed
> type-key contract** (`editorHeading`, `docName`, `deleteDoc*`, `frames`,
> `addFrame`, `frameDefaultName`, `frameActions`, `renameFrame`, `duplicateFrame`,
> `deleteFrame*`, `annFrame*`, `setHome`, `home`, `templateTag`, `cat_*`,
> `previewHeading`, `theme_doc`, `noFrames`, `framesLabel` — documented in
> `canvas/types.ts`); the app-builder keys were renamed to the contract names with
> values verbatim. (2) The FE share seam inverts the backend ruling: the framework
> owns the Share button UX but the **definition supplies `share.mint`** (the type's
> feature layer imports the sharing client), so `canvas/` never imports
> `features/*` — the backend factory still imports `purgeLinksForResource` itself.

> **Correction (Phase B implementation — the contract proof).** Driving slides
> through the chassis surfaced three contract gaps, fixed IN `canvas/` as the
> phase intended: (1) the **tree trait is optional** (`CanvasEditorDefinition`
> requires only frames) — fixed-schema types edit the ACTIVE FRAME's own fields
> via a new `frames.propDefs(frame)` seam (the field set may follow a
> discriminator, e.g. the slide `layout`); (2) **`docNameKey`** (default
> `'name'`) — decks title themselves with `title`; (3) frame templates carry a
> generic **`content`** map (merged verbatim into the new frame) alongside the
> tree-trait `components` form. One data ruling: the slides **editor doc is the
> artifact doc PLUS editor identity fields** — the frames trait needs per-slide
> `id`/`name`, the artifact schema is positional, so `coerceDeck` synthesizes
> stable ids at load and the slides canvas validator (not the artifact schema)
> governs the working copy. The run artifact is never mutated.

> **Correction (Phase C implementation — the elements trait).** The third trait
> landed as `elements: ElementsCollectionDef[]` — an ARRAY of flat collections
> (each: `key`, `max`/`min`, per-kind **adders** with default fields,
> `labelFor(el, t)`, per-kind `propDefs(el)`), so campaign's three parallel
> collections (channels/funnel/assets) use the same machinery as drawings' one
> (`shapes`). Companion seam: **`docPropDefs`** — doc-level fields edited when
> nothing is selected (drawing width/height, cad units, campaign
> objective/audience). Elements are POSITIONAL (selection = collection+index;
> no synthesized identity), so the three validators are pure schema mirrors —
> simpler than slides. Every trait on the definition is now optional; the
> chassis picks the mode (tree / frames+propDefs / elements) and drops the
> `tabpanel` role when no frame tablist renders. Direct-manipulation canvases
> (SVG drag for drawings, WebGL for cad) remain the recorded type-specific
> follow-ups per the research doc §5.5.
>
> **§Correction (2026-07-12 fold-in) — CAD "WebGL viewer" delivered as a no-dep
> hand-rolled 3D viewer.** The deferred cad WebGL viewer shipped, but NOT with
> Three.js: the app's no-new-dep discipline (the sales-map self-implemented
> projection to avoid `d3-geo`) + only 4 analytic primitives made ~200 lines of
> pure math (`features/cad/cad3d.ts`) the right call over a ~150 kB dep. It is a
> **read-only** orbit VIEWER — a lazy-loaded 2D⇄3D view mode on `CadPreview`; the
> orthographic surface stays the edit surface (a perspective camera can't drive
> footprint dragging, exactly this note's point). Materials shipped as additive
> glTF-aligned `metallic`/`roughness` schema fields rendered as **APPROXIMATE**
> shading (a `filter: brightness()` Lambert+specular over the solid's color) —
> honestly NOT true PBR; the field set is the faithful upgrade path. Host-ext, no
> RFC (additive optional schema, the `rotation` precedent). Recorded fast-follow (Phase-C code
> review, MEDIUM): clearing a REQUIRED non-enum field (the campaign channel
> `name` — the only such field today) deletes the key and surfaces as the
> server's 422 on save; the framework wants an inline required-field guard
> (a client-side `validate` seam) — server-authoritative validation is the
> app-builder precedent, so this ships as-is.

> **Correction (Phase D implementation — Tier-1 FE-less packs).** Three
> refinements against the phase sketch: (1) pack editors support the
> **elements trait only** this phase — it is the fully data-expressible mode
> (positional, pure schema mirror, generic renderer feasible); tree/frames
> pack editing is the recorded follow-up. (2) Save validation is the pack's
> **own artifact JSON Schema** (`validateArtifact`) — no second validation
> language in the manifest. (3) The typed-definition rule stands for
> first-party types; `canvas/packDefinition` is the ONE deliberate data seam,
> and it narrows untrusted hints before trusting them (the chassis gained
> data `label` fields on elements collections/adders so pack labels ride as
> data while typed consumers keep i18n). One `canvas-packs` toggle gates all
> pack editors; a pack type whose artifact type is host-owned at boot is
> skipped (host wins, checked at route-registration time since features
> register after the pack loader). Chat rendering of pack canvas types stays
> the safe Markdown fallback — a custom preview is the Tier-2 plugin surface
> (Phase E). **Pack-uninstall lifecycle (grade pass DATA-CV-1, accepted):**
> removing a pack removes its editor ROUTES at the next boot but leaves
> existing `host.canvas` rows of that type in place — unreachable through the
> editor, still covered by tenant deletion (the rows are tenant-indexed), and
> revivable by reinstalling the pack. A generic type-agnostic admin delete is
> the recorded follow-up if operator demand appears.

> **Correction (Phase E implementation — the Tier-2 plugin preview).** The wire
> half landed as **RFC 0130** (a NEW RFC amending 0117 — the 0119 precedent —
> not an in-place edit), at `Active` first per the spec repo's own lifecycle
> (Active locks the wire; `Accepted` flips with this host evidence). The RFC
> grew a third method beyond the ADR sketch: **`host.documentChanged`** — a
> live preview is stale without document push (pull-only `artifact.read` was
> the sketch's gap). Host mount: the chassis gained a **`PreviewPanel`** seam
> (content + RFC 0130 selection projection + the live-region sink) rendered in
> place of the Renderer; the pack editor page attaches the ui-plugins
> `PluginFrame` (reused, never forked) when an installed `canvas-preview`
> plugin's `canvasTypes` matches, degrading to the generic data view when
> ui-plugins is off/unreachable or on the transient `/new` seed URL.
> `host.announce` is handled FRAME-LOCALLY (length-capped 400, behind the
> declared-hostApi gate); the backend witness seam mirrors it so
> advertise/serve can't drift. Witness plugin:
> `packs/community.openwop.checklist-preview` over the Phase-D checklist type.

### Phases

| Phase | Scope | Gate |
|---|---|---|
| **A — extraction, behavior-frozen** | Move the chassis into `canvas/` + the backend factory; app-builder = consumer #1 with identical behavior; ADR 0305's test surface (route suites, parity pins, ~1068 FE tests) passes with only mechanical updates (imports, `cv-` names) | all existing suites green |
| **B — slides editor** | The contract's proof: slides definition (frames + layout-driven items), editor route, Open-in-editor on the slides chat card, seeding. Contract gaps found here are fixed IN `canvas/` | slides suites + freeze intact |
| **C — drawings/cad/campaign** | Elements-trait definitions + generic properties-driven editors; direct-manipulation canvases remain recorded follow-ups | per-type suites |
| **D — Tier-1 FE-less canvas packs** | `x-openwop-app.canvas` vendor extension on artifact-type packs (catalog + trait hints as data) → install-time `registerCanvasComponents` → the generic editor serves the pack type with zero FE code; witness pack | pack loader tests |
| **E — Tier-2 custom preview** | RFC 0117 amendment (`canvas-preview` surface + `selection.changed`/`host.announce` RPC) authored in `../openwop`, **Accepted before host work**; then the ADR 0300 `PluginFrame` mounts as the editor center panel; witness plugin | RFC Accepted → mount tests |

## Alternatives considered

- **Render-mode dispatch** (MyndHyve) — rejected; the mode-config union is where the
  shared shell rotted.
- **Copy-per-type editors** — rejected; five divergent chassis by year-end.
- **String-id plugin registries in-tree** — rejected; typed definitions are
  compile-checked.
- **Generalizing the workflow builder into this framework** — rejected; different
  document model (DAG + xyflow). It donates/adopts the leaf primitives
  (`useHistoryState`, `Palette`, shortcuts — recorded follow-up) and stays distinct.

  > **Correction note (2026-07-12 — DESIGN.md §7.10).** The *document-model*
  > rejection stands, but two things changed after this ADR: (1) the chassis
  > grew the **`EditorSurface` seam** (ADR 0334) — a center surface that owns
  > its own engine and undo while the shell stays chassis-owned, proven by the
  > TipTap document editor — which removes the mechanism this rejection rested
  > on; (2) DESIGN.md §7 now mandates a full **chrome** merge (one shell
  > grammar, one command registry, one zoom/minimap standard — the §7.12
  > convergence ledger). Mounting `BuilderCanvas` as an `EditorSurface`-class
  > consumer is recorded in §7.10 as the candidate end state, gated on its own
  > ADR.

## Open decisions (ruled at the Phase-A architect gate)

- i18n: framework-generic keys move to the `canvas` ns, translations verbatim.
- Share purge: the route factory takes `shareResourceType` and imports the sharing
  hook itself — one coupling point in one shared helper.
- `data-ab-*`/`.ab-*` → `cv-*` rename ships inside Phase A (behavioral freeze, not
  byte freeze); DESIGN.md §5 rows updated; no external consumers exist (verified).

## Phase → commit (updated as phases land)

| Phase | Status |
|---|---|
| A — extraction, behavior-frozen | implemented — PR #1470 (freeze harness: FE 175 files/1076 tests + backend suites green; /code-review + /ux-review CLEAR) |
| B — slides editor (contract proof) | implemented — PR #1473: tree-optional chassis + `frames.propDefs` + `docNameKey` + template `content`; `slides-editor` toggle (OFF); Open-in-editor on the slides chat card |
| C — drawings/cad/campaign (elements trait) | implemented — PR #1476: `elements` collections + `docPropDefs` + `elementOps`; three definitions/editors/toggles (OFF); Open-in-editor on all three chat cards |
| D — Tier-1 FE-less canvas packs | implemented — PR #1477: `x-openwop-app.canvas` loader extension + `canvasPackTypes` registry + `canvas-packs` feature/toggle (OFF) + generic `/canvas/:typeId/:canvasId` editor + witness pack `community.openwop.canvas-checklist` |
| E — Tier-2 plugin preview (RFC-gated) | implemented — RFC 0130 Active (openwop#861); host PR #1481: surfaces/hostApi advert + PluginFrame RFC 0130 events + chassis PreviewPanel + witness plugin; Accepted flip follows the host merge |
