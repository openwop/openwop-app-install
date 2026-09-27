# ADR 0388 — CAD best-in-class program: mesh I/O, BOM, dimensions, a deterministic 2D solver, and PBR on the canvas chassis

Status: implemented (P1–P5, 2026-07-17; per-phase records + corrections in §Phases — P5 scoped: library-not-pack-kind, WebGL viewer deferred w/ reason). Corrected 2026-07-25: the shipped hand-rolled orbit viewer now reaches the EDITOR, not only the chat card (§Correction).

Date: 2026-07-17

Lane: canvas-type extension program (host-owned `canvas.cad` artifact type + the
existing `cad` feature package) — no toggle addition, no wire/RFC surface.

RFC verdict: **host / canvas work only.** Every increment is additive on the
host-registered `canvas.cad` artifact type + host-registered new artifact types +
host-ext routes under `/v1/host/openwop-app/cad/*`. Nothing touches the OpenWOP
wire (verified in §RFC).

## Context

`docs/steward/MYNDHYVE-GAP-ANALYSIS.md` names CAD the **single least-covered canvas type** and
"the one canvas left behind" (lines 17, 289, 319): slides got its best-in-class
program ADR (0328), drawings got 0333, documents and app-builder each got a
program — CAD never did. The gap-analysis row (line 289) and the P1.3 backlog item
(line 43) are explicit about the shape of the gap and the sequencing:

> Phase 1 = STL/GLTF I/O + BOM/cutlist FIRST; solver / dimension-system / PBR later.

### The current CAD surface is honest but thin (file:line)

`canvas.cad` shipped as an ADR 0153 Phase-4 / ADR 0310 Phase-C elements-trait
consumer. Its honesty is not in doubt — every limitation is documented in the code
itself. It is simply the least-built canvas:

- **Four primitive solids, a closed world.** `box | cylinder | sphere | cone` —
  `backend/typescript/src/features/cad/artifactTypes.ts:26`, mirrored in
  `validateCadDoc.ts:15` (`CAD_SOLID_KINDS`) and the FE adders
  (`frontend/react/src/features/cad/definition.tsx:85-90`). There is no way to
  represent an arbitrary mesh.
- **Numeric dimensions only, no dimension *system*.** Each solid carries scalar
  `x/y/z/width/height/depth/radius/length` + one in-plane `rotation`
  (`artifactTypes.ts:27-34`); there are no annotated dimensions (linear/angular/
  radial/diameter/ordinate), no tolerances, no units on a dimension (only a
  document-level `units` enum, `artifactTypes.ts:19`).
- **Read-only orbit viewer, explicitly not PBR.** The hand-rolled, no-Three.js 3D
  viewer (`frontend/react/src/features/cad/Cad3dView.tsx:1-6`) orbits and
  painter-sorts, shading metallic/roughness as a `filter: brightness()` term —
  "APPROXIMATE shading, not true PBR" (`artifactTypes.ts:6-8`, `Cad3dView.tsx:4-5`).
  Direct manipulation is X/Y footprint drag only (`definition.tsx:73-75`,
  `InteractiveCad`); there are no transform gizmos.
- **JSON-only export.** `export: ['json']` (`artifactTypes.ts:59`) — no STL, no
  GLTF, no rendered image, no BOM. The gap analysis calls this out at line 289.
- **One producer node, one agent.** `feature.cad.nodes.render` normalizes a
  requested model and emits the `{ artifact }` envelope
  (`packs/feature.cad.nodes/index.mjs`); the "CAD Modeler" agent
  (`packs/feature.cad.agents/pack.json`) drives it through the ONE chat with
  `canvasRead` + `render` (no bespoke chat surface — the correct posture, kept).

### What it already rides (do NOT rebuild)

CAD is already a first-class chassis citizen. This program **must not invent
parallel canvas infrastructure**; it consumes the seams ADR 0310/0333/0359 built:

- **Collab** — ADR 0359. `registerCadEditorRoutes` passes `collab: true` +
  `collabShape: { collections: [{ key: 'solids' }] }` (`routes.ts:16-20`); the FE
  definition binds `collab: 'elements'` (`definition.tsx:79`). New collections this
  program adds (dimensions, sketch, mesh refs) extend `collabShape`, they do not
  fork collab.
