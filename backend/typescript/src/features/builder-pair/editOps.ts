/**
 * ADR 0773 D4 — the closed edit-op vocabulary of a `WorkflowEditSuggestion`,
 * and the PURE pipeline that turns a model's raw op list into a validated,
 * keep-able suggestion: normalize → mint ids → resolve references → record
 * preimages + dependencies → apply to the head → validate the result.
 *
 * Pure (no I/O): the caller supplies the head definition and the validator, so
 * the whole op contract is unit-testable without a host.
 *
 * Why preimages: a keep is checked PER OP at keep time (ADR 0773 D5 / canvas
 * decision 1b). An op is stale only when a path it touches has moved since it
 * was drawn — never merely because the whole revision moved, which in a live
 * room would invalidate every suggestion on every peer keystroke.
 *
 * Why server-minted node ids (Architect review A4): an id chosen by the model
 * could collide with a node a peer added concurrently, and a keep would then
 * overwrite it. `sg_<suggestionId>_<n>` cannot collide with a builder-minted id.
 */

import type { EdgeDef, WorkflowDefinition } from '../../executor/types.js';
import { APPROVAL_GATE_TYPE_IDS } from '../../host/approvalGateTypeIds.js';

export type EdgeCondition = NonNullable<EdgeDef['condition']>;
type WorkflowNode = WorkflowDefinition['nodes'][number];

export const EDIT_OP_KINDS = ['addNode', 'removeNode', 'setConfig', 'renameNode', 'addEdge', 'removeEdge', 'setCondition'] as const;
export type EditOpKind = (typeof EDIT_OP_KINDS)[number];

const CONDITION_OPS = ['eq', 'neq', 'truthy', 'falsy', 'exists', 'contains'] as const;
/** RFC 0134 wire form: these ops take NO `value`. */
const VALUELESS_CONDITION_OPS: ReadonlySet<string> = new Set(['truthy', 'falsy', 'exists']);

/** A normalized, keep-able op. Node references are FINAL ids (existing or minted). */
export type EditOp =
  | { kind: 'addNode'; nodeId: string; typeId: string; name?: string; config?: Record<string, unknown>; inputs?: Record<string, unknown>; position?: { x: number; y: number } }
  | { kind: 'removeNode'; nodeId: string }
  | { kind: 'setConfig'; nodeId: string; path: string; value: unknown }
  | { kind: 'renameNode'; nodeId: string; name: string }
  | { kind: 'addEdge'; edgeId: string; sourceNodeId: string; targetNodeId: string; sourceOutput?: string; targetInput?: string; condition?: EdgeCondition; label?: string; triggerRule?: EdgeDef['triggerRule'] }
  | { kind: 'removeEdge'; edgeId: string }
  | { kind: 'setCondition'; edgeId: string; condition: EdgeCondition | null };

/** What an op saw at the paths it touches, captured from the head it was drawn on.
 *  `null` value with `present:false` means "the path did not exist". */
export interface Preimage {
  path: string;
  present: boolean;
  value?: unknown;
}

export interface SuggestedOp {
  op: EditOp;
  /** Indexes of ops that must be kept before this one (it references their minted node). */
  dependsOn: number[];
  preimages: Preimage[];
  /** Touches an approval-gate node or an edge incident to one (ADR 0582). Never auto-kept. */
  gateSensitive: boolean;
  /** A one-line, host-rendered description for the review list. */
  summary: string;
  /** ADR 0773 G-03d — the model's reason for this op (≤ 280 chars). UNTRUSTED
   *  model text: rendered as plain text, never HTML. */
  why?: string;
}

export interface OpError {
  index: number;
  message: string;
}

export type NormalizeResult =
  | { ok: true; ops: SuggestedOp[]; candidate: WorkflowDefinition }
  | { ok: false; errors: OpError[] };

