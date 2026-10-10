/**
 * ADR 0773 D5 — the builder's pure model of a `WorkflowEditSuggestion`.
 *
 * The server validated the ops against the head it was drawn on and recorded a
 * PREIMAGE of every path each op touches. Here, at keep time, each op is checked
 * against the LIVE canvas: it applies only if every path it touches still holds
 * its preimage (canvas decision 1b — a per-op check, never "the whole revision
 * moved", which in a live room would invalidate every suggestion on every
 * keystroke). A keep then goes through `applyEditOpsToGraph`, called by ONE
 * store action so a keep is exactly one undo step.
 *
 * Pure: no store, no React, no network — unit-tested directly.
 */

import type { BuilderEdge, BuilderNode } from '../schema/workflow.js';
import { catalogEntry, catalogEntryByTypeId, defaultConfigFor } from '../palette/catalogRegistry.js';

export interface EdgeCondition {
  path: string;
  op: 'eq' | 'neq' | 'truthy' | 'falsy' | 'exists' | 'contains';
  value?: unknown;
}

export type EditOp =
  | { kind: 'addNode'; nodeId: string; typeId: string; name?: string; config?: Record<string, unknown>; inputs?: Record<string, unknown>; position?: { x: number; y: number } }
  | { kind: 'removeNode'; nodeId: string }
  | { kind: 'setConfig'; nodeId: string; path: string; value: unknown }
  | { kind: 'renameNode'; nodeId: string; name: string }
  | { kind: 'addEdge'; edgeId: string; sourceNodeId: string; targetNodeId: string; sourceOutput?: string; targetInput?: string; condition?: EdgeCondition; label?: string; triggerRule?: BuilderEdge['triggerRule'] }
  | { kind: 'removeEdge'; edgeId: string }
  | { kind: 'setCondition'; edgeId: string; condition: EdgeCondition | null };

export interface Preimage {
  path: string;
  present: boolean;
  value?: unknown;
}

export interface SuggestedOp {
  op: EditOp;
  dependsOn: number[];
  preimages: Preimage[];
  gateSensitive: boolean;
  summary: string;
  /** G-03d — the model's reason (untrusted text; render as text only). */
  why?: string;
}

export type ServerOpState = 'pending' | 'kept' | 'dropped' | 'superseded';

export interface WorkflowEditSuggestion {
  id: string;
  workflowId: string;
  conversationId: string;
  requestedBy: string;
  baseRevision: string;
  summary: string;
  ops: SuggestedOp[];
  opState: ServerOpState[];
  visibility: 'private' | 'room';
  followUps?: string[];
  plannedOps?: number;
  source?: 'architect' | 'chain';
  createdAt: string;
  updatedAt: string;
}

/** What an op is, right now, against the live canvas. */
export type LiveOpStatus = ServerOpState | 'stale' | 'inapplicable';

export interface Graph {
  nodes: readonly BuilderNode[];
  edges: readonly BuilderEdge[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Key-order-independent equality for JSON-shaped values. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => sameJson(a[k], b[k]));
  }
  return false;
}

export function readConfigPath(config: Record<string, unknown> | undefined, path: string): { present: boolean; value?: unknown } {
  let cur: unknown = config;
  for (const s of path.split('.')) {
    if (!isObj(cur) || !Object.prototype.hasOwnProperty.call(cur, s)) return { present: false };
    cur = cur[s];
  }
  return { present: true, value: cur };
}

export function writeConfigPath(config: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const segs = path.split('.');
  if (segs.some((s) => !s || s === '__proto__' || s === 'constructor' || s === 'prototype')) return { ...config };
  const root: Record<string, unknown> = structuredClone(config);
  let cur = root;
  segs.forEach((s, i) => {
    if (i === segs.length - 1) {
      if (value === undefined || value === null) delete cur[s];
      else cur[s] = value;
      return;
    }
    cur[s] = isObj(cur[s]) ? { ...(cur[s] as Record<string, unknown>) } : {};
    cur = cur[s] as Record<string, unknown>;
  });
  return root;
}

/** The label a node shows when the backend carries no `name` (deserialize's default). */
function defaultLabel(node: BuilderNode): string {
  return catalogEntry(node.kind)?.label ?? node.kind;
}

