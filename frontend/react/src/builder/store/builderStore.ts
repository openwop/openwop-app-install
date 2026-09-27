/**
 * Builder state. One zustand store per BuilderTab mount.
 *
 * Holds the graph (nodes/edges), the currently selected node, and a
 * fixed-depth snapshot stack for undo/redo. Persists the active
 * workflow's nodes/edges to localStorage on every change (debounced
 * implicitly by react batching).
 *
 * v1 undo strategy: deep-copy snapshots of {nodes, edges} on every
 * mutation, capped at HISTORY_MAX. Cheap at <100 nodes; revisit if
 * users hit the cap.
 */

import { create } from 'zustand';
import type { RunEventDoc } from '@openwop/openwop';
import type { BuilderEdge, BuilderNode, SavedWorkflow } from '../schema/workflow.js';
import { catalogEntry, defaultConfigFor } from '../palette/catalogRegistry.js';
import { upsertSavedWorkflow } from '../persistence/localStore.js';
import { saveWorkflow as saveBackendWorkflow } from '../persistence/backendStore.js';
import { SyncFailureError } from '../../client/config.js';

// ADR 0163 Phase 3 — write-through to the backend ownership index, DEBOUNCED so
// canvas edits don't POST on every keystroke. localStorage stays the immediate
// (synchronous) write; the backend sync trails the last edit by ~1.5s.
//
// ADR 0434 Phase 1 — the autosave OUTCOME is now recorded. `saveWorkflow` used
// to swallow every backend failure, so a 401/429 left the workflow in this
// browser alone while the canvas looked saved; the user learned about it on a
// different machine, as missing work. The write still cannot be made to
// succeed offline — but it can stop LYING about it, which is the whole fix.
let backendSyncTimer: ReturnType<typeof setTimeout> | undefined;
/** ADR 0474 (review M4) — a pending debounced autosave firing AFTER a
 *  restore/import reload would silently overwrite the just-loaded head with
 *  the pre-reload snapshot. `loadFromSaved` cancels it. */
export function cancelPendingBackendSync(): void {
  if (backendSyncTimer) { clearTimeout(backendSyncTimer); backendSyncTimer = undefined; }
}
function scheduleBackendSync(wf: SavedWorkflow): void {
  // ADR 0481 §4 — while a collab room is live it is the head's ONLY writer
  // (REST saves return 409 workflow_room_live): the debounced autosave
  // short-circuits; leaving the session triggers the one catch-up sync.
  if (useBuilderStore.getState().collabLive) return;
  if (backendSyncTimer) clearTimeout(backendSyncTimer);
  backendSyncTimer = setTimeout(() => {
    void (async () => {
      try {
        const outcome = await saveBackendWorkflow(wf);
        // Grade-pass (UX): resolve ids to the LABELS the author saw on canvas.
        // Node ids are `n_<8 hex>` — opaque tokens a user has never seen, for a
        // node that is now deleted and so can't be looked up. `wf` is the
        // pre-save snapshot, which still contains the removed node.
        const labelById = new Map(wf.nodes.map((n) => [n.id, n.name]));
        useBuilderStore.setState({
          syncState: 'synced',
          removedReferencedNodeIds: (outcome.removedReferencedNodeIds ?? []).map((id) => labelById.get(id) ?? id),
        });
      } catch (err) {
        // A REFUSED write (offline is swallowed inside saveWorkflow and resolves).
        // Never rethrow from a timer — that is an unhandled rejection, which is
        // just a louder way to lose the signal.
        useBuilderStore.setState({
          syncState: 'failed',
          // Grade-pass: the save did NOT land, so a "steps were removed"
          // notice would contradict the failure banner directly above it.
          removedReferencedNodeIds: [],
          // Conditional spread, not an explicit `undefined` — the project runs
          // `exactOptionalPropertyTypes`.
          ...(err instanceof SyncFailureError
            ? { syncFailureStatus: err.status, syncFailureReason: err.reason }
            : {}),
        });
      }
    })();
  }, 1500);
}
import i18n from '../../i18n/index.js';
import { isInterruptResolvedEvent } from '../../chat/lib/interruptResolvedEvent';

const HISTORY_MAX = 30;

/**
 * One clipboard/paste entry: a WHOLE node minus the two things paste mints
 * itself — `id`, and `position` (replaced by the group-relative `dx`/`dy`).
 *
 * H37 — this used to be an inline structural type enumerating
 * `kind/name/config/inputs`, duplicated in `nodeClipboard.ts`. Two lists of
 * field names, neither of which knew about `outputRole` (RFC 0065 / ADR 0440
 * P1), so copy/paste dropped it. Derived from `BuilderNode` and declared ONCE
 * so the next field is covered by construction.
 */