export const MAX_OPS_PER_SUGGESTION = 40;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Dotted config path → segments. Refuses empty segments and prototype keys. */
export function configPathSegments(path: string): string[] | null {
  const segs = path.split('.');
  if (segs.length === 0 || segs.some((s) => !s || s === '__proto__' || s === 'constructor' || s === 'prototype')) return null;
  return segs;
}

export function readConfigPath(config: Record<string, unknown> | undefined, path: string): { present: boolean; value?: unknown } {
  const segs = configPathSegments(path);
  if (!segs) return { present: false };
  let cur: unknown = config;
  for (const s of segs) {
    if (!isObj(cur) || !Object.prototype.hasOwnProperty.call(cur, s)) return { present: false };
    cur = cur[s];
  }
  return { present: true, value: cur };
}

export function writeConfigPath(config: Record<string, unknown> | undefined, path: string, value: unknown): Record<string, unknown> {
  const segs = configPathSegments(path);
  if (!segs) return { ...(config ?? {}) };
  const root: Record<string, unknown> = structuredClone(config ?? {});
  let cur: Record<string, unknown> = root;
  segs.forEach((s, i) => {
    if (i === segs.length - 1) {
      // `null` clears too — the tool schema says "omit or null to clear", and
      // the builder applies it the same way (review CR-6).
      if (value === undefined || value === null) delete cur[s];
      else cur[s] = value;
      return;
    }
    const next = cur[s];
    cur[s] = isObj(next) ? { ...next } : {};
    cur = cur[s] as Record<string, unknown>;
  });
  return root;
}

function parseCondition(raw: unknown): { ok: true; condition: EdgeCondition } | { ok: false; message: string } {
  if (!isObj(raw)) return { ok: false, message: 'condition must be an object { path, op, value? }' };
  const path = str(raw.path);
  const op = raw.op;
  if (!path) return { ok: false, message: 'condition.path is required' };
  if (typeof op !== 'string' || !(CONDITION_OPS as readonly string[]).includes(op)) {
    return { ok: false, message: `condition.op must be one of ${CONDITION_OPS.join(', ')}` };
  }
  if (VALUELESS_CONDITION_OPS.has(op)) {
    if (raw.value !== undefined) return { ok: false, message: `condition op '${op}' takes no value (RFC 0134 wire form)` };
    return { ok: true, condition: { path, op: op as EdgeCondition['op'] } };
  }
  if (raw.value === undefined) return { ok: false, message: `condition op '${op}' requires a value` };
  return { ok: true, condition: { path, op: op as EdgeCondition['op'], value: raw.value } };
}

export interface NormalizeInput {
  suggestionId: string;
  head: WorkflowDefinition;
  /** ADR 0773 G-05a append mode — ops already in the suggestion. Their minted
   *  ids continue (`mintOffset`), new op indexes start at `indexOffset`, and a
   *  new op touching a node an EARLIER batch adds depends on that op. */
  mintOffset?: number;
  indexOffset?: number;
  priorMinted?: ReadonlyMap<string, number>;
  rawOps: unknown;
  /** Structural + closed-world + acyclic validation of the fully applied candidate. */
  validate: (candidate: WorkflowDefinition) => { ok: boolean; errors: string[] };
  /** typeIds the catalog knows; an addNode outside it is refused per op. */
  isKnownTypeId: (typeId: string) => boolean;
}

/**
 * Normalize a model's raw op list. The model refers to a node it is adding by a
 * local `ref` (any string it chooses); every other op may name either an
 * existing node id or such a ref. Refs are replaced by minted ids here, so no
 * op that leaves this function carries a model-chosen node id.
 */