- **Version history + restore** — the shared `registerCanvasEditorRoutes` factory
  (`routes.ts:12`) gives snapshotting and `restoreCanvasVersion` for free; the
  ratchet-up-only cap rule from ADR 0333's grade pass applies verbatim.
- **Viewport (pan/zoom/fit)** — ADR 0333 Phase 1 already mounts `useCanvasViewport`
  / `ViewportSurface` (`frontend/react/src/canvas/viewport.ts`) around every
  `InteractivePreview`; the phase table records "drawings + CAD compose the
  surface." Transform gizmos (P3) build ON this, not beside it.
- **Export seam** — ADR 0333 Phase 8 shipped the core `canvas/exportUtils.ts`
  (stripped-clone SVG serialization + PNG rasterize + download + guarded clipboard)
  and recorded "chassis menu seam **recorded until CAD consumes**." P1's
  rendered-image export is exactly that consumption.
- **Host-served asset bytes (SSRF posture)** — ADR 0328 Phase 2's `mediaRef` /
  `resolveMediaAsset` pattern (host-served bytes only, external URLs → placeholder)
  is the template for how imported meshes are stored and referenced.
- **The single AI chat** — CLAUDE.md's hard rule. Every AI-drivable increment ships
  as agent-pack + node-pack + a builtin workflow driven through the existing chat
  (the ADR 0058 / 0328 `slides.design` precedent), never a new panel.

## Decision

Execute a **five-phase additive program**, sequenced strictly by value per the
gap-analysis guidance — mesh interchange and BOM (the interoperability table
stakes) FIRST; the parametric depth (dimensions, solver, PBR) after. The placement
rule from ADR 0333 is normative here too: **a capability lands in `src/canvas/` iff
another canvas type would plausibly consume it; otherwise it lands in
`features/cad/`.** All schema changes are additive on the host-owned `canvas.cad`
artifact type; new outputs (BOM) are new host-registered artifact types. The `cad`
toggle id stays stable (currently `status: 'on'`, `bucketUnit: 'tenant'` —
`feature.ts:20-29`); no FEATURES toggle is added.

Two rulings frame the whole program and are made up front because they constrain
every later phase:

### Ruling A — mesh parsing is client-side; NO new Cloud Run service

The gap analysis records a standing "no standalone service unless justified"
precedent. STL (binary/ASCII triangle soup), OBJ (text), and GLTF/GLB (JSON +
binary buffers) are all parseable in the browser with small pure-JS/WASM parsers —
the file is already in the user's browser at import time. **Import parses
client-side**; **export tessellation is deterministic pure geometry** that runs
client-side for the editor download (mirroring drawings' SVG/PNG export through
`canvas/exportUtils.ts`) and backend-side inside the workflow node (for the
AI/automation path). No new Cloud Run service, no server-side mesh compute. The
backend's only new job is **storing** an imported mesh as host-served asset bytes.

### Ruling B — an imported mesh is a host-served asset referenced by a new `mesh` solid kind, never inlined

An arbitrary imported triangle mesh does **not** fit the closed 4-primitive
parametric world, and inlining millions of triangles into the JSON doc would break
the doc-size, snapshot-history, and collab-payload budgets. So imported meshes
become **host-served mesh assets** (the ADR 0328 `mediaRef` posture: opaque token,
host-served bytes, resolved internally — zero network from the renderer), and the
`canvas.cad` doc gains one additive solid kind `mesh` carrying `{ assetRef, x/y/z,
rotation, scale, material }` — a reference + pose + material, never geometry. The
closed parametric world stays closed; meshes are a *reference* citizen alongside
the four primitives. A hard byte-cap gates import.

### Phased design

