/**
 * The app-builder `graph` trait (ADR 0323 Phase 2) — a screen is a node, a
 * connector is an edge. The chassis (`canvas/graph/GraphSurface`) owns pan/zoom,
 * selection, keyboard, and history; this projects the `canvas.app-builder` doc
 * into nodes/edges and applies mutations to a cloned doc (the chassis commits it
 * as one undo step). A node renders a live scaled preview of the screen's real
 * components via the SHARED safe renderer (`AppScreenPreview`, reusing `CompView`
 * — no forked render path). Positions + connectors persist in the ONE artifact
 * doc (Phase 0 schema) → replay/fork-safe via the existing CAS PATCH.
 *
 * Connectors are a POSITIONAL array (no id field), so edges use index-as-id, the
 * same model as the elements trait; the chassis clamps a stale edge selection so
 * a delete never hits the wrong index.
 */
import type { GraphTraitDef, GraphNodeView, GraphEdgeView, CanvasPropDef } from '../../canvas/types.js';
import { AppScreenPreview } from '../../chat/artifacts/AppBuilderPreview.js';
import { appBuilderFrameOps, MAX_SCREENS, type AppDoc, type Connector } from './screenOps.js';
import type { Screen } from './canvasTree.js';

const fin = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// One node-size source — the device frame + the spawn offset both read it.
const NODE_W = 190;
const GRID_SNAP = 20; // must match the trait's gridSnap below
const NODE_H = 360;
const SPAWN_GAP = 120;
// The server hard-rejects |x|/|y| > 100000 (validateAppDoc POS_BOUND); clamp
// client writes to the same bound so an optimistic edit can never 422 on save.
const POS_BOUND = 100_000;
const clampPos = (v: number): number => Math.max(-POS_BOUND, Math.min(POS_BOUND, Math.round(v)));