export function normalizeEditOps(input: NormalizeInput): NormalizeResult {
  const { head, suggestionId } = input;
  const errors: OpError[] = [];
  if (!Array.isArray(input.rawOps) || input.rawOps.length === 0) {
    return { ok: false, errors: [{ index: -1, message: 'ops must be a non-empty array' }] };
  }
  if (input.rawOps.length > MAX_OPS_PER_SUGGESTION) {
    return { ok: false, errors: [{ index: -1, message: `at most ${MAX_OPS_PER_SUGGESTION} ops per suggestion; split the change` }] };
  }

  const headNodes = new Map<string, WorkflowNode>(head.nodes.map((n) => [n.nodeId, n]));
  const headEdges = new Map<string, EdgeDef>((head.edges ?? []).map((e) => [e.edgeId, e]));
  const refToMinted = new Map<string, { nodeId: string; opIndex: number }>();
  let minted = input.mintOffset ?? 0;
  const off = input.indexOffset ?? 0;
  const priorMinted = input.priorMinted ?? new Map<string, number>();
  const mintNodeId = (): string => `sg_${suggestionId}_${++minted}`;
  const mintEdgeId = (): string => `sge_${suggestionId}_${++minted}`;

  // Pass 1: mint every added node's id first, so an edge may reference a node
  // added LATER in the list (the model need not topologically sort its ops).
  input.rawOps.forEach((raw, index) => {
    if (isObj(raw) && raw.kind === 'addNode') {
      const ref = str(raw.ref);
      if (ref) {
        if (refToMinted.has(ref) || headNodes.has(ref)) errors.push({ index, message: `ref '${ref}' is already used; give each added node a unique ref` });
        else refToMinted.set(ref, { nodeId: mintNodeId(), opIndex: off + index });
      }
    }
  });

  const resolveNode = (name: unknown, index: number, field: string): { nodeId: string; dependsOn?: number } | null => {
    const id = str(name);
    if (!id) { errors.push({ index, message: `${field} is required` }); return null; }
    const mintedRef = refToMinted.get(id);
    if (mintedRef) return { nodeId: mintedRef.nodeId, dependsOn: mintedRef.opIndex };
    const prior = priorMinted.get(id);
    if (prior !== undefined) return { nodeId: id, dependsOn: prior };
    if (headNodes.has(id)) return { nodeId: id };
    errors.push({ index, message: `${field} '${id}' is neither a node in this workflow nor the ref of a node this suggestion adds` });
    return null;
  };

  const out: SuggestedOp[] = [];
  /** The model's raw op index for each `out` entry — errors must point at THE MODEL'S op. */
  const rawIndexOf: number[] = [];
  const removedNodes = new Set<string>();
  const whyOf = (raw: Record<string, unknown>): string | undefined => {
    const w = str(raw.why);
    return w ? w.slice(0, 280) : undefined;
  };
  let currentRaw: Record<string, unknown> = {};
  const emit = (index: number, s: SuggestedOp): void => {
    const why = whyOf(currentRaw);
    out.push(why ? { ...s, why } : s);
    rawIndexOf.push(index);
  };
  input.rawOps.forEach((raw, index) => {
    if (!isObj(raw) || typeof raw.kind !== 'string' || !(EDIT_OP_KINDS as readonly string[]).includes(raw.kind)) {
      errors.push({ index, message: `op.kind must be one of ${EDIT_OP_KINDS.join(', ')}` });
      return;
    }
    const kind = raw.kind as EditOpKind;
    currentRaw = raw;
    switch (kind) {
      case 'addNode': {
        const typeId = str(raw.typeId);
        const ref = str(raw.ref);
        if (!typeId) { errors.push({ index, message: 'addNode.typeId is required' }); return; }
        if (!input.isKnownTypeId(typeId)) { errors.push({ index, message: `typeId '${typeId}' is not in this host's node catalog (closed world)` }); return; }
        if (!ref) { errors.push({ index, message: 'addNode.ref is required (a local handle other ops use to reference this node)' }); return; }
        const nodeId = refToMinted.get(ref)?.nodeId;
        if (!nodeId) return; // duplicate ref already reported
        if (raw.config !== undefined && !isObj(raw.config)) { errors.push({ index, message: 'addNode.config must be an object' }); return; }
        const pos = isObj(raw.position) && typeof raw.position.x === 'number' && typeof raw.position.y === 'number'
          ? { x: raw.position.x, y: raw.position.y } : undefined;
        const name = str(raw.name);
        if (raw.inputs !== undefined && !isObj(raw.inputs)) { errors.push({ index, message: 'addNode.inputs must be an object' }); return; }
        emit(index, {
          op: {
            kind, nodeId, typeId, ...(name ? { name } : {}), ...(isObj(raw.config) ? { config: raw.config } : {}),
            ...(isObj(raw.inputs) ? { inputs: raw.inputs } : {}), ...(pos ? { position: pos } : {}),
          },
          dependsOn: [], preimages: [{ path: `nodes.${nodeId}`, present: false }],
          gateSensitive: APPROVAL_GATE_TYPE_IDS.has(typeId),
          summary: `Add ${name ?? typeId}`,
        });
        return;
      }
      case 'removeNode': {
        const id = str(raw.nodeId);
        const node = id ? headNodes.get(id) : undefined;
        if (!id || !node) { errors.push({ index, message: `removeNode.nodeId '${id ?? ''}' is not a node in this workflow` }); return; }
        removedNodes.add(id);
        const incident = (head.edges ?? []).filter((e) => e.sourceNodeId === id || e.targetNodeId === id);
        emit(index, {
          op: { kind, nodeId: id },
          dependsOn: [],
          preimages: [{ path: `nodes.${id}`, present: true, value: node }, ...incident.map((e) => ({ path: `edges.${e.edgeId}`, present: true, value: e }))],
          gateSensitive: APPROVAL_GATE_TYPE_IDS.has(node.typeId) || incident.some((e) => touchesGate(e, headNodes)),
          summary: `Remove ${node.name ?? id}`,
        });
        return;
      }
      case 'setConfig': {
        const target = resolveNode(raw.nodeId, index, 'setConfig.nodeId');
        const path = str(raw.path);
        if (!target) return;
        if (!path || !configPathSegments(path)) { errors.push({ index, message: 'setConfig.path must be a dotted config path (e.g. "retry.maxAttempts")' }); return; }
        const headNode = headNodes.get(target.nodeId);
        const pre = headNode ? readConfigPath(headNode.config, path) : { present: false };
        emit(index, {
          op: { kind, nodeId: target.nodeId, path, value: raw.value },
          dependsOn: target.dependsOn !== undefined ? [target.dependsOn] : [],
          preimages: [{ path: `nodes.${target.nodeId}.config.${path}`, ...pre }],
          gateSensitive: headNode ? APPROVAL_GATE_TYPE_IDS.has(headNode.typeId) : false,
          summary: `${headNode?.name ?? target.nodeId} · ${path}`,
        });
        return;
      }
      case 'renameNode': {
        const target = resolveNode(raw.nodeId, index, 'renameNode.nodeId');
        const name = str(raw.name);
        if (!target) return;
        if (!name) { errors.push({ index, message: 'renameNode.name is required' }); return; }
        const headNode = headNodes.get(target.nodeId);
        emit(index, {
          op: { kind, nodeId: target.nodeId, name },
          dependsOn: target.dependsOn !== undefined ? [target.dependsOn] : [],
          preimages: [{ path: `nodes.${target.nodeId}.name`, present: headNode?.name !== undefined, ...(headNode?.name !== undefined ? { value: headNode.name } : {}) }],
          gateSensitive: false,
          summary: `Rename ${headNode?.name ?? target.nodeId} → ${name}`,
        });
        return;
      }
      case 'addEdge': {
        const src = resolveNode(raw.source, index, 'addEdge.source');
        const tgt = resolveNode(raw.target, index, 'addEdge.target');
        if (!src || !tgt) return;
        let condition: EdgeCondition | undefined;
        if (raw.condition !== undefined) {
          const c = parseCondition(raw.condition);
          if (!c.ok) { errors.push({ index, message: `addEdge.${c.message}` }); return; }
          condition = c.condition;
        }
        const edgeId = mintEdgeId();
        const deps = [src.dependsOn, tgt.dependsOn].filter((d): d is number => d !== undefined);
        const label = str(raw.label);
        const TRIGGER_RULES = ['all_success', 'any_success', 'all_complete', 'none_failed', 'any_failed'];
        const triggerRule = typeof raw.triggerRule === 'string' && TRIGGER_RULES.includes(raw.triggerRule) ? raw.triggerRule as EdgeDef['triggerRule'] : undefined;
        const sourceOutput = str(raw.sourceOutput);
        const targetInput = str(raw.targetInput);
        const endpointPre = [src, tgt]
          .filter((e) => e.dependsOn === undefined)
          .map((e) => ({ path: `nodes.${e.nodeId}`, present: true, value: { exists: true } }));
        emit(index, {
          op: {
            kind, edgeId, sourceNodeId: src.nodeId, targetNodeId: tgt.nodeId,
            ...(sourceOutput ? { sourceOutput } : {}), ...(targetInput ? { targetInput } : {}),
            ...(condition ? { condition } : {}), ...(label ? { label } : {}), ...(triggerRule ? { triggerRule } : {}),
          },
          dependsOn: [...new Set(deps)],
          preimages: endpointPre,
          gateSensitive: isGateId(src.nodeId, headNodes) || isGateId(tgt.nodeId, headNodes),
          summary: `Connect ${nameOf(src.nodeId, headNodes)} → ${nameOf(tgt.nodeId, headNodes)}${condition ? ` when ${describeCondition(condition)}` : ''}`,
        });
        return;
      }
      case 'removeEdge': {
        const id = str(raw.edgeId);
        const edge = id ? headEdges.get(id) : undefined;
        if (!id || !edge) { errors.push({ index, message: `removeEdge.edgeId '${id ?? ''}' is not an edge in this workflow` }); return; }
        emit(index, {
          op: { kind, edgeId: id },
          dependsOn: [],
          preimages: [{ path: `edges.${id}`, present: true, value: edge }],
          gateSensitive: touchesGate(edge, headNodes),
          summary: `Disconnect ${nameOf(edge.sourceNodeId, headNodes)} → ${nameOf(edge.targetNodeId, headNodes)}`,
        });
        return;
      }
      case 'setCondition': {
        const id = str(raw.edgeId);
        const edge = id ? headEdges.get(id) : undefined;
        if (!id || !edge) { errors.push({ index, message: `setCondition.edgeId '${id ?? ''}' is not an edge in this workflow` }); return; }
        let condition: EdgeCondition | null = null;
        if (raw.condition !== null) {
          const c = parseCondition(raw.condition);
          if (!c.ok) { errors.push({ index, message: `setCondition.${c.message}` }); return; }
          condition = c.condition;
        }
        emit(index, {
          op: { kind, edgeId: id, condition },
          dependsOn: [],
          preimages: [{ path: `edges.${id}.condition`, present: edge.condition !== undefined, ...(edge.condition !== undefined ? { value: edge.condition } : {}) }],
          gateSensitive: touchesGate(edge, headNodes),
          summary: condition
            ? `${nameOf(edge.sourceNodeId, headNodes)} → ${nameOf(edge.targetNodeId, headNodes)} only when ${describeCondition(condition)}`
            : `${nameOf(edge.sourceNodeId, headNodes)} → ${nameOf(edge.targetNodeId, headNodes)} always`,
        });
        return;
      }
    }
  });

  // An op touching a node another op removes is contradictory within one suggestion.
  out.forEach((s, i) => {
    const touched = nodeIdsTouched(s.op);
    if (s.op.kind !== 'removeNode' && touched.some((n) => removedNodes.has(n))) {
      errors.push({ index: rawIndexOf[i]!, message: 'this op touches a node the same suggestion removes' });
    }
  });

  if (errors.length > 0) return { ok: false, errors };

  const candidate = applyEditOps(head, out.map((s) => s.op));
  const v = input.validate(candidate);
  if (!v.ok) return { ok: false, errors: v.errors.map((message) => ({ index: -1, message })) };
  return { ok: true, ops: out, candidate };
}