export type PasteNodeEntry = Omit<BuilderNode, 'id' | 'position'> & { dx: number; dy: number };

/**
 * Compile-time ratchet for the line above. `PasteNodeEntry` being an `Omit`
 * today is not the guarantee — somebody re-narrowing it to a hand-written list
 * is exactly the regression, and it would be SILENT: `copySelection` builds
 * entries by spreading a node, and a wider object is freely assignable to a
 * narrower parameter type, so `tsc` and every runtime test stay green while
 * the declared contract quietly stops covering the node. MEASURED: restoring
 * the narrow inline type left `tsc --noEmit` at exit 0 and all 8 behavioural
 * tests passing. This fails the build instead, naming the uncovered field.
 */
type _UncoveredNodeFields = Exclude<keyof Omit<BuilderNode, 'id' | 'position'>, keyof PasteNodeEntry>;
const _pasteEntryCoversEveryNodeField: [_UncoveredNodeFields] extends [never] ? true : _UncoveredNodeFields = true;
void _pasteEntryCoversEveryNodeField;

/** Undo/redo scope (DEF-6, deliberate): snapshots cover the GRAPH (nodes +
 *  edges) only. Workflow-level fields — `name`, `defaultInputs`,
 *  `inputSchema` — are text inputs with native per-field editing; putting
 *  every keystroke on the undo stack would bury graph operations. ⌘Z inside
 *  the field is the text-level undo. */
interface Snapshot {
  nodes: BuilderNode[];
  edges: BuilderEdge[];
}

/** Per-node live status painted onto the canvas during a run overlay. */
export type NodeRunStatus = 'running' | 'completed' | 'failed' | 'suspended';

/** Terminal status of the overlaid run itself, for the canvas banner. */
export type OverlayRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** §7.9 canon / CV-17 — per-node run detail for the run drawer: counts stay
 *  on nodes (nodeStatus), payloads live in the drawer. */
export interface NodeRunDetail {
  status: NodeRunStatus;
  /** Wire timestamp of the latest transition. */
  at: string;
  /** The latest terminal node event's payload (node.completed output /
   *  node.failed error envelope) — rendered in the drawer, never on canvas. */
  payload?: unknown;
}

export interface RunOverlay {
  runId: string;
  /** Backend node.nodeId → builder BuilderNode.id, from serializeWithIdMap. */
  backendIdToBuilder: Record<string, string>;
  /** builder BuilderNode.id → live status. */
  nodeStatus: Record<string, NodeRunStatus>;
  /** builder BuilderNode.id → drawer detail (CV-17; additive beside
   *  nodeStatus so the canvas paint path is untouched). */
  nodeDetail: Record<string, NodeRunDetail>;
  runStatus: OverlayRunStatus;
}

/** ADR 0481 D5 — one live-session peer as the canvas sees it: identity +
 *  which nodes they have selected. `color` is a design-token `var(--…)`
 *  reference (never a raw literal — the tsx-color-literals gate). */
export interface CollabPeerMarker {
  clientId: number;
  name: string;
  color: string;
  selectedNodeIds: string[];
}

/** ADR 0475 — one debug pin as the BUILDER sees it: keyed by builder node id
 *  (the canvas/inspector space), carrying the backend node id for the API. */
export interface DebugPinEntry {
  backendNodeId: string;
  output: Record<string, unknown>;
  sourceRunId?: string;
}

/** ADR 0475 — the builder's debug session: draft-side pinned node outputs.
 *  Ephemeral in the store (the pins themselves persist server-side); never
 *  snapshotted (undo/redo) or written to localStorage. */
export interface DebugSession {
  /** builder BuilderNode.id → pin. */
  pins: Record<string, DebugPinEntry>;
  /** The failed run this session was prefetched from, when it was. */
  sourceRunId?: string;
}

