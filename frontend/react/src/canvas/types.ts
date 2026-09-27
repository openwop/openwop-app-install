/**
 * Canvas Editor Framework — the CanvasTypeDefinition contract (ADR 0310).
 *
 * A canvas type declares itself as a plain TYPED object imported by its own
 * feature routes — never a string-id registry lookup (the MyndHyve lesson: config
 * referencing plugins by unchecked strings silently dropped slots). The framework
 * owns the chassis (shell, toolbar, history, selection, DnD, properties, frames);
 * the type owns its Renderer and its document semantics via small orthogonal
 * TRAITS — deliberately not render modes. Traits carry their factory INSTANCES
 * (`frameOps`/`treeOps`), so the definition is fully typed end to end.
 *
 * i18n: framework strings live in the `canvas` namespace; the framework also
 * reads a FIXED key contract from the type's own namespace for type-vocabulary
 * strings — `editorHeading`, `docName`, `deleteDoc*`, `frames`, `addFrame`,
 * `frameDefaultName`, `frameActions`, `renameFrame`, `duplicateFrame`,
 * `deleteFrame*`, `annFrameAdded`, `annFrameDeleted`, `setHome`, `home`,
 * `templateTag`, `cat_<category>`, `previewHeading`, `theme_doc`, `noFrames`,
 * `framesLabel` — the words that name screens vs slides vs pages.
 *
 * @see docs/adr/0310-canvas-editor-framework.md
 * @see docs/research/canvas-framework-rearchitecture.md
 */
import type { ComponentType, ReactNode } from 'react';
import type { CollabState } from './useCollab.js';
import type { FrameBase, FrameOps } from './frameOps.js';
import type { TreeNodeBase, TreeOps } from './treeOps.js';
import type { Edge as GraphEdgeSide, Routing as GraphRouting } from './graph/edgeRouting.js';
import type { VersionSummary } from './versionSummary.js';
import type { PreviewRuntime } from './InteractiveViewer.js';

/** ADR 0345 3d — a type-contributed workspace tab (alternate center surface). */
export interface WorkspaceTabProps {
  doc: Record<string, unknown>;
  /** One history-integrated edit: mutate the CLONED doc; the chassis commits. */
  commitDoc: (mutator: (doc: Record<string, unknown>) => void) => void;
  orgId: string;
  onAnnounce: (msg: string) => void;
}
export interface WorkspaceTabDef {
  id: string;
  /** TYPE-namespace label key for the switcher button. */
  labelKey: string;
  Component: ComponentType<WorkspaceTabProps>;
}

/** One field a component/element exposes to the property panel. Mirrors the
 *  backend `ComponentPropDef` (host/canvasComponentCatalog.ts) — the lingua
 *  franca of property editing across catalog AND fixed-schema types. */
export interface CanvasPropDef {
  name: string;
  type: string; // built-ins: string | number | boolean | enum | color | longtext; anything else via propertyWidgets
  label?: string;
  /**
   * SL-G7 — an explicit i18n key for this field's label, preferred over the
   * `prop_<name>` convention `PropertyForm` otherwise derives.
   *
   * Needed when ONE prop name carries DIFFERENT labels in different contexts:
   * slides stores a single `title` field but calls it "Title" on most layouts
   * and "Quote" on the quote layout, so `prop_title` cannot serve both and the
   * field was left the only untranslated one in its panel. Set this and the
   * name→key coupling stops being a ceiling.
   */
  labelKey?: string;
  options?: string[];
  default?: string | number | boolean;
  required?: boolean;
  /** Client-side bounds mirroring the type's backend validator (ADR 0333 grade
   *  pass DRAW-R4 / DATA-D9) so a panel edit clamps instead of round-tripping to
   *  a 422. HTML-native names (fed straight to the input); the JSON-Schema
   *  correspondence is `minimum`/`maximum`/`maxLength`. `number` → min/max/step
   *  (clamped on blur); `string`/`longtext` → maxLength (browser-enforced).
   *  FE-ONLY: the served backend `ComponentPropDef` does NOT carry these — adding
   *  them to the wire would be an RFC change. The backend validator remains the
   *  authority; these only spare the common edit an avoidable rejection. */
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  /** ADR 0362 — promote this prop to the bar's contextual quick cluster
   *  (boolean/enum only in v1; first 3 win). FE-only marker — never mirrored
   *  onto the served catalog (that would be wire-relevant). */
  quick?: boolean;
}

export interface CanvasPaletteItem {
  type: string;
  label: string;
  description?: string;
  category: string;
  acceptsChildren?: boolean;
  /** ADR 0344 2c — mirrored from the backend ComponentDef so the FE canAdopt
   *  gate has compile-time parity (it reads these off the live catalog def;
   *  a projection that dropped them would fail OPEN — grade pass 5B-R4). */
  allowedChildTypes?: readonly string[];
  maxChildren?: number;
  props?: CanvasPropDef[];
}

