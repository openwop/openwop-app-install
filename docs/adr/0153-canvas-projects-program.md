# ADR 0153 — Canvas & Projects program (MyndHyve port): the canvas-as-artifact architecture

**Status:** Proposed — 2026-06-27. (Umbrella/program ADR; each phase lands its own ADR.)
**Toggle:** per-canvas feature toggles (one per canvas type); the shared substrate is core (no toggle).
**Surface:** host-extension only. **No new OpenWOP wire RFC for Track 1** (see §RFC gate).
**Depends on (all already implemented/Accepted):**
- `host.canvas` — Stable v1.1 normative capability (`spec/v1/host-capabilities.md §host.canvas`); impl `host/canvasSurface.ts` (versioned, optimistic-concurrency `DurableCollection('canvas')`).
- `host.launchStudio` — Stable normative capability (`§host.launchStudio`); impl `host/launchStudioSurface.ts` (multi-step project/canvas studio).
- ADR 0055 host artifact-type registry (`host/artifactTypes.ts`, + pack loader) · ADR 0056 canvas→document one-way materialization (`features/documents/routes.ts:66 /documents/from-canvas`) · ADR 0053/0057 Documents + rendering (pdf/pptx/csv) · ADR 0069 chat artifact workbench · ADR 0073 EmbeddedChatPanel · ADR 0046 project Subject + `host/subjectOrgScope.ts`/`subjectAccess.ts` · ADR 0058/0072 chat-drivability = agent + closed-world catalog · ADR 0051 A2UI closed catalog · ADR 0083 run-output artifacts (deterministic `${runId}:${nodeId}`).
- **ADR 0152 workflow-chain pack loader (Accepted 2026-06-27)** — canvas generators ship as signed RFC 0013 workflow-chain packs through the *existing* catalog. (Closes the [[workflows-belong-in-workflow-packs]] gap.)
- RFC 0071/0075 artifact-type + chat-card packs (Accepted) · RFC 0013 (Accepted) · RFC 0003 agent packs.

> **Architect-reviewed 2026-06-27** (`/architect`, Track A). The review overturned the
> initial "a canvas IS a Documents record" premise — see §Decision R1. Maintainer confirmed
> the store-ownership call (`host.canvas` owns live state) before this ADR was written.

---

## Context — the ask, and what already exists

We are porting MyndHyve's **canvases & projects** (app-builder, slides, drawings, cad,
campaign-studio, documents, canvas-builder — 7 types) into openwop-app, **re-architected**.
The product requirements:

1. **Any AI chat turn or workflow run can output a canvas of any type, rendered inline in the chat feed.**
2. **The app-builder canvas additionally opens full-screen, outside the chat**, persisted as a
   project document, with a component **palette + drag-drop** and a right-sidebar **property editor**;
   the LLM has the app-builder system prompt + component JSON schemas and generates screens,
   connectors, preview.
3. **Each canvas is an independently feature-toggleable feature.**
4. (Stretch) **Features as downloadable plugins** from `packs.openwop.dev`, enabled in the
   toggle admin — "100% extendable."

**Pre-existing-surface audit (the load-bearing finding).** openwop-app already owns most of
the substrate. There is **no "canvas pack" kind** — OpenWOP RFC 0071 *deliberately rejected*
shipping renderer code in a pack ("openwop is the wire contract … not a renderer"). What
exists instead:

| Capability the ask needs | Already in-tree | Owner |
|---|---|---|
| Live, versioned, editable canvas store | ✅ `host.canvas` (`DurableCollection('canvas')`, `expectedVersion` writes, `canvasTypeId`/`projectId`/`state`/`version`) | `host/canvasSurface.ts` (wire-normative) |
| Project / multi-step canvas studio shell | ✅ `host.launchStudio` (`Studio.steps[]{canvasTypeId}`, `buildProjectContext`) | `host/launchStudioSurface.ts` (wire-normative) |
| Typed artifact emission + schema validation | ✅ artifact-type registry (host-native + pack-loaded) | `host/artifactTypes.ts` (ADR 0055) |
| Canvas → durable export (pdf/pptx/md) | ✅ one-way materialize | `documents/from-canvas` + render (ADR 0056/0057) |
| Inline render of a typed artifact in chat | ✅ workbench + the **card registry** extensibility seam | `chat/artifacts/ArtifactWorkbench.tsx`, `chat/registry/CardRegistry.ts` |
| Palette + drag-drop + schema-driven property editor | ✅ reusable builder primitives | `builder/` (xyflow `BuilderCanvas`, `NodePalette`, `Inspector`, `ConfigInput`) |
| Replay-safe run output | ✅ deterministic-keyed artifact store | `host/runArtifactStore.ts` (ADR 0083) |
| Generators published as signed packs | ✅ workflow-chain pack loader | ADR 0152 + RFC 0013 |