| Phase | Layer | Scope | AI-drivable | Test-pinned |
|---|---|---|---|---|
| **P1 — Mesh interchange + rendered export** | features/cad + core seam | STL import (binary+ASCII), OBJ import, GLTF/GLB import → parsed client-side, normalized, stored as a host-served mesh asset; additive `mesh` solid kind (assetRef + pose + material) in schema + `validateCadDoc` + FE definition; STL export + GLTF export (deterministic tessellation of the parametric solids + embedded referenced meshes; the existing `cad3d.ts` `tessellate` is the ONE geometry source, shared FE/backend); rendered-image (PNG/SVG) export by **consuming the core `canvas/exportUtils.ts` seam** (the 0333 "recorded until CAD consumes" hook); `export` facet grows `['json','stl','gltf','png']` and becomes TRUE in the same change (the 0328 honesty-first rule). Import creates a NEW model and opens it. | `feature.cad.nodes` gains `mesh-import` / `mesh-export` nodes (workflow can ingest/emit interchange); the CAD Modeler agent learns to reference a stored mesh. | mesh-parser round-trip fixtures (our exporter ↔ our importer); byte-cap + malformed-file → typed failure (never success-with-empty); `promptCatalogParity` extended to the `mesh` kind. |
| **P2 — BOM / cutlist** | features/cad | New host-registered artifact type `canvas.cad.bom` (rows: part label, kind, dimensions, quantity, material, derived volume/area; a cutlist view groups by stock size). Generation is **deterministic, zero-AI**: a pure function over the `canvas.cad` model (count-and-roll by kind + dimensions + material — the slides-audit "deterministic, never re-implement the validator" pattern). A read-only BOM viewer artifact renderer; a `bom.generate` workflow node; export the BOM as CSV. | `bom.generate` node (deterministic) + the CAD Modeler agent can *request* a BOM for the current model; the BOM itself is computed, never model-authored (closed-world honesty). | golden-model → golden-BOM fixture; determinism test (same model → byte-identical BOM); a BOM referencing an unknown kind is a typed error. |
| **P3 — Dimension system + transform gizmos** | features/cad (dims) + core (gizmo) | Additive `dimensions[]` collection: typed annotated dimensions `linear \| angular \| radial \| diameter \| arc \| ordinate`, each with an explicit `unit`, an optional `tolerance` (`± \| +/- asymmetric \| limit`), and references to the solid/face/vertex it measures; renders in the projection + 3D viewer. Transform **gizmos** as core viewport chrome (translate/rotate/scale handles) building on the ADR 0333 `ViewportSurface` + the ADR 0362 selection-toolbar — a `gizmo` seam other canvas types can consume, so it lands in `src/canvas/`. | `cad` design agent (see matrix row 6) authors dimensions through the render node; a `dimension.suggest` node proposes dimensions for an un-dimensioned model (validated closed-world). | dimension schema round-trips validator + fixture; tolerance grammar closed-world (a bad tolerance → typed error); gizmo transform math unit suite. |
| **P4 — Constraint solver (2D sketch scope)** | features/cad | A **2D sketch** sub-document (`sketch` collection: points/lines/arcs on a plane) with the constraint set `coincident / concentric / parallel / perpendicular / tangent / equal / horizontal / vertical / fixed / distance / angle / symmetric`. A **hand-rolled, deterministic** numeric solver (Gauss-Newton over constraint residuals, **fixed iteration order + fixed convergence tolerance + no wall-clock, no RNG** — see the replay invariant, matrix row 9). Over/under-constrained **diagnostics** from the Jacobian rank (under → free DoF highlighted; over → the redundant/conflicting constraint flagged). **Full 3D assembly constraints are explicitly deferred** (see Alternatives) — a 2D sketch solver is a bounded, auditable, replay-safe problem; a 3D B-rep history solver is a CAD-kernel-scale program that fights determinism. | `sketch.solve` node runs the solver deterministically; the agent can add constraints, but SOLVING is a closed-world host op (model output reaches durable geometry only through the validated solver, never free-hand coordinates). | solver-determinism golden test (same sketch+constraints → byte-identical solved coords across runs — the fork/replay gate); over/under-constrained classification fixtures; degenerate-input → typed non-convergence error. |
| **P5 — PBR materials + material library** | features/cad + optional lazy WebGL | Real PBR material definitions (metallic/roughness/normal/emissive/base-color) on solids + meshes, and a **material library** (a host-registered `cad-material` pack kind + a starter library). Because real PBR + large-mesh rendering genuinely needs a GPU, P5 introduces an **OPTIONAL lazy WebGL viewer** (a Three.js-class engine loaded **only in the already-lazy editor chunk**, never the entry bundle — the deliberate, scoped revisit of the "no Three.js" discipline; the hand-rolled projection stays the default/fallback + the export tessellator). | `material.recommend` node + the design agent suggests a library material; assignment is closed-world (library id, never free material JSON that could smuggle a URL). | material schema closed-world + safe-paint grammar (the 0333 `url()`-beacon lesson); library-pack parity test; WebGL viewer absent from `index-*.js` (bundle-budget test). |