export const appBuilderGraph: GraphTraitDef<AppDoc> = {
  // ADR 0337 — the app-builder is graph-first: screens ARE the unit of work.
  defaultView: 'graph',
  nodeSize: { w: NODE_W, h: NODE_H },
  // ADR 0337 P2b — device frames for the board (render-only override; ephemeral,
  // never persisted). Dimensions are the design-time preview scale, not the
  // real device pixels — a legible board frame at a consistent aspect.
  deviceFrames: [
    { id: 'iphone15', label: 'iPhone 15 Pro', width: 190, height: 360 },
    { id: 'iphonese', label: 'iPhone SE', width: 176, height: 320 },
    { id: 'ipad', label: 'iPad', width: 300, height: 400 },
    { id: 'desktop', label: 'Desktop', width: 440, height: 280 },
  ],
  defaultDevice: 'iphone15',
  gridSnap: 20,

  nodes: (doc) => (doc.screens ?? []).map((s): GraphNodeView => {
    const x = fin(s.x), y = fin(s.y);
    return {
      id: s.id,
      label: s.name || s.id,
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      ...(s.isInitial ? { isHome: true } : {}),
      // ADR 0342 Phase 0: the board node renders the SAME doc the preview does —
      // generated theme colors + bound sample rows included, not a washed-out copy.
      data: { screen: s, theme: doc.theme, themeColors: doc.themeColors, dataSources: doc.dataSources },
    };
  }),

  edges: (doc) => (doc.connectors ?? []).map((c, i): GraphEdgeView => ({
    id: String(i),
    from: c.from,
    to: c.to,
    ...(c.sourceEdge ? { sourceEdge: c.sourceEdge } : {}),
    ...(c.targetEdge ? { targetEdge: c.targetEdge } : {}),
    ...(c.routingStyle ? { routing: c.routingStyle } : {}),
    ...(c.animated ? { animated: true } : {}),
    ...(c.label ? { label: c.label } : {}),
    data: c,
  })),

  // Audit gap #1 — the selected connector's editable fields. All closed-world
  // (validateAppDoc hard-enforces the enums; the picker can't emit anything else).
  edgePropDefs: [
    { name: 'label', type: 'string', label: 'Label' },
    { name: 'trigger', type: 'enum', label: 'Trigger', options: ['click', 'submit', 'load'] },
    { name: 'transition', type: 'enum', label: 'Transition', options: ['push', 'replace', 'modal', 'fade', 'slide', 'none'] },
    { name: 'routingStyle', type: 'enum', label: 'Routing', options: ['bezier', 'orthogonal', 'straight', 'step'] },
    { name: 'animated', type: 'boolean', label: 'Animated' },
  ] satisfies CanvasPropDef[],

  updateEdge: (doc, id, patch) => {
    const i = Number(id);
    const c = doc.connectors?.[i];
    if (!c || !Number.isInteger(i)) return;
    // Widen via `object` (the chassis `dict` idiom) — a direct interface cast
    // fails TS2352; the values are closed-world (validateAppDoc hard-enforces).
    const rec = (o: object): Record<string, unknown> => o as Record<string, unknown>;
    const target = rec(c);
    for (const [k, v] of Object.entries(patch)) {
      // undefined / '' clears the optional field (deleted, never stored undefined).
      if (v === undefined || v === '') delete target[k];
      else target[k] = v;
    }
  },

  // Audit gap #2 — spawn a screen pre-connected from `fromId`, placed to its
  // right. Screen creation stays with the ONE owner (the frames factory — id
  // slug uniqueness, /route stamp, home semantics); this only adds position +
  // the connector. Null when the screen cap is reached.
  addConnectedNode: (doc, fromId, name, pos) => {
    const screens = doc.screens ?? [];
    const from = screens.find((s) => s.id === fromId);
    if (!from || screens.length >= MAX_SCREENS) return null;
    const idx = appBuilderFrameOps.addFrame(doc, name);
    const created = doc.screens[idx];
    if (!created) return null;
    if (pos) {
      // §7.4 / CV-10 — link-drag-create: land at the drop point, grid-snapped.
      created.x = clampPos(Math.round(pos.x / GRID_SNAP) * GRID_SNAP);
      created.y = clampPos(Math.round(pos.y / GRID_SNAP) * GRID_SNAP);
    } else {
      created.x = clampPos((typeof from.x === 'number' ? from.x : 80) + NODE_W + SPAWN_GAP);
      created.y = clampPos(typeof from.y === 'number' ? from.y : 80);
    }
    if (!doc.connectors) doc.connectors = [];
    doc.connectors.push({ from: fromId, to: created.id } satisfies Connector);
    return created.id;
  },

  moveNode: (doc, id, x, y) => {
    const s = (doc.screens ?? []).find((sc) => sc.id === id);
    if (s) { s.x = clampPos(x); s.y = clampPos(y); }
  },

  connect: (doc, from, to) => {
    if (from === to) return false;
    const screens = doc.screens ?? [];
    if (!screens.some((s) => s.id === from) || !screens.some((s) => s.id === to)) return false;
    if (!doc.connectors) doc.connectors = [];
    if (doc.connectors.some((c) => c.from === from && c.to === to)) return false; // no duplicate edge
    doc.connectors.push({ from, to });
    return true;
  },

  deleteEdge: (doc, id) => {
    const i = Number(id);
    if (doc.connectors && Number.isInteger(i) && i >= 0 && i < doc.connectors.length) doc.connectors.splice(i, 1);
  },

  renderNode: (node) => {
    const d = node.data as { screen: Screen; theme?: string; themeColors?: AppDoc['themeColors']; dataSources?: AppDoc['dataSources'] } | undefined;
    if (!d) return null;
    return (
      <AppScreenPreview
        screen={d.screen}
        {...(d.theme ? { theme: d.theme } : {})}
        {...(d.themeColors ? { themeColors: d.themeColors } : {})}
        {...(d.dataSources ? { dataSources: d.dataSources } : {})}
      />
    );
  },
};