**The genuinely new/hard part is requirement 4** (downloadable *front-end-UI* plugins), which
the OpenWOP wire does not support today and intentionally carves as host-domain. It is **not a
prerequisite** for 1–3.

---

## Decision

**Two tracks. Decouple them (maintainer decision 2026-06-27).**

### Track 1 — canvases as in-tree, toggleable feature-packages (ships now)

Port each canvas as a self-contained feature-package (ADR 0001), composing the existing
substrate — **no parallel store, no parallel chat, no parallel render path.**

- **R1 — store ownership (the corrected root decision).** The **live, editable canvas is a
  `host.canvas` record** (single source of truth; already versioned + optimistic-concurrency —
  ideal for a drag-drop editor). **Documents holds the one-way materialized export**
  (ADR 0056, unchanged direction). A run that *generates* a canvas emits an **immutable**
  artifact (`runArtifactStore`, replay-safe); "Open in editor" **seeds a new `host.canvas`
  working copy from that artifact** — the run output is never mutated in place (replay/fork
  safety, ADR 0031/0083). *This reverses the initial "a canvas IS a Documents record" premise,
  which would have forked a second store over `host.canvas`.*

- **R2 — the full-screen app-builder shell composes existing surfaces**, it does not invent a
  new one: `host.launchStudio` (project/steps) + `host.canvas` (live state) +
  `EmbeddedChatPanel` (ADR 0073, scoped to the canvas agent — **not** a second chat). The
  editor owns only palette/inspector/preview chrome; chat stays the one primitive.

- **R3 — inline rendering registers through a seam, not a core `if/else`.** Today
  `ArtifactWorkbench.tsx:208` dispatches by `artifactTypeId` with a hardcoded chain. Introduce
  an **artifact-renderer registry** mirroring the existing **card registry**
  (`registerCard({cardType, Component})` + `CardErrorBoundary`, the documented extensibility
  seam). Each canvas feature **registers** its inline renderer; core is not edited per feature
  (ADR 0001 boundary). Refactor the existing hardcoded chain into this registry as part of the
  substrate ADR.

- **R4 — one component catalog, host-pinned, per-feature-contributed, closed-world.** A single
  catalog object feeds **all three** consumers — (a) the canvas agent's system prompt, (b) the
  editor palette, (c) generation-time validation — so they cannot drift (MyndHyve's god-singleton
  fed the prompt at build time and could not be reconciled; this is the anti-pattern). Features
  contribute into a core registry at boot (like `AgentRegistry`/artifact-type registry).
  Generation is **closed-world**: the LLM emits typed component JSON referencing only catalog
  entries; unknown types are rejected (mirror ADR 0072 `unknown_typeid`, ADR 0051 A2UI closed
  catalog). **The model never emits executable code.** ADR 0128's raw-code sandboxed-iframe
  path is reserved for free-form `html`/`react` artifacts only, never the structured canvases.

- **R5 — generation goes through the one chat + workflow packs.** Each canvas ships
  `feature.<canvas>.{nodes,agents}` + an RFC 0013 **workflow-chain pack** (loaded via ADR 0152),
  driven through the existing chat (ADR 0058 "chat-drivability = agent + nodes"). No bespoke
  canvas chat panel; no in-tree pinned workflow module ([[workflows-belong-in-workflow-packs]]).

- **R6 — RBAC via the subject seams.** Canvas ownership = `ownerSubject` (project/user/agent) →
  org via `subjectOrgScope.ts`, read/write level via `subjectAccess.ts` (ADR 0046/0054). Extend
  `host.canvas`'s current tenant-scoping to project-ownership through those resolvers; no new
  per-route checks. Fail-closed.

- **R7 — Track-1 extensibility = downloadable *backend* packs.** New canvas *types* can be added
  via signed packs (artifact-type + node/agent + workflow-chain) whose renderer is one of the
  host's **generic** renderers (the catalog renderer serves any catalog-based canvas). This is
  fully supported today (ADR 0152 + 0055 loaders). True downloadable *front-end* renderers are
  Track 2.

### Track 2 — downloadable front-end-UI plugins (deferred, RFC-gated)