export interface BuilderState {
  workflowId: string;
  name: string;
  defaultInputs: string;
  /** RFC 0124 variable declarations + bare-param aliases, carried VERBATIM.
   *  Not builder-edited — but the store is on the path between load and save,
   *  so omitting them here drops them on every autosave, Run and export.
   *  `snapshot()`'s own comment records the same class being fixed once already
   *  for `lifecycle`/`metadata`; this is the third recurrence in this function. */
  variables?: unknown;
  configurableSchema?: unknown;
  /** Raw JSON string for `definition.inputSchema` (ADR 0197); '' = none.
   *  Kept as the author typed it — serialize publishes it only once it
   *  parses to an object, so a half-typed draft never clobbers a run. */
  inputSchema: string;
  nodes: BuilderNode[];
  edges: BuilderEdge[];
  /** The "primary" selected node — drives the single-node Inspector
   *  editor. Non-null only when exactly one node is selected. */
  selectedNodeId: string | null;
  /** Full multi-selection set (box-select / shift-click). Group ops
   *  (delete / duplicate / align) act on this. */
  selectedNodeIds: string[];
  selectedEdgeId: string | null;
  past: Snapshot[];
  future: Snapshot[];

  /** Live run overlay. Null when no run is being watched. Ephemeral —
   *  never snapshotted (undo/redo) or persisted to localStorage. */
  overlay: RunOverlay | null;
  /** ADR 0475 — the debug session (pinned node outputs). Null when none. */
  debugSession: DebugSession | null;
  /** ADR 0476 — failure-heatmap counts (builder node id → failed-run count in
   *  the stats window). Null when the heatmap is off. Ephemeral.
   *  ADR 0482 §6 — the SAME slice carries the cost heatmap: `failureHeatMode`
   *  says what the numbers mean ('failures' = counts over the stats window;
   *  'cost' = the LATEST terminal run's per-node USD from its costByNode stamp). */
  failureHeat: Record<string, number> | null;
  failureHeatMode: 'failures' | 'cost';
  /** ADR 0481 §4 — true while a multiplayer room owns this workflow's head:
   *  the debounced backend autosave is SUSPENDED (the room's derive writes
   *  the head). Ephemeral — never snapshotted or persisted. */
  collabLive: boolean;
  /** ADR 0481 D5 — peers in the live session (toolbar chip + node markers).
   *  Null when no session. Ephemeral. */
  collabPeers: CollabPeerMarker[] | null;
  /** ADR 0369 — the loaded workflow's lifecycle (transient = unpromoted draft). */
  lifecycle: SavedWorkflow['lifecycle'];
  /** ADR 0440 P1 — the loaded definition's metadata, carried VERBATIM through
   *  load→persist for the same reason `lifecycle` is: the debounced autosave
   *  rewrites the whole definition, so any key the store drops is ERASED. This
   *  held `walkthrough: true`, whose loss silently un-registered a walkthrough
   *  from `ctx.features.walkthroughs.listWalkthroughs`. Builder-owned keys
   *  (`name`, `lifecycle`) are NOT here — they overlay on save. */
  metadata: SavedWorkflow['metadata'];
  /** ADR 0440 P2 — the steps this save dropped that a RUN actually recorded,
   *  as the LABELS the author saw on canvas (resolved from the pre-save
   *  snapshot; falls back to the raw id if the node is somehow absent). The
   *  write is allowed — refusing it would make deleting a node from a workflow
   *  that has ever run impossible — so the author is told instead, because
   *  those runs' recorded outcomes no longer map on `:fork`. */
  removedReferencedNodeIds: string[];
  /** ADR 0434 — outcome of the last debounced backend autosave.
   *  `'synced'` the server confirmed it · `'failed'` the server REFUSED it
   *  (the edit exists only in this browser) · `'pending'` nothing saved yet.
   *  Offline is deliberately NOT `'failed'`: the local cache is authoritative
   *  then and the next save reconciles. */
  syncState: 'pending' | 'synced' | 'failed';
  /** HTTP status behind a `'failed'` sync, so the UI can distinguish
   *  "sign in again" (401/403) from "slow down" (429) from a server fault. */
  syncFailureStatus?: number;
  /** Domain reason behind a `'failed'` sync (the ADR 0143 error envelope's
   *  `details.reason`, threaded through `SyncFailureError.reason`) — lets the
   *  banner branch a 409 `workflow_room_live` (a state, not a fault) away
   *  from genuine refusals. Explicit `| undefined` so a reason-less failure
   *  CLEARS a stale one under `exactOptionalPropertyTypes`. */
  syncFailureReason?: string | undefined;