/** A generic document node (the tree trait's shape). */
export interface CanvasNode {
  type: string;
  props?: Record<string, unknown>;
  children?: CanvasNode[];
}

/** Back-compat alias (§7.3 / CV-11) — the preview-page shape. */
export type DevicePreset = DeviceFrame;

export interface CanvasValidation {
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
}

/** The editor's advisory selection, in RFC 0130 `host.selectionChanged` shape.
 *  `kind` is host-defined; consumers tolerate unknown kinds/absent fields. */
export interface CanvasSelectionInfo {
  kind: 'element' | 'frame' | 'node' | 'none';
  collection?: string;
  index?: number;
  path?: number[];
  frameId?: string;
}

/** The selected element in an elements-trait document. */
export interface ElementSelection { col: string; idx: number }

/** §7.4 / CV-7 — the near-selection pill verbs (chassis-owned history; the
 *  surface anchors the shared `SelectionPill` above the selection bbox). */
export interface ElementActions {
  /** Absent when the selection can't duplicate (collection at max). */
  duplicate: (() => void) | undefined;
  remove: () => void;
  toggleLock: () => void;
  locked: boolean;
  /** Present only for chrome-gated collections with a multi-selection. */
  group?: (() => void) | undefined;
  ungroup?: (() => void) | undefined;
}

/** Props for a type's direct-manipulation preview (ADR 0310 Phase C follow-up,
 *  research §5.5) — an ELEMENTS-trait type MAY render its scene interactively
 *  (click-select + drag on the canvas) instead of the read-only Renderer. The
 *  chassis owns selection + history; the preview only reports gestures. */
export interface InteractivePreviewProps<Doc extends object = Record<string, unknown>> {
  /** The live edited document. */
  doc: Doc;
  /** The chassis's current element selection (drives the outline/handles). */
  selection: ElementSelection | null;
  /** Select an element (a click on its shape). */
  onSelect: (col: string, idx: number) => void;
  /** Clear the selection (a click on empty canvas). */
  onClearSelection: () => void;
  /** The full MULTI-selection for `col` (ADR 0317) — the chassis owns it, shared
   *  with the element list, so canvas marquee and keyboard-list selection stay
   *  in sync. Empty when nothing in `col` is selected. */
  selectedIndices: (col: string) => number[];
  /** Replace the multi-selection for `col` (canvas marquee / group ops). */
  onSetSelection: (col: string, idxs: number[]) => void;
  /** Merge `patch` into an element's fields during a direct-manipulation
   *  gesture. `phase` maps to the history model: 'start' opens ONE undo step
   *  (pushes the pre-gesture snapshot), 'move' updates live (no new history),
   *  'end' finalizes (marks dirty). A move/resize is thus one undoable step. */
  patchElement: (col: string, idx: number, patch: Record<string, unknown>, phase: 'start' | 'move' | 'end') => void;
  /** Batch variant (ADR 0317 multi-select): apply several element patches in ONE
   *  gesture step, so a group move is a single undo entry. Same phase semantics.
   *  Patching multiple elements by looping `patchElement` would NOT work — each
   *  call clones the committed doc, so the second overwrites the first. */
  patchElements: (col: string, patches: { idx: number; patch: Record<string, unknown> }[], phase: 'start' | 'move' | 'end') => void;
  /** Delete several elements at once (index-descending so indices stay valid),
   *  respecting the collection's `min`. Returns the count actually removed. One
   *  undo step. */
  deleteElements: (col: string, idxs: number[]) => number;
  /** ADR 0359 residuals (the deferred D5 scene half) — peers' element
   *  selections for `col`, chassis-supplied ONLY while a collab session is
   *  live. A preview MAY render them (dashed hue outline + name flag via the
   *  shared `canvas/PeerSelectionOverlay`); absent ⇒ solo, zero render delta.
   *  Positions are eventually-consistent (the rail-marker semantics). */
  peerSelections?: (col: string) => { idx: number; name: string; color: string }[];
  /** The chassis-owned active tool id (ADR 0333 Phase 2; `'select'` when the
   *  type declares no tools). A pointer tool changes what the interactive
   *  canvas does with background gestures. Optional so existing consumers
   *  compile unchanged. */
  activeTool?: string;
  /** Commit freshly-drawn elements in ONE history step (ADR 0333 Phase 3 —
   *  the Phase-2 "pointer-session API" resolved to this seam): the pen's
   *  live stroke is type-local overlay state; pen-up calls this. Respects the
   *  collection's `max` (excess elements are dropped); returns the new
   *  indices (empty at the cap) and selects them. */
  addElements?: (col: string, els: Record<string, unknown>[]) => number[];
  /** A monotonically-increasing CANCEL signal (ADR 0333 grade pass DRAW-R3):
   *  the chassis bumps it on Esc so the type drops any live overlay gesture
   *  (drag/ink/eraser/draw). The chassis separately reverts a drag's history
   *  entry — the type only clears its own transient state. Watch it with a
   *  `useEffect` keyed on the number. */
  cancelSignal?: number;
  /** §7.4 / CV-7 — the near-selection pill verbs for the CURRENT selection
   *  (null when nothing is selected). The surface renders the shared
   *  `SelectionPill` anchored above the selection's screen bbox. */
  elementActions?: ElementActions | null;
}