/** Does the live canvas still hold this preimage? */
export function preimageHolds(p: Preimage, g: Graph): boolean {
  const [space, id, field, ...rest] = p.path.split('.');
  if (space === 'nodes' && id) {
    const node = g.nodes.find((n) => n.id === id);
    if (field === undefined) {
      if (!p.present) return !node;
      if (!node) return false;
      // `{ exists: true }` = "the node must still be there" (an edge endpoint).
      if (isObj(p.value) && p.value.exists === true && Object.keys(p.value).length === 1) return true;
      const pre = p.value as { config?: Record<string, unknown> } | undefined;
      return sameJson(node.config ?? {}, pre?.config ?? {});
    }
    if (!node) return false;
    if (field === 'name') return p.present ? node.name === p.value : node.name === defaultLabel(node);
    if (field === 'config') {
      const cur = readConfigPath(node.config, rest.join('.'));
      return cur.present === p.present && (!p.present || sameJson(cur.value, p.value));
    }
    return false;
  }
  if (space === 'edges' && id) {
    const edge = g.edges.find((e) => e.id === id);
    if (field === undefined) {
      if (!p.present) return !edge;
      const pre = p.value as { sourceNodeId?: string; targetNodeId?: string } | undefined;
      return !!edge && (!pre?.sourceNodeId || edge.source === pre.sourceNodeId) && (!pre?.targetNodeId || edge.target === pre.targetNodeId);
    }
    if (!edge) return false;
    if (field === 'condition') return p.present ? sameJson(edge.condition, p.value) : edge.condition === undefined;
    return false;
  }
  return false;
}

/** The live status of every op: server state first, then dependency and preimage checks. */
export function liveOpStatuses(s: WorkflowEditSuggestion, g: Graph, localState?: readonly ServerOpState[]): LiveOpStatus[] {
  const state = localState ?? s.opState;
  return s.ops.map((o, i) => {
    const st = state[i] ?? 'pending';
    if (st !== 'pending') return st;
    if (o.dependsOn.some((d) => state[d] === 'dropped' || state[d] === 'superseded')) return 'inapplicable';
    // A path on a node a DEPENDENCY mints is not checkable yet — that node does
    // not exist until the dependency is kept (and keeping this op keeps it
    // first). Only paths on pre-existing nodes/edges carry a preimage to hold
    // (review CR-5: "add X and set its delay" read as stale otherwise).
    const checkable = o.preimages.filter((p) => !o.dependsOn.some((d) => touchesMinted(s.ops[d]!.op, p.path)));
    return checkable.every((p) => preimageHolds(p, g)) ? 'pending' : 'stale';
  });
}

function touchesMinted(dep: EditOp, path: string): boolean {
  return dep.kind === 'addNode' && path.startsWith(`nodes.${dep.nodeId}`);
}