Per phase (the 0333 discipline): `/architect` gate before implementation; `npm run
ci` green; `/code-review` + `/ux-review` with fixes applied; one PR citing
`(ADR 0388 §Phases / Phase N)`; DCO-signed; the phase table updated as phases land.

### AI information-exchange honesty (LLM-EXCHANGE rules)

The task brief named "envelopes `cad.spec.create/update`, `material.recommend`,
`bom.generate`." Corrected for honesty: **these are NOT new RFC 0021 envelope
KINDS.** A new envelope kind is a wire change requiring an OpenWOP RFC (CLAUDE.md §
"A spec change needs an RFC"). Every AI-drivable increment above ships as **agent
pack + node pack + a builtin workflow** driven through the existing chat and rides
the **already-specced** envelope kinds (`result`, `schema.request`,
`clarification.request`) — the `slides.design` precedent (ADR 0328 Phase 6). The
model discovers the closed-world CAD schema at runtime via `schema.request` /
the feature catalog tool, **generated from / test-pinned to the SSoT** (extend
`features/cad/__tests__/promptCatalogParity.test.ts` and the repo-wide
`agent-prompt-tool-ids.test.ts`). Invalid model output is a **typed failure, never
success-with-empty** (the `feature.cad.nodes.render` node already does this — keep
the posture on every new node), and durable geometry is reached only through
closed-world validation or the deterministic solver, never free-hand model output.
Schema-carrying tool outputs stay in `SCHEMA_READ_EXEMPT_TOOLS`.

> **CORRECTED 2026-08-23 (TOCC-2 / ADR 0604).** This sentence was written in the
> present tense and was FALSE when written: **none** of CAD's tools were in that
> list — not `openwop:cad.get-design`, not any sibling. The claim survived because
> the only test over the list iterated the list itself, so an id that was never
> added was invisible to it. `cad.get-design` now genuinely IS exempt and declares
> `schemaCarrying: true`, and a runtime-denominator completeness test
> (`test/schema-read-exemption-completeness.test.ts`) makes the same silent
> omission impossible for the next tool.

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Extend the existing `features/cad/` package (backend) + `features/cad/` (FE) — NO new package. New artifact types (`canvas.cad.bom`, mesh assets) register through the host `artifactTypes.ts` seam; new core-reusable seams (gizmo P3) land in `src/canvas/` per the 0333 placement rule. No parallel canvas infra. |
| 2 | Toggle / admin | The **existing `cad` toggle** (`feature.ts:20`), id stable, current default **ON** (`status: 'on'`), `bucketUnit: 'tenant'`. No new toggle — mesh I/O, BOM, dimensions, solver, and PBR are all the CAD product's table stakes, not distinct risk surfaces (the 0328 rule: export earns no separate toggle; app-builder's `code-export` did only because generated *source code* is a distinct risk). |
| 3 | Ctx / workflow surface | `feature.cad.nodes` (pack, currently 1.0.0 → bumped per phase) grows: P1 `mesh-import`/`mesh-export`, P2 `bom.generate`, P3 `dimension.suggest`, P4 `sketch.solve`, P5 `material.recommend` — plus the existing `render`. Optional builtin workflows (e.g. a `cad.model` chain: brief → render → dimension.suggest → bom.generate with a HITL review gate) mirror `slides.design`. |
| 4 | Node pack | One pack, `feature.cad.nodes`, versioned per phase (manifest input-docs + `index.mjs` + version bump — the 0383 write-node discipline). Read auto-flows through the artifact renderer. Node-pack parity is enforced by `/grade-node-packs`. |
| 5 | AI-chat envelopes | **No new envelope KIND** (that is an RFC, not an ADR — §AI-exchange honesty). Rides `result` / `schema.request` / `clarification.request`. Schema reaches the model **generated from / test-pinned to the SSoT** (extend `promptCatalogParity.test.ts` + `agent-prompt-tool-ids.test.ts`). Invalid output = typed failure with one bounded repair on authoring paths. |
| 6 | Agent pack | The existing `feature.cad.agents` "CAD Modeler" (`pack.json`), extended: `canvasRead` + `canvasWrite` for scoped edits → version snapshots → editor Compare (the 0328 Slide-Designer pattern), and the new nodes added to its allowlist per phase. It **recommends** the builtin chain for full models. NO second CAD agent — one persona, capabilities activated via the pack (the "capability at core, not named" law). |
| 7 | Public surface | **None beyond the existing share/preview.** No public routes are added; imported meshes are host-served opaque tokens resolved internally (SSRF-free, the 0328 posture). A shared read-only model reuses the chassis share trait if/when CAD adopts it — recorded, not this program. |
| 8 | RBAC + isolation | **Unchanged.** All routes stay host-ext under `/v1/host/openwop-app/cad/*` behind `registerCanvasEditorRoutes` (org-scoped, `cad`-toggle fail-closed, 404-not-403). Mesh-asset store inherits the media-asset tenant isolation + byte-cap; a mesh asset is reachable only by an opaque host-minted token. |
| 9 | Replay / fork | **The hard invariant of this program.** All geometry ops must be **deterministic** for fork/replay byte-identity: export tessellation is pure; **the P4 constraint solver MUST be deterministic** — fixed iteration order, fixed convergence tolerance, no wall-clock, no RNG, no floating-point-nondeterministic parallelism — so replaying a run that solved a sketch reproduces identical coordinates. This is why the solver is hand-rolled and pinned by a determinism golden test, and why a WASM CAD kernel (whose numeric output can drift across builds) is rejected (§Alternatives). Mesh import is content-addressed (same bytes → same assetRef). |
| 10 | Frontend | Viewport upgrades ride the existing chassis `useCanvasViewport`; **transform gizmos** (P3) extend `ViewportSurface` + the ADR 0362 selection toolbar; a **materials panel** + **BOM viewer** + **dimension annotations** are new type-local surfaces; the **optional lazy WebGL viewer** (P5) loads only in the lazy `CadEditorPage` chunk (bundle-budget test asserts it stays out of `index-*.js`, the 0333 rule). Full 4-locale i18n per new string (the `check-i18n` FATAL gate); light + dark via `/browser`; token/CSS integrity via the build gate. |