/** Props for a type's FULL editor center panel (ADR 0334) — the `EditorSurface`
 *  seam GENERALIZES `InteractivePreview` beyond the elements trait. A canvas
 *  type whose document is a linear rich flow (fits none of frames/tree/elements/
 *  graph — the ADR 0310 "supplies its own center panel" case) mounts its own
 *  editor engine (e.g. TipTap/ProseMirror) here.
 *
 *  Ownership split (the load-bearing rule): the CHASSIS owns save (CAS/409),
 *  version snapshots, and dirty state (via `useCanvasDoc`); the EDITOR owns
 *  intra-document selection AND undo/redo. `onDocChange` therefore updates the
 *  working copy + marks dirty but does NOT push a chassis-history step (two undo
 *  stacks would fight). The chassis suppresses its undo/redo toolbar for
 *  EditorSurface types — the editor's own Cmd+Z / Cmd+Shift+Z govern. */
export interface EditorSurfaceProps<Doc extends object = Record<string, unknown>> {
  /** The active org — an EditorSurface that inserts org-scoped resources (media
   *  assets, embeds) needs it (ADR 0334 2b; mirrors PropertyWidgetProps.orgId). */
  orgId: string;
  /** The persisted canvas id, once it exists — an EditorSurface that anchors
   *  server-side resources to the canvas (inline comment threads, ADR 0334 6b)
   *  needs it. Absent for a not-yet-saved canvas; such features stay disabled. */
  canvasId?: string;
  /** The live edited document (the working copy). */
  doc: Doc;
  /** Replace the working document after an in-editor edit. Marks dirty +
   *  debounce-saves through the chassis; never pushes a chassis-history step. */
  onDocChange: (doc: Doc) => void;
  /** The editor's live-region sink (a11y announcements — WCAG 4.1.3). */
  onAnnounce: (message: string, politeness?: 'polite' | 'assertive') => void;
  /** The real-time collaboration session (ADR 0359 D2) — provisioned by the
   *  CHASSIS (resolve-once toggle gate + `useCollab` + seeder election) when the
   *  definition declares `collab` and the `realtime-collab` + type toggles are
   *  both on. `{ enabled: false }` (or absent) ⇒ the solo single-writer path.
   *  When enabled, the surface binds its model to `collab.ydoc` (y-prosemirror
   *  for `'document'`; the Phase 3 element binding for `'elements'`), swaps to
   *  per-user undo, and the chassis suppresses its CAS save (the CRDT snapshot
   *  is the durable authority while the room lives). */
  collab?: CollabState;
  // (A `readOnly` prop shipped here unwired — no chassis path ever passed it;
  //  the read path is the type's `Renderer`. Removed in the #1601 review pass;
  //  ADR 0334 6b reintroduces it WITH its consumer if range-anchored review
  //  needs an uneditable live surface.)
}
export type EditorSurface<Doc extends object = Record<string, unknown>> = ComponentType<
  EditorSurfaceProps<Doc>
>;

/** The `flow` trait (ADR 0334) — a linear rich-text/prose document that fits
 *  none of frames/tree/elements/graph. It carries no editable schema of its own
 *  (the engine owns the prose model); it only PROJECTS the doc into shapes the
 *  chassis reuses without knowing the prose model. Wired Phase 3. */
export interface FlowTraitDef<Doc extends object> {
  /** Project the doc into an outline for the shared outline / navigation pane:
   *  heading text + nesting level + a stable anchor id (scroll target). */
  headings: (doc: Doc) => { id: string; text: string; level: number }[];
}