  loadFromSaved(wf: SavedWorkflow): void;
  setName(name: string): void;
  setDefaultInputs(value: string): void;
  setInputSchema(value: string): void;
  selectNode(id: string | null): void;
  /** Replace the multi-selection set (derived from xyflow's applied
   *  selection). Sets `selectedNodeId` to the sole member when exactly
   *  one is selected, else null. */
  setSelection(ids: string[]): void;
  /** E.1 — a canvas-side "Connect…" affordance asks the Inspector's
   *  NodeConnections section to scroll into view + take focus. Monotonic
   *  nonce; 0 = never requested. */
  connectionsFocusRequest: number;
  requestConnectionsFocus(): void;
  /** Keyboard node-search-and-place (UX_UPGRADE-workflows-builder P2, the n8n
   *  Tab-to-search parity): the '/' shortcut asks the palette to focus its
   *  search input. Same monotonic-nonce pattern as connectionsFocusRequest. */
  paletteSearchFocusRequest: number;
  requestPaletteSearchFocus(): void;
  selectEdge(id: string | null): void;
  addNode(kind: string, position: { x: number; y: number }): string;
  /** Drop-picker create (§7 one-gesture-one-step): the node AND its
   *  pre-wired edge land as ONE undo entry — a single undo removes both.
   *  Two separate addNode+addEdge calls cost two ⌘Z (the CT-CV-3 finding). */
  addConnectedNode(kind: string, position: { x: number; y: number }, from: { source: string; sourcePort: string; targetPort: string }): string;
  /** Duplicate every node in `ids` at a +offset; selects the clones. */
  cloneNodes(ids: string[]): void;
  /** Paste clipboard entries (a WHOLE node minus the two things paste must
   *  mint itself — `id` and `position` — plus dx/dy from the group's top-left)
   *  anchored at `anchor`; selects the pasted nodes. One undo entry.
   *
   *  H37: the entry type used to enumerate `kind/name/config/inputs`, so paste
   *  could not carry a field the list did not name even when copy had it.
   *  Deriving it from `BuilderNode` means a new node field is carried by
   *  construction — and, because `Omit` keeps optional fields optional, a
   *  clipboard entry captured by an older build still satisfies it. */
  pasteNodes(entries: PasteNodeEntry[], anchor: { x: number; y: number }): void;
  /** Align / distribute the selected nodes by their top-left positions
   *  (no measured dimensions needed): left edges, top edges, or even
   *  horizontal / vertical spacing. One undo entry. */
  alignNodes(ids: string[], mode: 'left' | 'top' | 'distribute-h' | 'distribute-v'): void;
  updateNode(id: string, patch: Partial<Pick<BuilderNode, 'name' | 'position' | 'config' | 'inputs' | 'outputRole'>>): void;
  /** Commit final positions for several nodes in one undo entry — used for
   *  group drag so one gesture is one undo. */
  moveNodes(moves: { id: string; position: { x: number; y: number } }[]): void;
  removeNode(id: string): void;
  /** Remove several nodes (and their incident edges) in one undo entry. */
  removeNodes(ids: string[]): void;
  addEdge(edge: Omit<BuilderEdge, 'id'>): void;
  updateEdge(id: string, patch: Partial<Omit<BuilderEdge, 'id' | 'source' | 'target' | 'sourcePort' | 'targetPort'>>): void;
  removeEdge(id: string): void;
  undo(): void;
  redo(): void;
  snapshot(): SavedWorkflow;
  persist(): void;
  /** ADR 0369 — set on a promoted draft: drops `transient` locally so the
   *  next autosave echoes the promoted lifecycle. */
  clearTransient(): void;

  /** Begin painting a run onto the canvas. Resets any prior overlay. */
  startOverlay(runId: string, backendIdToBuilder: Record<string, string>): void;
  /** Fold a single run event into the overlay's per-node status. */
  applyRunEvent(ev: RunEventDoc): void;
  /** Clear the overlay (run finished + user dismissed, or new edit). */
  clearOverlay(): void;

  /** ADR 0475 — replace the whole debug session (load / prefill / clear). */
  setDebugSession(session: DebugSession | null): void;
  /** ADR 0475 — upsert one pin (keyed by builder node id). */
  setDebugPin(builderNodeId: string, pin: DebugPinEntry): void;
  /** ADR 0475 — remove one pin; clears the session when it was the last. */
  removeDebugPin(builderNodeId: string): void;
  /** ADR 0476 — set/clear the heatmap values (ADR 0482: `mode` labels them;
   *  defaults to 'failures' so existing callers are unchanged). */
  setFailureHeat(heat: Record<string, number> | null, mode?: 'failures' | 'cost'): void;
  /** ADR 0481 — suspend/resume the backend autosave for a live room. */
  setCollabLive(live: boolean): void;
  /** ADR 0481 D5 — mirror the awareness peers for the canvas markers. */
  setCollabPeers(peers: CollabPeerMarker[] | null): void;
}