## Alternatives weighed

- **Embed a WASM CAD kernel (OpenCascade.js / replicad / manifold) instead of
  hand-rolling.** Evaluated seriously:
  - *OpenCascade.js* (OCCT via emscripten) — a full B-rep kernel; **LGPL-2.1 + OCCT
    exception** (permissive enough to ship). Rejected: ~8–40 MB WASM (blows every
    bundle budget even lazy-loaded), enormous API surface for a closed
    4-primitive + mesh world we don't need booleans in yet, and — decisively — its
    numeric output is **not guaranteed byte-stable across builds/versions**, which
    would break the fork/replay determinism invariant (matrix row 9). `replicad`
    inherits the same OCCT WASM cost.
  - *manifold* (Google, **Apache-2.0**, small, fast mesh-CSG/boolean library) — a
    clean license and a plausible fit **if** we ever need constructive solid
    geometry (union/subtract/intersect). Rejected *for this program's scope* (P1–P5
    need no booleans) but **recorded as the escape hatch**: a future CSG phase would
    adopt `manifold` as a scoped, version-pinned, determinism-verified dependency —
    never a general kernel.
  - *Hand-rolled 2D sketch solver* — chosen for P4: small, auditable, and (the point)
    we control iteration order + tolerance, so it satisfies the replay invariant.
    Its scope is honestly bounded to 2D sketches; 3D assembly constraints are
    deferred, not faked.
- **Full 3D parametric/assembly constraint solver now.** Rejected: a 3D B-rep +
  feature-history + assembly-mate solver is a multi-quarter kernel effort whose
  determinism across builds is exactly the thing a WASM kernel can't guarantee. The
  honest, shippable increment is a deterministic 2D sketch solver (P4); 3D is a
  future decision record.
- **Keep-viewer-only (do nothing / cosmetic polish).** Rejected: the gap analysis
  names CAD "the one canvas left behind" and every peer canvas got a program ADR.
  Mesh interchange (STL/GLTF) is table stakes for *any* CAD interop and is cheap.
- **Adopt Three.js as the default renderer now.** Rejected as the default; adopted
  only as the **optional, lazy, P5** PBR path. The hand-rolled no-dep projection
  stays the default renderer, the fallback, and the export tessellator — Three.js
  earns its place only where real PBR + large meshes need a GPU, and only in the
  lazy chunk (the 0333 bundle discipline).