/** Props handed to a registered property widget (keyed by `CanvasPropDef.type`). */
export interface PropertyWidgetProps {
  id: string;
  /** CS-G3 — the type-namespace translator (the ADR 0340 `prop_*`/`opt_*`
   *  machinery `PropertyForm` and `QuickPropsCluster` already use). Optional so
   *  existing widgets are unchanged; a widget that renders enum OPTIONS needs it,
   *  because without it a custom widget cannot localize what the built-in `enum`
   *  branch localizes on the very same panel. Always falls back to the code. */
  tt?: (key: string, opts: { defaultValue: string }) => string;
  /** The active org — widgets that browse org-scoped resources (media assets)
   *  need it (ADR 0328 Phase 2). */
  orgId: string;
  def: CanvasPropDef;
  value: unknown;
  /** Discrete-gesture change (one history entry). */
  onChange: (value: unknown) => void;
  /** Text-typing change (history.replace — DEF-6; native undo in-field). */
  onChangeText: (value: unknown) => void;
  /** The doc's frames (id + name) — for frame-reference pickers. */
  frames: readonly FrameBase[];
  /** The live edited document (READ-ONLY context) — for widgets that pick from
   *  app-specific doc structure beyond frames (e.g. a dataSource ref over
   *  `doc.dataSources`). Mutate only via `onChange`/`onChangeText` (ADR 0323). */
  docState: Record<string, unknown>;
}
export type PropertyWidget = ComponentType<PropertyWidgetProps>;

/** Props handed to the type's toolbar-extras slot (rendered after Save). The
 *  slot self-gates (useFeatureAccess) and owns its own modals/i18n. */
export interface ToolbarExtrasProps {
  orgId: string;
  canvasId: string;
  docName: string;
  dirty: boolean;
}

export interface FramesTraitDef<Doc extends object, F extends FrameBase> {
  ops: FrameOps<Doc, F>;
  /** ADR 0328 P3 — intercept a frame prop change with a WHOLE-frame transform
   *  (e.g. slides' layout→'blocks' conversion). Return the replacement frame,
   *  or null/undefined for the default single-field set. One undo step. */
  transformOnPropChange?: (frame: F, name: string, value: unknown) => F | null | undefined;
  /** The doc key holding the frame array ('screens' | 'slides' | 'pages' | …). */
  key: string;
  /** The single-home flag field, when the type has one (e.g. 'isInitial'). */
  homeFlag?: string;
  max: number;
  /** Fixed-schema frame editing (ADR 0310 Phase B): when the type has NO tree
   *  trait, the property panel binds to the ACTIVE FRAME and edits these fields
   *  (top-level frame keys). A function of the frame so the field set can
   *  follow a discriminator (slides: the `layout`). */
  propDefs?: (frame: F) => CanvasPropDef[];
}

export interface TreeTraitDef<N extends TreeNodeBase, F extends FrameBase> {
  /** ADR 0362 Phase 4 — which SERVED-catalog props are quick (bar cluster),
   *  keyed by node type. FE definition data: the served `ComponentPropDef`
   *  never grows the marker (wire-relevant — the ADR's Wire/RFC ruling). */
  quickPropsByType?: Record<string, string[]>;
  ops: TreeOps<N, F>;
  /** The frame key holding the root node list (app-builder: 'components'). */
  rootKey: string;
  childrenKey: string;
}

/** One flat element collection (ADR 0310 Phase C — the `elements` trait):
 *  drawing `shapes`, cad `solids`, campaign `channels`/`funnel`/`assets`.
 *  A type declares one or more; the editor shows a section per collection
 *  (title from the type ns: `col_<key>`) with per-kind adders (`add_<id>`).
 *  Elements are positional — no identity fields; the working copy stays a
 *  pure mirror of the artifact schema. */
export interface ElementsCollectionDef {
  /** The doc key holding the element array. */
  key: string;
  /** Display label as DATA (pack-defined types, ADR 0310 Phase D). Typed
   *  first-party types omit it and localize via the type ns `col_<key>`. */
  label?: string;
  max: number;
  /** Schema minItems — the delete guard (drawing shapes: 1). */
  min?: number;
  /** The add menu: one entry per element kind, with its default fields.
   *  `label` as data for pack types; typed types localize via `add_<id>`. */
  adders: { id: string; label?: string; make: () => Record<string, unknown> }[];
  /** Row label for the element list (receives the TYPE-namespace t). */
  labelFor: (el: Record<string, unknown>, t: (k: string, o?: Record<string, unknown>) => string) => string;
  /** Per-element property fields (may follow a `kind` discriminator). */
  propDefs: (el: Record<string, unknown>) => CanvasPropDef[];
  /**
   * CAD-G4 — intercept an element prop change with a WHOLE-element transform,
   * the same seam the FRAMES trait has had since ADR 0328 P3 (slides' layout →
   * 'blocks' conversion). One undo step, same as a plain field set.
   *
   * Needed whenever `propDefs` hides a field on a discriminator: the hidden
   * value stays in the document, and a validator that rejects it (cad:
   * "tolA/tolB require a tolType") then fails a save the user cannot see the
   * cause of. Return the replacement element, or null/undefined for the default
   * single-field set.
   */
  transformOnPropChange?: (el: Record<string, unknown>, name: string, value: unknown) => Record<string, unknown> | null | undefined;
  /** The element's axis-aligned bounding box in CANVAS units (ADR 0333
   *  Phase 2). Powers overlap-aware z-order stepping (`reorderElements`) and
   *  the viewport's zoom-to-selection; omit for non-spatial collections
   *  (campaign channels) — reorder then steps plain-adjacent. */
  bboxFor?: (el: Record<string, unknown>) => { x: number; y: number; w: number; h: number } | null;
  /** Element fields remembered per KIND after each add/edit and merged over the
   *  adder's defaults on the next add — tldraw-style "the last style becomes
   *  the default" (ADR 0333 Phase 2). Session-ephemeral by design. */
  styleKeys?: string[];
  /** ADR 0333 Phase 3 — element chrome: the chassis list renders lock/hide
   *  toggles + `name` labels, and the GESTURE mutation seams (patchElement/
   *  patchElements/deleteElements) skip locked elements. Enable ONLY when the
   *  backend validator accepts `name`/`locked`/`hidden`/`groupId` on this
   *  collection's elements (drawings: yes; CAD: after its mirror — recorded). */
  chrome?: boolean;
  /** ADR 0333 Phase 5 — translate an element by (dx, dy) as a field patch.
   *  Geometry is TYPE-owned (the chassis never guesses field names); with
   *  `bboxFor` this powers the chassis align/distribute over a
   *  multi-selection (one `patchElements` batch). */
  movePatchFor?: (el: Record<string, unknown>, dx: number, dy: number) => Record<string, unknown>;
}