function clone(s: { nodes: BuilderNode[]; edges: BuilderEdge[] }): Snapshot {
  return {
    // `inputs` deep-copied alongside `config` — it was the only node sub-object
    // left shared across history snapshots.
    nodes: s.nodes.map((n) => ({
      ...n,
      position: { ...n.position },
      config: { ...n.config },
      ...(n.inputs ? { inputs: { ...n.inputs } } : {}),
    })),
    edges: s.edges.map((e) => ({ ...e })),
  };
}

export const useBuilderStore = create<BuilderState>((set, get) => ({
  workflowId: '',
  name: i18n.t('builder:untitledWorkflow'),
  defaultInputs: '{}',
  inputSchema: '',
  nodes: [],
  edges: [],
  selectedNodeId: null,
  selectedNodeIds: [],
  selectedEdgeId: null,
  past: [],
  future: [],
  overlay: null,
  debugSession: null,
  failureHeat: null,
  failureHeatMode: 'failures',
  collabLive: false,
  collabPeers: null,
  connectionsFocusRequest: 0,
  paletteSearchFocusRequest: 0,
  lifecycle: undefined,
  metadata: undefined,
  removedReferencedNodeIds: [],
  syncState: 'pending',

  loadFromSaved(wf) {
    cancelPendingBackendSync();
    set({
      workflowId: wf.id,
      name: wf.name,
      lifecycle: wf.lifecycle,
      metadata: wf.metadata,
      // Grade-pass: without this the disclosure follows you to the next
      // workflow and misattributes another workflow's node ids to it.
      removedReferencedNodeIds: [],
      defaultInputs: wf.defaultInputs ?? '{}',
      inputSchema: wf.inputSchema ?? '',
      variables: wf.variables,
      configurableSchema: wf.configurableSchema,
      nodes: wf.nodes.map((n) => ({ ...n, position: { ...n.position }, config: { ...n.config } })),
      edges: wf.edges.map((e) => ({ ...e })),
      selectedNodeId: null,
      selectedNodeIds: [],
      past: [],
      future: [],
      overlay: null,
      // ADR 0475 — pins belong to a workflow; never carry them across loads
      // (BuilderShell re-loads the new workflow's server-side session).
      debugSession: null,
      failureHeat: null,
      failureHeatMode: 'failures',
      // ADR 0481 — a session is per-workflow; the shell tears it down on
      // navigation, this only clears the marker mirror across loads.
      collabPeers: null,
    });
  },

  setName(name) {
    set({ name });
    get().persist();
  },

  setDefaultInputs(value) {
    set({ defaultInputs: value });
    get().persist();
  },

  setInputSchema(value) {
    set({ inputSchema: value });
    get().persist();
  },

  selectNode(id) {
    set({ selectedNodeId: id, selectedNodeIds: id ? [id] : [], selectedEdgeId: null });
  },

  setSelection(ids) {
    set({
      selectedNodeIds: ids,
      selectedNodeId: ids.length === 1 ? ids[0]! : null,
      ...(ids.length > 0 ? { selectedEdgeId: null } : {}),
    });
  },

  requestConnectionsFocus() {
    set({ connectionsFocusRequest: get().connectionsFocusRequest + 1 });
  },

  requestPaletteSearchFocus() {
    set({ paletteSearchFocusRequest: get().paletteSearchFocusRequest + 1 });
  },

  selectEdge(id) {
    set({ selectedEdgeId: id, selectedNodeId: null, selectedNodeIds: [] });
  },

  addNode(kind, position) {
    const entry = catalogEntry(kind);
    if (!entry) return '';
    const id = `n_${crypto.randomUUID().slice(0, 8)}`;
    const node: BuilderNode = {
      id,
      kind: entry.kind,
      name: entry.label,
      position,
      config: defaultConfigFor(kind),
    };
    pushHistory(set, get);
    set({ nodes: [...get().nodes, node], selectedNodeId: id, selectedNodeIds: [id] });
    get().persist();
    return id;
  },

  addConnectedNode(kind, position, from) {
    const entry = catalogEntry(kind);
    if (!entry) return '';
    const id = `n_${crypto.randomUUID().slice(0, 8)}`;
    const node: BuilderNode = {
      id,
      kind: entry.kind,
      name: entry.label,
      position,
      config: defaultConfigFor(kind),
    };
    // No self-loop/duplicate guard needed — the target node is brand new.
    pushHistory(set, get);
    set({
      nodes: [...get().nodes, node],
      edges: [...get().edges, { id: `e_${crypto.randomUUID().slice(0, 8)}`, source: from.source, sourcePort: from.sourcePort, target: id, targetPort: from.targetPort }],
      selectedNodeId: id,
      selectedNodeIds: [id],
    });
    get().persist();
    return id;
  },

  cloneNodes(ids) {
    const set0 = new Set(ids);
    const sources = get().nodes.filter((n) => set0.has(n.id));
    if (sources.length === 0) return;
    const OFFSET = 32;
    const clones: BuilderNode[] = sources.map((s) => ({
      // H37 — carry EVERY field by CONSTRUCTION. This used to enumerate
      // `{id, kind, name, position, config, inputs}`, so a duplicate silently
      // dropped any field the list did not name: `outputRole` (RFC 0065 / ADR
      // 0440 P1) has been lost here since it was added, and every future field
      // would be too. Spread first, override only what MUST differ.
      ...s,
      id: `n_${crypto.randomUUID().slice(0, 8)}`,
      position: { x: s.position.x + OFFSET, y: s.position.y + OFFSET },
      // Re-copy the mutable containers so the clone does not alias the source.
      config: { ...s.config },
      ...(s.inputs ? { inputs: { ...s.inputs } } : {}),
    }));
    pushHistory(set, get);
    const cloneIds = clones.map((c) => c.id);
    set({
      nodes: [...get().nodes, ...clones],
      selectedNodeIds: cloneIds,
      selectedNodeId: cloneIds.length === 1 ? cloneIds[0]! : null,
    });
    get().persist();
  },

  pasteNodes(entries, anchor) {
    if (entries.length === 0) return;
    const clones: BuilderNode[] = entries.map(({ dx, dy, ...rest }) => ({
      // H37 — same construction rule as `cloneNodes` above: spread the
      // clipboard entry (which is now a whole node minus id/position) and
      // override only the id and the anchored position.
      ...rest,
      id: `n_${crypto.randomUUID().slice(0, 8)}`,
      position: { x: anchor.x + dx, y: anchor.y + dy },
      config: { ...rest.config },
      ...(rest.inputs ? { inputs: { ...rest.inputs } } : {}),
    }));
    pushHistory(set, get);
    const cloneIds = clones.map((c) => c.id);
    set({
      nodes: [...get().nodes, ...clones],
      selectedNodeIds: cloneIds,
      selectedNodeId: cloneIds.length === 1 ? cloneIds[0]! : null,
    });
    get().persist();
  },

  alignNodes(ids, mode) {
    const set0 = new Set(ids);
    const sel = get().nodes.filter((n) => set0.has(n.id));
    if (sel.length < 2) return;
    const pos = new Map<string, { x: number; y: number }>();
    if (mode === 'left') {
      const x = Math.min(...sel.map((n) => n.position.x));
      for (const n of sel) pos.set(n.id, { x, y: n.position.y });
    } else if (mode === 'top') {
      const y = Math.min(...sel.map((n) => n.position.y));
      for (const n of sel) pos.set(n.id, { x: n.position.x, y });
    } else if (mode === 'distribute-h') {
      const sorted = [...sel].sort((a, b) => a.position.x - b.position.x);
      const minX = sorted[0]!.position.x;
      const maxX = sorted[sorted.length - 1]!.position.x;
      const step = (maxX - minX) / (sorted.length - 1);
      sorted.forEach((n, i) => pos.set(n.id, { x: minX + step * i, y: n.position.y }));
    } else {
      const sorted = [...sel].sort((a, b) => a.position.y - b.position.y);
      const minY = sorted[0]!.position.y;
      const maxY = sorted[sorted.length - 1]!.position.y;
      const step = (maxY - minY) / (sorted.length - 1);
      sorted.forEach((n, i) => pos.set(n.id, { x: n.position.x, y: minY + step * i }));
    }
    pushHistory(set, get);
    set({ nodes: get().nodes.map((n) => (pos.has(n.id) ? { ...n, position: pos.get(n.id)! } : n)) });
    get().persist();
  },

  updateNode(id, patch) {
    pushHistory(set, get);
    set({
      nodes: get().nodes.map((n) =>
        n.id === id
          ? {
              ...n,
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.position !== undefined ? { position: patch.position } : {}),
              ...(patch.config !== undefined ? { config: patch.config } : {}),
              // `in patch` (not `!== undefined`) so callers can CLEAR
              // the annotation by passing `outputRole: undefined`.
              // `name` / `position` / `config` never get cleared in
              // practice; `outputRole` does (the Inspector's "(none)"
              // option) so it needs the in-check.
              ...('outputRole' in patch ? { outputRole: patch.outputRole } : {}),
              // `in patch` for the same reason as outputRole — a caller must be
              // able to CLEAR preset inputs. Note this allowlist is a SECOND
              // gate beside the `Pick` in the interface above: widening only the
              // type let `inputs` typecheck while this body silently dropped it,
              // which is the very defect ADR 0523 exists to fix, reproduced one
              // layer in. Both must move together.
              ...('inputs' in patch ? { inputs: patch.inputs } : {}),
            }
          : n,
      ),
    });
    get().persist();
  },

  moveNodes(moves) {
    if (moves.length === 0) return;
    const byId = new Map(moves.map((m) => [m.id, m.position]));
    pushHistory(set, get);
    set({
      nodes: get().nodes.map((n) =>
        byId.has(n.id) ? { ...n, position: byId.get(n.id)! } : n,
      ),
    });
    get().persist();
  },

  removeNode(id) {
    pushHistory(set, get);
    set({
      nodes: get().nodes.filter((n) => n.id !== id),
      edges: get().edges.filter((e) => e.source !== id && e.target !== id),
      selectedNodeId: get().selectedNodeId === id ? null : get().selectedNodeId,
      selectedNodeIds: get().selectedNodeIds.filter((x) => x !== id),
    });
    get().persist();
  },

  removeNodes(ids) {
    if (ids.length === 0) return;
    const doomed = new Set(ids);
    pushHistory(set, get);
    set({
      nodes: get().nodes.filter((n) => !doomed.has(n.id)),
      edges: get().edges.filter((e) => !doomed.has(e.source) && !doomed.has(e.target)),
      selectedNodeId:
        get().selectedNodeId && doomed.has(get().selectedNodeId!) ? null : get().selectedNodeId,
      selectedNodeIds: get().selectedNodeIds.filter((x) => !doomed.has(x)),
    });
    get().persist();
  },

  addEdge(edge) {
    // Reject duplicates and self-loops.
    if (edge.source === edge.target) return;
    const exists = get().edges.some(
      (e) =>
        e.source === edge.source &&
        e.target === edge.target &&
        e.sourcePort === edge.sourcePort &&
        e.targetPort === edge.targetPort,
    );
    if (exists) return;
    pushHistory(set, get);
    set({
      edges: [
        ...get().edges,
        { id: `e_${crypto.randomUUID().slice(0, 8)}`, ...edge },
      ],
    });
    get().persist();
  },

  updateEdge(id, patch) {
    pushHistory(set, get);
    set({
      edges: get().edges.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    });
    get().persist();
  },

  removeEdge(id) {
    pushHistory(set, get);
    set({
      edges: get().edges.filter((e) => e.id !== id),
      selectedEdgeId: get().selectedEdgeId === id ? null : get().selectedEdgeId,
    });
    get().persist();
  },

  undo() {
    const past = get().past;
    if (past.length === 0) return;
    const prev = past[past.length - 1]!;
    const current = clone({ nodes: get().nodes, edges: get().edges });
    set({
      nodes: prev.nodes,
      edges: prev.edges,
      past: past.slice(0, -1),
      future: [current, ...get().future].slice(0, HISTORY_MAX),
    });
    get().persist();
  },

  redo() {
    const future = get().future;
    if (future.length === 0) return;
    const next = future[0]!;
    const current = clone({ nodes: get().nodes, edges: get().edges });
    set({
      nodes: next.nodes,
      edges: next.edges,
      past: [...get().past, current].slice(-HISTORY_MAX),
      future: future.slice(1),
    });
    get().persist();
  },

  snapshot() {
    const s = get();
    return {
      id: s.workflowId,
      name: s.name,
      version: '1.0.0',
      nodes: s.nodes,
      edges: s.edges,
      defaultInputs: s.defaultInputs,
      ...(s.inputSchema.trim() ? { inputSchema: s.inputSchema } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // ADR 0440 P1 (grade-pass) — snapshot() is typed SavedWorkflow but was
      // omitting both of these, so the Run path registered a definition with NO
      // metadata and the route (which replaces wholesale) ERASED it. Pressing
      // Run therefore destroyed exactly what the autosave preserves.
      ...(s.lifecycle ? { lifecycle: s.lifecycle } : {}),
      ...(s.metadata ? { metadata: s.metadata } : {}),
      ...(s.variables !== undefined ? { variables: s.variables } : {}),
      ...(s.configurableSchema !== undefined ? { configurableSchema: s.configurableSchema } : {}),
    };
  },

  clearTransient() {
    const cur = get().lifecycle;
    if (!cur?.transient) return;
    const { transient: _dropped, ...rest } = cur;
    set({ lifecycle: Object.keys(rest).length ? rest : undefined });
    get().persist();
  },

  persist() {
    const s = get();
    if (!s.workflowId) return;
    const wf = {
      id: s.workflowId,
      name: s.name,
      version: '1.0.0',
      nodes: s.nodes,
      edges: s.edges,
      defaultInputs: s.defaultInputs,
      ...(s.inputSchema.trim() ? { inputSchema: s.inputSchema } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(s.lifecycle ? { lifecycle: s.lifecycle } : {}),
      ...(s.metadata ? { metadata: s.metadata } : {}),
      ...(s.variables !== undefined ? { variables: s.variables } : {}),
      ...(s.configurableSchema !== undefined ? { configurableSchema: s.configurableSchema } : {}),
    };
    upsertSavedWorkflow(wf); // immediate local (offline-safe)
    scheduleBackendSync(wf); // debounced write-through to the backend (R-D)
  },

  startOverlay(runId, backendIdToBuilder) {
    set({
      overlay: { runId, backendIdToBuilder, nodeStatus: {}, nodeDetail: {}, runStatus: 'running' },
    });
  },

  applyRunEvent(ev) {
    const overlay = get().overlay;
    if (!overlay || ev.runId !== overlay.runId) return;
    // Run-level terminal transitions update the banner status.
    if (ev.type === 'run.completed') { set({ overlay: { ...overlay, runStatus: 'completed' } }); return; }
    if (ev.type === 'run.failed') { set({ overlay: { ...overlay, runStatus: 'failed' } }); return; }
    if (ev.type === 'run.cancelled') { set({ overlay: { ...overlay, runStatus: 'cancelled' } }); return; }
    // Node-level transitions paint individual nodes.
    if (!ev.nodeId) return;
    const builderId = overlay.backendIdToBuilder[ev.nodeId];
    if (!builderId) return;
    const next: NodeRunStatus | null =
      ev.type === 'node.started' ? 'running'
      : ev.type === 'node.completed' ? 'completed'
      : ev.type === 'node.failed' ? 'failed'
      : ev.type === 'node.suspended' ? 'suspended'
      : isInterruptResolvedEvent(ev.type) ? 'running'
      : null;
    if (!next) return;
    const prevDetail = overlay.nodeDetail[builderId];
    set({
      overlay: {
        ...overlay,
        nodeStatus: { ...overlay.nodeStatus, [builderId]: next },
        // CV-17 — drawer detail: latest transition time; the payload sticks
        // from the last TERMINAL event (completed output / failed error).
        nodeDetail: {
          ...overlay.nodeDetail,
          [builderId]: {
            status: next,
            at: ev.timestamp,
            ...(ev.type === 'node.completed' || ev.type === 'node.failed'
              ? { payload: ev.payload }
              : prevDetail?.payload !== undefined ? { payload: prevDetail.payload } : {}),
          },
        },
      },
    });
  },

  clearOverlay() {
    set({ overlay: null });
  },

  setDebugSession(session) {
    set({ debugSession: session });
  },

  setDebugPin(builderNodeId, pin) {
    const s = get().debugSession;
    set({ debugSession: { ...(s ?? { pins: {} }), pins: { ...(s?.pins ?? {}), [builderNodeId]: pin } } });
  },

  removeDebugPin(builderNodeId) {
    const s = get().debugSession;
    if (!s) return;
    const pins = { ...s.pins };
    delete pins[builderNodeId];
    set({ debugSession: Object.keys(pins).length > 0 || s.sourceRunId ? { ...s, pins } : null });
  },

  setFailureHeat(heat, mode) {
    set({ failureHeat: heat, failureHeatMode: heat === null ? 'failures' : (mode ?? 'failures') });
  },

  setCollabLive(live) {
    set({ collabLive: live });
  },

  setCollabPeers(peers) {
    set({ collabPeers: peers });
  },
}));

function pushHistory(
  set: (partial: Partial<BuilderState>) => void,
  get: () => BuilderState,
): void {
  const current = clone({ nodes: get().nodes, edges: get().edges });
  set({ past: [...get().past, current].slice(-HISTORY_MAX), future: [] });
}