"100% extendable, download a canvas *editor* plugin and enable it in the toggle admin" needs:
a **new OpenWOP RFC** defining a portable front-end/plugin pack kind (the thing RFC 0071
currently rejects) — safe FE code distribution, cross-origin **iframe + postMessage** sandbox,
host-RPC capability gating, signing — **plus** a host runtime FE-plugin loader (features are
in-tree compiled today; the marketplace installs backend packs only). This is the largest,
highest-risk piece and is **explicitly out of scope for Track 1**. Stub only; author via `/prd`
when prioritized. (Industry note: the safe pattern is VS-Code/Figma-style declarative
contribution + cross-origin sandboxed-iframe RPC; never in-process module federation for
untrusted UI.)

---

## Phased delivery (Track 1)

| Phase | Scope | Proves / why this order | ADR |
|---|---|---|---|
| **0 — Substrate** | the inline artifact-renderer registry (R3) + `ArtifactWorkbench` refactor | the render seam every canvas plugs into | **landed** (this branch) |
| **1 — Slides (pilot)** | `canvas.slides` artifact-type + `feature.slides.{nodes,agents}` packs + Slide Designer agent + inline `SlidesPreview` renderer; toggle `slides` (off) | inline-only, simplest — proves artifact→chat render end-to-end | **landed** (this branch; export via Documents deferred to a follow-up) |
| **2a — App-builder foundation** | `host/canvasComponentCatalog` (one catalog → prompt+palette+validation, closed-world) + `canvas.app-builder` artifact-type + `feature.app-builder.{nodes,agents}` + App Architect agent + read-only inline `AppBuilderPreview` | the artifact + catalog substrate; proves chat→render | **landed** (this branch) |
| **2b — App-builder editor** | _backend foundation landed_: additive `host.canvas.ownerSubject` (R6) + `createCanvasForTenant` + `seedCanvasFromArtifact` (R1, idempotent). _Remaining_: the full-screen drag-drop editor FE (palette/property panel) over `host.canvas`, reusing `builder/` primitives | the flagship editing UX | **backend landed**; editor FE next |
| **3** | `campaign-studio` canvas (net-new, inline-artifact pattern). **`documents` canvas → REUSE Documents (ADR 0053); `canvas-builder` → REUSE the `builder/` surface** (no new canvas types — see §Phase-3/4 reuse) | breadth on the proven pattern | next |
| **4** | `cad`, `drawings` — need bespoke WebGL/raster host renderers (gated per-feature); heaviest | last | next |
| **(Track 2)** | FE-plugin RFC + host loader | separate epic, RFC-gated | `/prd` later |

(ADR numbers assigned at authoring time — origin/main is actively advancing; do not pre-grab.)

> **§Correction (Phase-0 scope, this branch).** The Phase-0 architect pass narrowed the
> substrate to the **render seam only** — the artifact-renderer registry (R3) + the
> `ArtifactWorkbench` refactor — because that is the one piece *every* canvas needs and it
> has zero wire/RBAC surface. The **component-catalog registry (R4)** moves to **Phase 2**
> (app-builder), where it is first consumed (slides carries a small fixed element schema in
> its own artifact-type — no shared catalog needed for the pilot). The **`host.canvas`
> project-ownership (R6)** + **seed-working-copy-from-artifact (R1)** flows move to **Phase 2**
> as well, since they are only exercised when a canvas opens in the full-screen editor; the
> inline-only slides pilot needs neither. This is "build when first consumed," not a scope cut.

## Explicitly NOT copied from MyndHyve (anti-patterns)

Forked per-store Firestore collections (`canvases`/`screens`/`components`) with bespoke
per-store sync; the god-singleton `ComponentRegistry`; race-dependent module init order;
session-only (non-persisted) artifact cache; tool-allowlists duplicated across 3 files. The
re-architecture replaces all of these with the single `host.canvas` store + the one
contributed catalog + the existing artifact/run seams.

## RFC gate