/** A tool a canvas type contributes to the chassis toolbar (ADR 0333 Phase 2 —
 *  MINIMAL seam: identity + presentation; the chassis owns the active-tool
 *  state machine and Esc-to-select). The pointer-gesture-session API ships
 *  with the first pointer tool (Phase 3's pen — the proving-phase rule).
 *  `select` is implicit and always first; adders remain the permanent
 *  keyboard/a11y creation path (WCAG 2.5.7). */
export interface CanvasToolDef {
  id: string;
  /** Icon element factory (from ui/icons). */
  icon: () => JSX.Element;
  /** i18n key in the TYPE namespace for the tool's name. */
  labelKey: string;
}

/** A node as the graph surface sees it (ADR 0323). Position may be absent in the
 *  doc; the surface auto-lays-out placed-less nodes for display until moved. */
export interface GraphNodeView {
  id: string;
  x?: number;
  y?: number;
  /** Device-frame size; omit to use the trait's `nodeSize`. */
  w?: number;
  h?: number;
  label: string;
  /** The home/initial node gets a distinguishing badge. */
  isHome?: boolean;
  /** Opaque per-node payload the trait carries through to `renderNode` (the
   *  surface only sees the light view). app-builder passes the screen + theme. */
  data?: unknown;
}

/** An edge as the graph surface sees it (ADR 0323). */
export interface GraphEdgeView {
  id: string;
  from: string;
  to: string;
  sourceEdge?: GraphEdgeSide;
  targetEdge?: GraphEdgeSide;
  routing?: GraphRouting;
  animated?: boolean;
  label?: string;
  /** Opaque per-edge payload (the raw connector) — the edge property panel reads
   *  field values from it (audit gap #1; symmetric to GraphNodeView.data). */
  data?: unknown;
}

/** The `graph` trait (ADR 0323) — a canvas type whose document is a set of
 *  positioned nodes connected by edges, edited on a pan/zoom surface. Reused by
 *  app-builder (a node is a screen) and, later, the workflow builder. The chassis
 *  owns pan/zoom, selection, keyboard, and routes every mutation through history;
 *  the trait only projects the doc into nodes/edges and applies mutations to a
 *  cloned doc. All mutators receive a CLONE and mutate in place (the chassis
 *  commits it as one undo step). */
/** §7.3 / CV-11 — ONE device abstraction (the ADR 0337 GraphDeviceFrame and
 *  the preview DevicePreset merged): `width` 0 = responsive/full (preview
 *  semantics); a `height` makes it usable as a FIXED board frame. A list may
 *  serve both surfaces — the board filters to entries with a height. */
export interface DeviceFrame {
  id: string;
  /** Board <select> text; the preview page labels via i18n keys. */
  label?: string;
  width: number;
  height?: number;
}
/** Back-compat alias (CV-11) — the board requires height at the use site. */
export type GraphDeviceFrame = DeviceFrame & { height: number };

