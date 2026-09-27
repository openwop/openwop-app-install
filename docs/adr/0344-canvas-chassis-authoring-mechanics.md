# ADR 0344 — Canvas chassis authoring mechanics (clipboard, hidden/locked, child constraints, structured diff)

Status: implemented (2026-07-10) — 2a #1670, 2b #1672, 2c #1673, 2d #1674

**Program:** ADR 0342 Phase 2. **Depends on / composes:** ADR 0310 (canvas
framework + the core-vs-type placement rule), ADR 0305 B (tree DnD/undo/screen
CRUD; the "Audit gap #3" session clipboard), ADR 0333 (elements-trait
hidden/locked — the pattern this generalizes), ADR 0343 (the document facets the
inspector edits), ADR 0206 (version-history snapshot pattern).
**Research:** `docs/research/app-builder-myndhyve-gap-analysis-and-remediation.md`
§5.1 CV-04/05/06, §5.8 OP-02.
**Toggle:** none new (chassis mechanics ride each canvas type's own toggle).
**Surface:** frontend chassis + the backend catalog owner; no wire.

---

## Context (seam audit, 2026-07-10)

- **Clipboard (CV-04):** a tree session clipboard already exists
  (`CanvasEditorPage.tsx:1015-1036`) — copy/paste only, button-only, no cut, no
  copy-style. Frames have a separate localStorage clipboard (`:81-90`); the
  elements trait has per-kind style memory (`canvas/styleMemory.ts`). Keyboard
  shortcuts all route through ONE owner (`dispatchShortcut`, defaults merged at
  `:684-705`) — no `mod+c/x/v` today.
- **hidden/locked (CV-05):** the ELEMENTS trait already implements both
  (`isLocked` gate `:714`, gesture skips `:723/:743/:760`, list toggles
  `:1902-1928`); TREE nodes have neither — `TreeNodeBase` (`treeOps.ts:12-15`)
  is `{type, props?}` and tree gestures (`applyDrop`/`deleteSelected`/
  `moveSelected`) have no guard.
- **Child constraints (CV-06):** `ComponentDef` (`host/canvasComponentCatalog.ts:37-46`)
  has only boolean `acceptsChildren`; `validateComponentTree` (`:87-118`)
  enforces exactly that; the FE mirrors it at `dropSlot`/`applyDrop`/
  `adjacentContainer` (`CanvasEditorPage.tsx:979/1030/1108`).
- **Structured diff (OP-02):** version compare is a `string[]` summary
  (`summarizeVersions`, `versionSummary.ts`, `HistoryModal.tsx:57-107`) — no
  structured shape exists.
- **Consumers:** tree+frames = app-builder AND slides (the second consumer the
  placement rule requires). graph = app-builder only.

## Decision

Land the four mechanics in the CHASSIS, each proven by both tree consumers
(app-builder + slides) or a domain-neutral contract; type-specific vocabulary
(schemas, validators, renderers, generators) stays in the features.

| Slice | Core (chassis) | Per-type |
|---|---|---|
| **2a — clipboard completion** | cut (copy+delete as one undo step); `mod+c/x/v` via the shortcut owner (skipping editable-target events); clipboard envelope gains `{canvasTypeId}` and paste validates type-compatibility; explicit **copy-style/paste-style** commands over the CATALOG-approved style props (the token-scale enums + `color`), stored beside the node clipboard | none (style props derive from each type's catalog prop-defs) |
| **2b — hidden/locked tree traits** | optional `hidden`/`locked` on `TreeNodeBase`; core gesture gates mirroring the elements-trait pattern (locked ⇒ no drag/drop/delete/prop-edit; hidden ⇒ dimmed row + skipped in read/preview render); outline row toggles + property-panel checkboxes with non-color indicators + keyboard toggles | app-builder: `hidden`/`locked` on the component `$def` (schema + `validateAppDoc`), renderer skips hidden in READ mode, all 7 generators skip hidden nodes; slides: same additive schema treatment |
| **2c — child constraints** | FE enforcement reads the catalog def at the existing drop/palette gates | backend `ComponentDef` gains optional `allowedChildTypes`/`minChildren`/`maxChildren`; `validateComponentTree` enforces them (hard); app-builder catalog annotates the containers where the constraint is real (e.g. `tabs`/`carousel` accept any; a future `form` restricts) — annotations land conservatively WITH consumers |
| **2d — structured diff** | `summarizeVersions` return widens to `string[] \| StructuredDiff` (`{lines, entries?: {path, kind: added\|removed\|changed, label}[]}`); `HistoryModal` renders entries as a navigable list when present; the default frames-differ emits the structured shape generically | app-builder projector: screens/components/connectors/models/actions entries |

### Deliberately deferred (recorded)

- **Workspace/inspector-tab slot (AI-05)** and **GraphSurface entity view
  (DA-03)** move to Phase 3: their first real consumer is the Data workspace
  (models/operations editors). Landing the slots now would be consumer-less
  surface (the ADR 0307 rule, applied twice already in Phase 1).
- **Template variables (CT-04)** move to Phase 5 with the kit work they serve.

## Alternatives weighed

- **A feature-level clipboard in app-builder.** Rejected: the session clipboard
  already lives in the chassis; forking it per type is drift (two clipboards,
  one concept).
- **OS clipboard (navigator.clipboard) for subtrees.** Rejected for v1:
  cross-app JSON paste is an injection surface; the session envelope keeps the
  closed world (revisit with explicit import validation if cross-canvas paste
  is demanded).
- **min/max child counts as document-level validator rules** (validateAppDoc).
  Rejected: the catalog is the single owner of per-type component legality;
  the document validator owns document-level caps only.

## RFC verdict

None — chassis + host-internal catalog; no wire, no capability, no routes.

## Phases

| Slice | Status |
|---|---|
| 2a | landed (PR #1670) — module-scoped session clipboard (cross-canvas, type-keyed) + cut + `mod+c/x/v` twins (text-selection-yielding) + catalog-vocabulary copy-style/paste-style (`alt+mod+c/v`), 8 new strings × 4 locales |
| 2b | landed (this PR) — `hidden`/`locked` on `TreeNodeBase` + BOTH consumer schemas (app-builder component $def, slides slideBlock $def); locked gates every tree gesture (drag/drop/move/delete/cut/prop-edit, panel fieldset-disabled) except the unlock toggle; hidden = dimmed+glyph in outline, chip-labeled dim in EDIT render, ABSENT from read renders + slides export + all 7 app-builder generators via the shared `stripHidden` pass. As-built: toggles are panel checkboxes (keyboard-reachable) + outline indicators, not risky `mod+H/L` combos |
| 2c | landed (this PR) — `ComponentDef.allowedChildTypes/minChildren/maxChildren`; allowed+max HARD in `validateComponentTree`, min SOFT via `validateAppDoc` (the mid-edit rule — an as-built correction to the "enforce in server validator" sketch); one shared `canAdopt` rule behind palette-add, both drop paths (with container fall-through to the sibling slot), paste, and keyboard in/out moves, with an announced refusal. NO production catalog annotation yet — annotations land with their consumers (Phase 3 forms) |
| 2d | landed (this PR) — `summarizeVersions` widened to `string[] \| VersionDiff` (kind-tagged entries; `path` uses the validateAppDoc address grammar); the chassis frames-differ + generic fallback emit the structured shape (the domain-neutral proof); HistoryModal renders entries with neutral Added/Removed/Changed chips; app-builder projector covers screens + the 0343 facets (models/operations/state/env/definitions/authProfile) with TIMELINE direction ("since this version") standardized across both differs |