**Track 1 needs NO new wire RFC.** Live canvas store/edit → already-Stable `host.canvas` +
`host.launchStudio`; chat emission → artifact-type packs (RFC 0071/0075, Accepted); generators
→ workflow-chain packs (RFC 0013 + ADR 0152); export → Documents (host-ext). A new RFC becomes
**required** only when: (a) a `canvas.*` type must render *identically across other hosts*
(normative shared type — overturns RFC 0071's host-domain-rendering stance); (b) `host.canvas`
gains new methods (e.g. a component-level sub-resource); or (c) packs must contribute
components/renderers *portably* across hosts — which **is** Track 2.

## Open questions

1. Drawings/cad renderers — generic catalog renderer insufficient; bespoke host renderers (raster/WebGL) needed, gated per-feature. Decide at Phase 4.
2. `host.canvas` is tenant-scoped today; R6 adds project-ownership — confirm no migration of existing `vendor.myndhyve.canvas` rows (additive `ownerSubject`).
3. Whether `canvas-builder` (MyndHyve's meta-canvas) maps onto the **existing** workflow builder (`builder/`) rather than a new canvas type — **resolved: yes** (§Phase-3/4 reuse).

## §Phase-3/4 reuse (architect, pre-build)

Not every MyndHyve canvas becomes a new canvas type — the boundary rule
("build ON existing surfaces, never a parallel one") maps two of the seven onto
surfaces openwop-app already owns:

- **`documents` canvas → the existing Documents feature (ADR 0053).** openwop-app
  already has versioned, provenance-stamped markdown business-documents with a
  full-screen editor. A "documents canvas" would fork that store — forbidden. Long-form
  writing routes through Documents, not a `canvas.documents` type.
- **`canvas-builder` (MyndHyve meta-canvas) → the existing workflow builder (`builder/`).**
  Already an xyflow DAG authoring surface (+ ADR 0072 "Create with AI"). No new canvas type.
- **Net-new, genuinely new canvas types:** `campaign-studio` (Phase 3, inline-artifact
  pattern like slides), and `cad` + `drawings` (Phase 4) — the only two needing **bespoke
  host renderers** (WebGL / raster) beyond the catalog/structured renderers, so they are
  gated per-feature and sequenced last.

## Track 2 (deferred) — front-end-plugin pack kind + host loader

The "download a canvas *editor* plugin and enable it in the toggle admin" ambition is a
**separate, RFC-gated epic**, explicitly out of Track 1. It requires, in order:

1. **A new OpenWOP RFC** (author via `/prd`) for a portable **front-end/plugin pack kind** —
   the thing RFC 0071 currently rejects. It must specify: safe FE code distribution
   (signed bundle), a **cross-origin sandboxed-iframe + `postMessage` RPC** isolation model
   (never in-process module federation for untrusted UI), the host-RPC capability surface
   the plugin may call, capability gating, and graceful degradation on hosts that don't
   support it. MUST reach `Accepted` before host work.
2. **A host runtime FE-plugin loader** (features are in-tree compiled today; the marketplace
   installs backend packs only) that discovers installed FE-plugin packs, renders them in
   the sandbox, and exposes them through the existing feature-toggle admin.

Until then, Track-1 extensibility = downloadable **backend** packs (artifact-type +
node/agent/workflow) whose renderer is a host-provided generic renderer (R7).

## Status (this branch, `feat/canvas-program`)

| Increment | State |
|---|---|
| Program ADR 0153 + architect review | ✅ landed |
| Phase 0 — artifact-renderer registry seam | ✅ landed (6 tests) |
| Phase 1 — slides canvas (artifact + packs + inline renderer + toggle) | ✅ landed (7 tests) |
| Phase 2a — app-builder catalog + artifact + generator packs + inline renderer | ✅ landed (10 tests) |
| Phase 2b — backend: `ownerSubject` + seed-from-artifact | ✅ landed (5 tests) |
| Phase 2b — editor routes (catalog + canvas read/seed/optimistic-write) | ✅ landed (8 tests) |
| Phase 2b — full-screen editor FE page (palette + screen tabs + live preview + outline-select + catalog-driven property panel + optimistic save; "Open in editor" from the chat card) | ✅ landed (6 tree tests; drag-drop reorder is a follow-up enhancement) |
| Phase 3 — campaign-studio canvas (artifact + packs + inline renderer + toggle) | ✅ landed (6 tests) |
| Phase 3 — documents → Documents (ADR 0053), canvas-builder → builder/ (no new types) | ✅ decided (reuse) |
| Phase 4 — drawings canvas (artifact + packs + safe inline-SVG renderer + toggle) | ✅ landed (7 tests) |
| Phase 4 — cad canvas (artifact + packs + dependency-free orthographic SVG projection renderer + toggle) | ✅ landed (7 tests; interactive WebGL viewer is a documented follow-up — no bundle room for Three.js) |
| Track 2 — FE-plugin RFC + loader | ⏳ deferred (RFC-gated) |

Every landed increment: architect-reviewed before build, `/code-review` + `/ux-review`
after, all fixes applied, FE build + backend tsc/tests green, committed DCO-signed.