export interface GraphTraitDef<Doc extends object> {
  /** ADR 0337 — open the editor in the GRAPH (screen-flow board) view by
   *  default rather than the tree/frame editor. The board is the type's
   *  primary surface (app-builder: screens are the unit of work). Absent =
   *  tree-first (the historical default). */
  defaultView?: 'graph';
  /** Project the doc into graph nodes (positions optional → auto-layout). */
  nodes: (doc: Doc) => GraphNodeView[];
  /** Project the doc into edges. */
  edges: (doc: Doc) => GraphEdgeView[];
  /** Default device-frame node size when a node omits w/h. */
  nodeSize: { w: number; h: number };
  /** ADR 0337 P2b — the board's device-frame vocabulary. The chassis renders a
   *  selector; the active frame OVERRIDES `nodeSize` at RENDER time only
   *  (ephemeral board view-state, never persisted — stored node positions stay
   *  device-independent). Distinct from `preview.devicePresets` (a responsive
   *  max-WIDTH for the flowing preview page) — this is a fixed w×h screen
   *  canvas. Absent = the fixed `nodeSize` (no selector). */
  deviceFrames?: readonly GraphDeviceFrame[];
  /** The `deviceFrames` id selected on open (default = the first frame). */
  defaultDevice?: string;
  /** Set node `id`'s position on a cloned doc (a drag/nudge). */
  moveNode: (doc: Doc, id: string, x: number, y: number) => void;
  /** Create an edge from→to on a cloned doc. Return false to reject (dup/self/…);
   *  the edge may omit source/target edges — the surface auto-routes.
   *  OPTIONAL (ADR 0360 grade pass): a graph whose edges DERIVE (the campaign
   *  chain) omits it — the surface then renders NO connect affordances
   *  (an always-failing gesture is dishonest chrome). */
  connect?: (doc: Doc, from: string, to: string) => boolean;
  /** Delete edge `id` on a cloned doc. OPTIONAL — absent = derived edges;
   *  the surface hides edge-delete affordances + announcements. */
  deleteEdge?: (doc: Doc, id: string) => void;
  /** Render a node's body (device frame + live preview of its content). */
  renderNode: (node: GraphNodeView, ctx: { selected: boolean }) => ReactNode;
  /** Activate a node (double-click / Enter) — e.g. open its component editor. */
  onActivateNode?: (id: string) => void;
  /** Optional grid snap for positions (0/absent = free). */
  gridSnap?: number;
  /** Audit gap #1 — the selected edge's property fields (one static list;
   *  connectors have one shape). Values are read from `GraphEdgeView.data`;
   *  the panel writes via `updateEdge`. Absent ⇒ edges are not field-editable. */
  edgePropDefs?: CanvasPropDef[];
  /** Merge `patch` onto edge `id` on a cloned doc. An `undefined` value DELETES
   *  the key (clearing an optional field), never stores undefined. */
  updateEdge?: (doc: Doc, id: string, patch: Record<string, unknown>) => void;
  /** Audit gap #2 — create a new node pre-connected from `fromId` (positioned
   *  beside it), returning the new node id, or null when rejected (e.g. the
   *  frame cap). The trait owns id/name semantics (reuse the frames factory). */
  /** Spawn a node pre-connected from `fromId`. `pos` (canvas coords) is the
   *  §7.4/CV-10 link-drag-CREATE drop point — absent (keyboard/button path)
   *  the implementation places at its own offset. Returns the new id. */
  addConnectedNode?: (doc: Doc, fromId: string, name: string, pos?: { x: number; y: number }) => string | null;
  /** ADR 0360 — bridge a board-node selection to an ELEMENTS selection so the
   *  existing element property panel (props + arrange + chrome) edits the
   *  node. For positional collections the node id encodes the index. Absent =
   *  node selection is graph-local (the app-builder frames model). */
  elementForNode?: (id: string) => { col: string; idx: number } | null;
}

export interface CanvasTypeDefinition<
  Doc extends object,
  F extends FrameBase = FrameBase,
  N extends TreeNodeBase = CanvasNode,