/** Order `wanted` so every op's pending dependencies come first (and are included). */
export function keepOrder(s: WorkflowEditSuggestion, wanted: readonly number[], state: readonly ServerOpState[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const visit = (i: number): void => {
    if (seen.has(i)) return;
    seen.add(i);
    for (const d of s.ops[i]?.dependsOn ?? []) if (state[d] === 'pending') visit(d);
    out.push(i);
  };
  for (const i of wanted) visit(i);
  return out;
}

const ORIGIN_X = 80;
const ORIGIN_Y = 80;
/** Vertical gap to a new step. A real card with three ports is ~110px tall;
 *  140 left 30px between cards once kept, and the connection looped behind the
 *  lower one (G-10a deployed-build check). */
const NEW_NODE_GAP_Y = 180;

/** Where a new node lands when the model gave no position: below its first
 *  connected source, or below the lowest node. */
function placeNewNode(op: Extract<EditOp, { kind: 'addNode' }>, all: readonly EditOp[], nodes: readonly BuilderNode[]): { x: number; y: number } {
  if (op.position) return op.position;
  const inbound = all.find((o) => o.kind === 'addEdge' && o.targetNodeId === op.nodeId) as Extract<EditOp, { kind: 'addEdge' }> | undefined;
  const src = inbound ? nodes.find((n) => n.id === inbound.sourceNodeId) : undefined;
  if (src) {
    const siblings = nodes.filter((n) => Math.abs(n.position.y - (src.position.y + NEW_NODE_GAP_Y)) < 40).length;
    return { x: src.position.x + siblings * 220, y: src.position.y + NEW_NODE_GAP_Y };
  }
  const maxY = nodes.reduce((m, n) => Math.max(m, n.position.y), ORIGIN_Y - NEW_NODE_GAP_Y);
  return { x: ORIGIN_X, y: maxY + NEW_NODE_GAP_Y };
}

/** A port name the node really has: the requested one if the catalog lists it,
 *  else the node's first port (a model-named port the node lacks would leave an
 *  edge pointing at no handle — review CR-7). */
function portOf(nodeKind: string | undefined, side: 'out' | 'in', requested?: string): string {
  const entry = nodeKind ? catalogEntry(nodeKind) : undefined;
  const ports = side === 'out' ? entry?.outputs : entry?.inputs;
  if (requested && (!ports || ports.some((p) => p.name === requested))) return requested;
  return ports?.[0]?.name ?? (side === 'out' ? 'out' : 'in');
}

/** Apply ops to a builder graph. `applied[i]` says whether op i actually landed —
 *  an op the builder cannot apply (a typeId this client's catalog lacks, an
 *  edge whose endpoint is missing) is reported, never silently marked kept
 *  (review CR-7). */
export function applyEditOpsToGraph(g: Graph, ops: readonly EditOp[]): { nodes: BuilderNode[]; edges: BuilderEdge[]; applied: boolean[] } {
  let nodes: BuilderNode[] = g.nodes.map((n) => ({ ...n }));
  let edges: BuilderEdge[] = g.edges.map((e) => ({ ...e }));
  const applied: boolean[] = [];
  for (const op of ops) {
    let ok = true;
    switch (op.kind) {
      case 'addNode': {
        const entry = catalogEntryByTypeId(op.typeId);
        if (!entry || nodes.some((n) => n.id === op.nodeId)) { ok = false; break; }
        nodes.push({
          id: op.nodeId,
          kind: entry.kind,
          name: op.name ?? entry.label,
          position: placeNewNode(op, ops, nodes),
          config: { ...defaultConfigFor(entry.kind), ...(op.config ?? {}) },
          ...(op.inputs ? { inputs: op.inputs } : {}),
        });
        break;
      }
      case 'removeNode':
        if (!nodes.some((n) => n.id === op.nodeId)) { ok = false; break; }
        nodes = nodes.filter((n) => n.id !== op.nodeId);
        edges = edges.filter((e) => e.source !== op.nodeId && e.target !== op.nodeId);
        break;
      case 'setConfig':
        if (!nodes.some((n) => n.id === op.nodeId)) { ok = false; break; }
        nodes = nodes.map((n) => (n.id === op.nodeId ? { ...n, config: writeConfigPath(n.config, op.path, op.value) } : n));
        break;
      case 'renameNode':
        if (!nodes.some((n) => n.id === op.nodeId)) { ok = false; break; }
        nodes = nodes.map((n) => (n.id === op.nodeId ? { ...n, name: op.name } : n));
        break;
      case 'addEdge': {
        const src = nodes.find((n) => n.id === op.sourceNodeId);
        const tgt = nodes.find((n) => n.id === op.targetNodeId);
        if (!src || !tgt || edges.some((e) => e.id === op.edgeId)) { ok = false; break; }
        edges.push({
          id: op.edgeId, source: src.id, target: tgt.id,
          sourcePort: portOf(src.kind, 'out', op.sourceOutput),
          targetPort: portOf(tgt.kind, 'in', op.targetInput),
          ...(op.condition ? { condition: op.condition } : {}),
          ...(op.label ? { label: op.label } : {}),
          ...(op.triggerRule ? { triggerRule: op.triggerRule } : {}),
        });
        break;
      }
      case 'removeEdge':
        if (!edges.some((e) => e.id === op.edgeId)) { ok = false; break; }
        edges = edges.filter((e) => e.id !== op.edgeId);
        break;
      case 'setCondition':
        if (!edges.some((e) => e.id === op.edgeId)) { ok = false; break; }
        edges = edges.map((e) => {
          if (e.id !== op.edgeId) return e;
          const { condition: _drop, ...rest } = e;
          return op.condition ? { ...rest, condition: op.condition } : rest;
        });
        break;
    }
    applied.push(ok);
  }
  return { nodes, edges, applied };
}

/** What the sheet draws for the pending ops: ghosts to add, marks on existing
 *  nodes, and existing nodes/edges shown as "to be removed". */
export interface GhostProjection {
  ghostNodes: Array<{ id: string; kind: string; name: string; position: { x: number; y: number }; index: number; gateSensitive: boolean; dropped: boolean }>;
  ghostEdges: Array<{ id: string; source: string; target: string; sourcePort: string; targetPort: string; index: number; label?: string }>;
  marksByNode: Map<string, number[]>;
  removedNodeIds: Set<string>;
  removedEdgeIds: Set<string>;
  changedEdgeIds: Map<string, number>;
}

export function projectGhosts(s: WorkflowEditSuggestion, g: Graph, statuses: readonly LiveOpStatus[]): GhostProjection {
  const out: GhostProjection = {
    ghostNodes: [], ghostEdges: [], marksByNode: new Map(), removedNodeIds: new Set(), removedEdgeIds: new Set(), changedEdgeIds: new Map(),
  };
  const pendingOps = s.ops.map((o, i) => ({ ...o, index: i })).filter((o) => statuses[o.index] === 'pending' || statuses[o.index] === 'stale'
    // G-03b — a DROPPED add stays as a faint outline until the suggestion
    // closes, so a drop is visibly reversible.
    || (statuses[o.index] === 'dropped' && o.op.kind === 'addNode'));
  const allOps = pendingOps.map((o) => o.op);
  const placed: BuilderNode[] = [...g.nodes];
  const mark = (nodeId: string, index: number): void => {
    const arr = out.marksByNode.get(nodeId) ?? [];
    if (!arr.includes(index)) arr.push(index);
    out.marksByNode.set(nodeId, arr);
  };
  for (const o of pendingOps) {
    const op = o.op;
    switch (op.kind) {
      case 'addNode': {
        const entry = catalogEntryByTypeId(op.typeId);
        const position = placeNewNode(op, allOps, placed);
        const kind = entry?.kind ?? op.typeId;
        const node = { id: op.nodeId, kind, name: op.name ?? entry?.label ?? op.typeId, position, index: o.index, gateSensitive: o.gateSensitive, dropped: statuses[o.index] === 'dropped' };
        out.ghostNodes.push(node);
        placed.push({ id: node.id, kind, name: node.name, position, config: {} });
        break;
      }
      case 'removeNode': if (statuses[o.index] !== 'dropped') { out.removedNodeIds.add(op.nodeId); mark(op.nodeId, o.index); } break;
      case 'setConfig': case 'renameNode': mark(op.nodeId, o.index); break;
      case 'addEdge': {
        if (statuses[o.index] === 'dropped') break;
        const srcKind = placed.find((n) => n.id === op.sourceNodeId)?.kind;
        const tgtKind = placed.find((n) => n.id === op.targetNodeId)?.kind;
        out.ghostEdges.push({
          id: op.edgeId, source: op.sourceNodeId, target: op.targetNodeId, index: o.index,
          sourcePort: portOf(srcKind, 'out', op.sourceOutput), targetPort: portOf(tgtKind, 'in', op.targetInput),
          ...(op.condition ? { label: conditionLabel(op.condition) } : op.label ? { label: op.label } : {}),
        });
        break;
      }
      case 'removeEdge': out.removedEdgeIds.add(op.edgeId); break;
      case 'setCondition': out.changedEdgeIds.set(op.edgeId, o.index); break;
    }
  }
  return out;
}

/** The handles a suggested edge attaches to. A real step has one handle per
 *  named port; a ghost step has one unnamed handle per side, so an endpoint
 *  that is itself a ghost carries NO handle id (React Flow then uses the
 *  node's only handle). */
export function ghostEdgeHandles(
  g: { source: string; target: string; sourcePort: string; targetPort: string },
  ghostNodeIds: ReadonlySet<string>,
): { sourceHandle?: string; targetHandle?: string } {
  return {
    ...(ghostNodeIds.has(g.source) ? {} : { sourceHandle: g.sourcePort }),
    ...(ghostNodeIds.has(g.target) ? {} : { targetHandle: g.targetPort }),
  };
}

export function conditionLabel(c: EdgeCondition): string {
  return c.op === 'truthy' || c.op === 'falsy' || c.op === 'exists' ? `${c.path} ${c.op}` : `${c.path} ${c.op} ${JSON.stringify(c.value)}`;
}

/** Ops eligible for opt-in auto-keep (ADR 0773 D5): config/rename on a SELECTED
 *  node, not gate-sensitive, currently applicable. Structural ops never qualify. */
export function autoKeepable(s: WorkflowEditSuggestion, statuses: readonly LiveOpStatus[], selectedNodeIds: readonly string[]): number[] {
  const sel = new Set(selectedNodeIds);
  return s.ops.flatMap((o, i) => {
    if (statuses[i] !== 'pending' || o.gateSensitive || o.dependsOn.length > 0) return [];
    const op = o.op;
    if ((op.kind === 'setConfig' || op.kind === 'renameNode') && sel.has(op.nodeId)) return [i];
    return [];
  });
}

/** G-03e / G-03f — ops whose value a person may EDIT before keeping, or FORCE
 *  over a moved value. Structural ops are never forceable: forcing an add or a
 *  removal over a changed graph is how a dangling edge is made. */
export function isValueOp(op: EditOp): op is Extract<EditOp, { kind: 'setConfig' | 'renameNode' | 'setCondition' }> {
  return op.kind === 'setConfig' || op.kind === 'renameNode' || op.kind === 'setCondition';
}

/** The same op with a person-edited value (G-03e). */
export function withEditedValue(op: EditOp, value: unknown): EditOp {
  if (op.kind === 'setConfig') return { ...op, value };
  if (op.kind === 'renameNode' && typeof value === 'string' && value.trim()) return { ...op, name: value.trim() };
  return op;
}