- **Defer CAD entirely.** Rejected: it is the last un-programmed canvas; deferral
  just re-books the same debt.

## Open questions + assumptions

1. **Mesh-parser dependency choice (P1 spike).** STL/OBJ are trivially hand-rollable;
   GLTF/GLB is the question — a small pure-JS GLTF parser vs a vendored WASM one.
   Assumption: a lightweight JS GLTF parser fits the lazy editor chunk; confirm the
   byte cost against the bundle budget before committing. Import must reject anything
   it can't faithfully represent (typed error, never a lossy lookalike — the 0328
   PPTX-import honesty rule).
2. **Solver scope boundary (P4).** The 2D-sketch scope is the committed call. Open:
   whether a sketch plane is a first-class doc concept or a derived construction
   surface — resolve at the P4 `/architect` gate. The 3D-assembly deferral is firm.
3. **Units SSoT.** The document `units` enum (`mm/cm/m/in`) is the current SoT; P3
   dimensions add per-dimension units. Open: whether dimension units must equal the
   doc unit (simpler, less flexible) or convert (flexible, needs a conversion table
   pinned by test). Assumption: enforce doc-unit equality first, convert later —
   the simplest closed world.
4. **BOM material rollup (P2).** Whether the BOM aggregates by material requires the
   P5 material model; assumption — P2 BOM ships material as an opaque per-solid
   string/label, and P5 upgrades it to library-material references without a BOM
   schema break (additive).
5. **PBR viewer default (P5).** Whether the WebGL viewer ever becomes the default or
   stays opt-in per session — decide at the P5 `/ux-review` after measuring the
   chunk cost and the low-end-device fallback.

## RFC / Wire

**None.** Verified against CLAUDE.md § "A spec change needs an RFC" and the ADR
0328 / 0333 precedent: artifact-type schema fields and export facets are
**host-owned and additive** (the 0317/0323 precedent); new artifact types
(`canvas.cad.bom`, mesh assets) are **host-registered**; all routes are non-normative
host-ext under `/v1/host/openwop-app/cad/*`; the AI path rides **already-specced**
envelope kinds and adds **no new envelope KIND or field**. `OPENWOP_REQUIRE_BEHAVIOR`
is unaffected. If a *future* phase ever needs a new envelope kind (e.g. a wire-level
"CAD intent" beyond `result`), that is a **new OpenWOP RFC first** — out of scope
for this host program.

## Phases (updated as they land)