> {
  canvasTypeId: `canvas.${string}`;
  toggleId: string;
  /** ADR 0510 §9 (DSA-027) — the DECLARED touch-device capability level. A
   *  type advertises only what it honors: 'view' (read/inspect), 'present'
   *  (view + presentation flows), 'light-edit' (touch gestures cover common
   *  edits — e.g. ink, move, pinch-zoom), 'full' (authoring parity).
   *  Omitted = 'view' (fail-honest). The editor surfaces the level in its
   *  small-screen notice, so no canvas implies parity it lacks. */
  touchSupport?: 'view' | 'present' | 'light-edit' | 'full';
  /** The type's backend route root, e.g. '/host/openwop-app/app-builder'. */
  clientBasePath: string;
  /** The type's SPA route root, e.g. '/app-builder' (editor at `<editorPath>/:canvasId`). */
  editorPath: string;
  /** i18n namespace for the type's own strings (framework strings live in the
   *  'canvas' namespace; see the fixed type-key contract above). */
  i18nNamespace: string;

  /**
   * ADR 0739 — optional PRESENTATION metadata for the shared canvas
   * workbench. This is deliberately CSS/i18n-only: it cannot introduce a
   * canvas persistence, workflow, or state-management model beside the
   * chassis. Types that do not need a specialization simply omit it.
   */
  workbench?: {
    /** A namespaced label for the type's mode strip. */
    workspaceLabelKey?: string;
    /** A type-owned modifier class for genuinely type-specific polish. */
    className?: string;
  };

  /** ONE renderer, all mounts (chat card, editor preview, shared view). Edit
   *  mode stamps `data-cv-path` / `data-cv-nav` on rendered nodes. */
  Renderer: ComponentType<{ content: string; editPaths?: boolean }>;

  /** RFC 0130 (ADR 0310 Phase E): a LIVE preview panel that replaces the
   *  Renderer in the editor's center — receives the edited document, the
   *  current selection, and the editor's live-region sink. Pack types mount
   *  the sandboxed `canvas-preview` plugin frame through this seam. */
  PreviewPanel?: ComponentType<{
    content: string;
    selection: CanvasSelectionInfo | null;
    onAnnounce: (message: string, politeness?: 'polite' | 'assertive') => void;
  }>;

  /** ADR 0310 Phase C follow-up (research §5.5): an ELEMENTS-trait type MAY
   *  supply a DIRECT-MANIPULATION preview that replaces the read-only Renderer
   *  in the editor center — click-select + drag on the rendered scene, driving
   *  selection + element patches through the chassis history. Absent ⇒ the
   *  read-only Renderer. `PreviewPanel` (pack plugin frame) takes precedence. */
  InteractivePreview?: ComponentType<InteractivePreviewProps<Doc>>;

  /** ADR 0334 — a FULL editor center panel (generalizes `InteractivePreview`
   *  beyond the elements trait). A canvas type whose document is a linear rich
   *  flow supplies its own editor engine here; the chassis owns save/version/
   *  dirty, the EditorSurface owns intra-document selection + undo/redo.
   *  Center-panel precedence: graph → EditorSurface → PreviewPanel →
   *  InteractivePreview → Renderer. */
  EditorSurface?: EditorSurface<Doc>;

  /** ADR 0359 D2 — real-time collaboration opt-in. When set (and the
   *  `realtime-collab` + this type's own toggles are BOTH on for the tenant),
   *  the chassis provisions the collab session (resolve-once gate → `useCollab`
   *  → seeder election → CAS-save suppression) and passes it down via
   *  `EditorSurfaceProps.collab`. `'document'` = the surface binds its own
   *  engine (y-prosemirror); `'elements'` = the chassis element binding
   *  (Phase 3). MUST mirror the backend registration
   *  (`registerCanvasEditorRoutes` cfg `collab: true`) — the socket 404s an
   *  unregistered type. Absent ⇒ solo single-writer, byte-identical behavior. */
  collab?: 'document' | 'elements';

  /** Narrow the opaque canvas `state` into the editable doc shape with safe
   *  fallbacks — never launder through `as unknown as`. */
  coerceDoc: (state: Record<string, unknown>) => Doc;

  /** The doc key holding the display name the toolbar edits (default 'name';
   *  slides: 'title'). */
  docNameKey?: string;

  frames?: FramesTraitDef<Doc, F>;
  /** ADR 0328 P3 — gate tree editing per-FRAME (slides: only 'blocks' slides
   *  use the palette/outline; legacy slides keep the form panel). Absent = all. */
  treeEnabledFor?: (frame: FrameBase) => boolean;
  /** ADR 0328 P4 — present mode (the chassis `CanvasPresentPage`): render ONE
   *  frame full-screen for the AUDIENCE. Notes are never passed here — the
   *  notes leak is fixed by construction (the presenter window reads them via
   *  `notesKey`). Frames come from the `frames` trait's array. */
  present?: {
    /** `visibleSteps` (ADR 0328 P5) caps how many build steps render — the
     *  audience path again receives only what it should SEE right now. */
    renderFrame: (doc: Record<string, unknown>, index: number, visibleSteps?: number) => JSX.Element | null;
    /** Frame field holding speaker notes (presenter window only; default 'notes'). */
    notesKey?: string;
    /** Frame field marking a frame skipped in present mode (default 'skip'). */
    skipKey?: string;
    /** ADR 0328 P5 — the ENTRY transition for a frame ('none'|'fade'|'magic';
     *  'magic' FLIP-matches [data-mm] content keys). Absent = none. */
    transitionOf?: (doc: Record<string, unknown>, index: number) => string | undefined;
    /** ADR 0328 P5 — build steps for a frame (0 = shows whole). */
    buildStepsOf?: (doc: Record<string, unknown>, index: number) => number;
    /** ADR 0328 P7 — a frame that STARTS a section returns its name; the
     *  present jump grid groups under it (derived — no schema field). */
    sectionOf?: (doc: Record<string, unknown>, index: number) => string | undefined;
  };
  tree?: TreeTraitDef<N, F>;
  elements?: ElementsCollectionDef[];
  /** ADR 0334 — a linear rich-text/prose document (fits none of frames/tree/
   *  elements/graph). Carries no editable schema; only projects the doc (e.g.
   *  headings → the outline pane). Pairs with an `EditorSurface`. */
  flow?: FlowTraitDef<Doc>;
  /** ADR 0323 — a node-graph / screen-flow surface (nodes at positions +
   *  connectors). When present, the editor offers a graph view alongside the
   *  frame/tree editing. */
  graph?: GraphTraitDef<Doc>;

  /** ADR 0333 Phase 2 — tools the type contributes to the chassis toolbar
   *  (`select` is implicit and always first; the chassis owns the active-tool
   *  state + Esc-to-select and passes `activeTool` to the interactive canvas). */
  tools?: CanvasToolDef[];
  /** ADR 0333 Phase 2 — extra keyboard shortcuts merged UNDER the chassis
   *  defaults (a colliding or reserved combo is dropped with a dev warning;
   *  see `canvas/shortcuts.ts`). `labelKey` for `group:'type'` entries
   *  resolves in the TYPE namespace. */
  shortcuts?: import('./shortcuts.js').ShortcutDef[];
  /** ADR 0333 Phase 3 — undo depth override (default 30). Stroke-heavy types
   *  want more (drawings: 200); memory stays bounded (snapshot per GESTURE,
   *  not per event). */
  historyDepth?: number;

  /** Doc-level fields edited in the property panel when nothing is selected
   *  (drawing width/height, cad units, campaign objective/audience). The
   *  toolbar's name field (`docNameKey`) should NOT repeat here. */
  docPropDefs?: CanvasPropDef[];

  /** ADR 0347 5a — instantiate a pack kit's content into the document (the
   *  TYPE owns id remapping + its relations vocabulary; the chassis owns the
   *  gallery + variable form + the single history commit). Returning `false`
   *  (grade pass AB-CODE-F4) means the TYPE rejected the insert (e.g. a frame
   *  cap) and left the doc untouched — the chassis skips the commit and
   *  announces the rejection. A `void` return keeps older types conformant. */
  insertKit?: (doc: Doc, kit: { screens: Record<string, unknown>[]; connectors?: Record<string, unknown>[] }) => boolean | void;

  /** ADR 0345 3d — type-contributed WORKSPACE TABS: alternate center surfaces
   *  beside the design editor (app-builder: the Data tab). The chassis owns
   *  the switcher + history integration (commitDoc = one undo step); the tab
   *  owns its own UI over the document facets. */
  workspaceTabs?: WorkspaceTabDef[];

  /** Version-history change summary (receives the TYPE-namespace t). May
   *  return plain lines, or a structured `VersionDiff` (ADR 0344 2d) whose
   *  entries render as a kind-tagged navigable list in the History modal. */
  summarizeVersions?: (snapshot: Doc, current: Doc, t: (k: string, o?: Record<string, unknown>) => string) => VersionSummary;
  /** Property widgets keyed by `CanvasPropDef.type` — consulted before the
   *  built-ins (string/number/boolean/enum/longtext/color). */
  propertyWidgets?: Record<string, PropertyWidget>;
  /** Type-contributed toolbar slot rendered after Save (export, publish, …). */
  ToolbarExtras?: ComponentType<ToolbarExtrasProps>;

  preview?: {
    devicePresets: readonly DevicePreset[];
    /** Show the doc/light/dark theme override select. */
    themeOverride?: boolean;
    /** Audit gap #4 — the transition to play when tap-navigating from one frame
     *  to another (app-builder: the matching connector's `transition`). Returns
     *  one of push|replace|modal|fade|slide|none (or undefined = none). The
     *  viewer plays it as a brief CSS animation, disabled under
     *  prefers-reduced-motion. */
    transitionFor?: (doc: Record<string, unknown>, fromId: string, toId: string) => string | undefined;
    /** ADR 0345 3b — the type's action/state semantics for the interactive
     *  preview (and the public share). Absent = plain tap-through. */
    runtime?: PreviewRuntime;
  };
  /** Public share-link minting. The framework owns the button/announce UX; the
   *  TYPE supplies the mint (its feature layer imports the sharing client —
   *  `canvas/` never imports `features/*`). Returns the public URL. */
  share?: {
    resourceType: string;
    mint: (orgId: string, args: { resourceId: string; label?: string }) => Promise<string>;
    /** ADR 0345 3a — an i18n key (TYPE namespace) shown as a confirm before
     *  minting: what the public page will and will not disclose. */
    disclosureKey?: string;
  };
}