function nodeIdsTouched(op: EditOp): string[] {
  switch (op.kind) {
    case 'addNode': case 'removeNode': case 'setConfig': case 'renameNode': return [op.nodeId];
    case 'addEdge': return [op.sourceNodeId, op.targetNodeId];
    default: return [];
  }
}

function isGateId(nodeId: string, nodes: ReadonlyMap<string, WorkflowNode>): boolean {
  const n = nodes.get(nodeId);
  return !!n && APPROVAL_GATE_TYPE_IDS.has(n.typeId);
}

function touchesGate(edge: EdgeDef, nodes: ReadonlyMap<string, WorkflowNode>): boolean {
  return isGateId(edge.sourceNodeId, nodes) || isGateId(edge.targetNodeId, nodes);
}

function nameOf(nodeId: string, nodes: ReadonlyMap<string, WorkflowNode>): string {
  return nodes.get(nodeId)?.name ?? nodeId;
}

export function describeCondition(c: EdgeCondition): string {
  return VALUELESS_CONDITION_OPS.has(c.op) ? `${c.path} ${c.op}` : `${c.path} ${c.op} ${JSON.stringify(c.value)}`;
}

/** Apply ops to a definition (the server's validation candidate; the builder
 *  applies the same ops through its own store actions). */
export function applyEditOps(head: WorkflowDefinition, ops: readonly EditOp[]): WorkflowDefinition {
  let nodes: WorkflowNode[] = head.nodes.map((n) => ({ ...n }));
  let edges: EdgeDef[] = (head.edges ?? []).map((e) => ({ ...e }));
  for (const op of ops) {
    switch (op.kind) {
      case 'addNode':
        nodes.push({
          nodeId: op.nodeId, typeId: op.typeId,
          ...(op.name ? { name: op.name } : {}), ...(op.config ? { config: op.config } : {}),
          ...(op.inputs ? { inputs: op.inputs } : {}), ...(op.position ? { position: op.position } : {}),
        });
        break;
      case 'removeNode':
        nodes = nodes.filter((n) => n.nodeId !== op.nodeId);
        edges = edges.filter((e) => e.sourceNodeId !== op.nodeId && e.targetNodeId !== op.nodeId);
        break;
      case 'setConfig':
        nodes = nodes.map((n) => (n.nodeId === op.nodeId ? { ...n, config: writeConfigPath(n.config, op.path, op.value) } : n));
        break;
      case 'renameNode':
        nodes = nodes.map((n) => (n.nodeId === op.nodeId ? { ...n, name: op.name } : n));
        break;
      case 'addEdge':
        edges.push({
          edgeId: op.edgeId, sourceNodeId: op.sourceNodeId, targetNodeId: op.targetNodeId,
          ...(op.sourceOutput ? { sourceOutput: op.sourceOutput } : {}), ...(op.targetInput ? { targetInput: op.targetInput } : {}),
          ...(op.condition ? { condition: op.condition } : {}), ...(op.label ? { label: op.label } : {}),
          ...(op.triggerRule ? { triggerRule: op.triggerRule } : {}),
        });
        break;
      case 'removeEdge':
        edges = edges.filter((e) => e.edgeId !== op.edgeId);
        break;
      case 'setCondition':
        edges = edges.map((e) => {
          if (e.edgeId !== op.edgeId) return e;
          const { condition: _drop, ...rest } = e;
          return op.condition ? { ...rest, condition: op.condition } : rest;
        });
        break;
    }
  }
  return { ...head, nodes, edges };
}