| Phase | Status |
|---|---|
| P1 — Mesh interchange + rendered export | **implemented** (2026-07-17, branch `feat/adr0388-cad-p1-mesh`). Architect-gate rulings recorded: R1 mesh bytes ride the `features/media/mediaStorage` ADAPTER (the S3-swap seam) + a cad-owned content-addressed `cad:mesh` metadata row (`${tenantId}:${sha256}` — same bytes ⇒ same meshId); R2 canonical stored form = binary STL, one codec for import-normalize + export; R3 GLTF import is DISCLOSED geometry-only (`dropped[]` surfaced), typed-reject for Draco/external-URI/sparse (SSRF: the codec never fetches); R4 **correction** — `cad3d.ts`'s painter tessellate cannot emit sphere triangles, so the export-grade source is the NEW `meshCodec` FE↔BE twin (byte-parity-pinned; the viewer keeps its painter path); R5 caps = 4 MB canonical / 50k triangles (sized inside the cad route family's 8 MB parser envelope so the 413 is always typed), viewer budget 8k triangles with deterministic stride sampling + an honesty badge. Export facet `['json','stl','gltf','png']` true in the same change; PNG consumes the `canvas/exportUtils` seam (the 0333 "recorded until CAD consumes" hook, now consumed). |
| P2 — BOM / cutlist | **implemented** (2026-07-17). `canvas.cad.bom` host-registered beside `canvas.cad` (interactive-artifacts multi-type precedent), export `['json','csv']`. `generateBom` is the deterministic zero-AI projection (identity roll-up = kind+dims+material [+assetRef+scale]; exact parametric formulas; mesh area exact, mesh volume signed-tetrahedra FLAGGED `volumeApprox` — the closed-mesh caveat is disclosed, never silent; byte-identical across runs, pinned). ONE CSV builder (RFC-4180) delivered as a capability URL. Route `POST <org>/canvases/:canvasId/bom`; `ctx.features.cad.bomGenerate`; nodes v1.2.0 `bom-generate` (+ the agent prompt's "computed, never model-authored" rule); read-only FE BomPreview renderer + editor BOM button. Cutlist stock-size grouping deferred to the P5 material model (BOM ships material as an opaque label per Open-question 4's recorded assumption). |
| P3 — Dimension system + transform gizmos | **implemented** (2026-07-17). Rulings: dimension VALUES are DERIVED from geometry at read time, never stored (no drift; makes `dimension-suggest` purely deterministic); tolerances are FLAT closed-world fields (`tolType` symmetric\|asymmetric\|limit + `tolA`/`tolB`); `unit` must equal the doc unit (open-q-3's recorded call); solids referenced BY INDEX (positional model kept — validator range-checks at save, renderers tolerant-on-read hide orphans). `dimensions[]` joins the schema/validator/collabShape; 2D renders measured extension lines for linear x/y and stacked value chips for the other kinds (recorded v1 scope; full draughting + 3D leaders are P5+ polish); the editor gains a `dimensions` element collection (adders/props). Gizmo seam: the generic selection chrome (outline + rotate knob + handles + pointer plumbing) extracted to `src/canvas/TransformGizmo.tsx` per the placement rule, consumed by InteractiveCad — caller keeps the type-specific math. Packs v1.3.0 (`dimension-suggest`; render passes `dimensions` through). |
| P4 — Constraint solver (2D sketch scope) | **implemented** (2026-07-17). The hand-rolled deterministic Gauss-Newton landed as the `cadSketch` FE↔BE twin (byte-parity-pinned): fixed iteration cap 100 / tolerance 1e-9 / constraint order = array order / fixed-pivot elimination / fixed Levenberg damping — byte-identical solved coordinates across runs (the golden determinism test = the fork/replay gate). Open-q-2 RESOLVED: the sketch plane is a DERIVED z=0 construction surface, not a doc concept. Full 12-kind constraint set; diagnostics from Jacobian rank (under → freeDof; over → conflicting indices, ORIGINAL coords returned — never a half-solved lie); non-convergence = typed error. Scope notes (recorded): `concentric` uses chord-midpoint centres and `tangent` is line↔arc via the same closed model (honest v1); the FE ships a read-only sketch OVERLAY (points/segments over the projection) — a full interactive sketch editor is the recorded follow-up. Schema/validator additive `sketch`; packs v1.4.0 `sketch-solve` (solving is a closed-world host op; the agent may add constraints, never hand-place solved points). |
| P5 — PBR materials + material library | **implemented** (2026-07-17, scoped). The material LIBRARY landed as the `cadMaterials` FE↔BE twin — a closed-world starter catalog (12 materials; #hex-only safe-paint grammar, gate-exempted as artifact DATA); assignment is by `materialId` (schema enum pinned to the twin, wins over inline paint via ONE `resolveMaterial` used by both renderers) + an `emissive` #hex tint; deterministic `material-recommend` node (fixed keyword rules); packs v1.5.0. **Corrections (recorded):** (a) the third-party `cad-material` PACK KIND is deferred — the catalog module is the seam a pack loader would extend; (b) normal maps are OUT (P1's import drops textures; no texture pipeline to feed them — honest); (c) the OPTIONAL lazy Three.js WebGL viewer is deferred per the ADR's own optional framing + open-q-5 — the hand-rolled projection remains the default, fallback, and export tessellator, now shading library materials; the WebGL revisit re-opens when a proven GPU need (large-mesh or true-PBR demand) arrives. |

Cross-references: ADR 0153 (CAD canvas origin), ADR 0310 (canvas chassis), ADR 0317
(direct manipulation), ADR 0328 (slides program — structural template + honesty-first
+ SSRF posture), ADR 0333 (drawings program — placement rule, viewport, export seam,
ratchet-up cap), ADR 0359 (canvas collab), ADR 0362 (selection toolbar / gizmo host),
LLM-EXCHANGE-AUDIT (schema-parity + typed-failure rules),
docs/steward/MYNDHYVE-GAP-ANALYSIS.md P1.3 / CAD rows.

### Grade pass — 2026-07-17

Same-day 3-lens grade over all five phases; two blockers fixed forward:
`tessellateSolid` anchored exports at the CENTRE with Z-up while every viewer
uses min-corner Y-up (CAD-C1 — exported assemblies didn't match the rendered
arrangement; rewritten in both twins + placement golden), and exports had no
aggregate triangle cap (CAD-C2 — one 50k-tri asset × N solids could OOM the
instance; 500k typed 413 both sides). Plus NaN-honesty hardening across the
codec + sketch solver, CSV formula-injection guard, glTF cycle/count/index
guards, and materialId folded into BOM + export paint. Findings + open items:
`docs/{CODEBASE,UX,DATA}-ASSESSMENT-adr0388-0389-batch.md`.

### Correction — the orbit viewer reaches the EDITOR (2026-07-25)

**What the ADR got wrong.** P5's recorded correction (c) framed the 3D question
as "Three.js WebGL viewer: deferred; the hand-rolled projection remains the
default" — and that deferral still stands, unchanged. But it left an untested
assumption: that the hand-rolled `Cad3dView` we DID ship was reachable wherever
a user needed it. It was not.

`features/cad/definition.tsx` supplies BOTH `Renderer: CadContentView` and
`InteractivePreview: InteractiveCad`. `CanvasEditorPage` branches
`InteractivePreview && elementsDef && doc` **before** its `def.Renderer`
fallback, so the editor centre ALWAYS mounted `InteractiveCad` and `Renderer`
was dead code for `canvas.cad`. Since `CadContentView` is the only thing that
owned the 2D/3D segmented toggle, **the orbit viewer was reachable exclusively
from the chat artifact card** (`registerArtifactRenderer('canvas.cad')`); the
definition has no `preview:` key either, so there was no second path. The
editor — the one surface where you are actually shaping the model — was 2D
front-elevation only. The `definition.tsx` header asserted the opposite ("the
ONE projection renderer is mounted by the editor preview"); that sentence has
been corrected in place.

**Decision.** Add the 2D/3D toggle to `InteractiveCad`'s own bar, mounting the
SAME lazy `Cad3dView` the chat card uses — one implementation, two surfaces. No
new dependency, no wire change, no new workflow: this is the already-built
viewer reaching the surface it was always meant to serve.

**Honesty constraint (load-bearing).** `cad3d.ts` states it directly: an orbit
camera cannot drive footprint dragging. So 3D in the editor is an **inspect
mode**, not an editing mode. It renders no hit layer, no `TransformGizmo`, and
no selection pill — a dead gizmo would be a worse lie than no gizmo — and it
carries a note naming the editing path that remains (switch to 2D, or use the
solid list + property panel, both of which keep working in 3D). 2D stays the
default so the editor opens on the direct-manipulation surface. Full 3D
direct manipulation remains deferred with the WebGL viewer; this does not
smuggle it in.

**Two toolbar-state defects fixed in the same pass** (both predate this change):

- A single `porting` boolean stamped `aria-busy` on all four export buttons at
  once, so one BOM download announced four busy controls and named none. Now a
  `BusyOp` discriminant marks only the running control, with an `sr-only`
  live region naming the operation. Mutual exclusion is retained deliberately —
  the operations contend for the same doc and import navigates away.
- The import affordance is a `<label class="btn-ghost">` wrapping a `disabled`
  `<input>`. **A `<label>` can never match `:disabled`**, so both the base
  `button:disabled` dimming and the ghost disabled rule skipped it: during a
  busy export it rendered fully live and hover-lit while silently eating the
  click. Fixed with `.is-disabled` / `[aria-disabled="true"]` arms on the ghost
  rules (including a hover suppressor) plus `aria-disabled` on the label. Note
  the sibling focus-ring bug in this same control was already fixed by an
  earlier grade pass (`label.btn-ghost:focus-within`) — the disabled case was
  missed then.

Also fixed: PNG export read `svgRef` unconditionally, which is unmounted in 3D;
it now captures whichever view is on screen, and toasts instead of returning
silently when there is no SVG at all.

**Tests.** `features/cad/__tests__/interactiveCadView.test.tsx` (CAD-V1..V4).
Each state assertion was probed by sabotage — reverting each fix turns the
corresponding test red. The busy assertions deliberately drive the **BOM** path:
STL/GLB run to completion synchronously inside their promise, so React never
commits a busy render for them and an assertion there would have passed
vacuously whatever the component did.
