/**
 * ADR 1058 / RFC 0258 (`Draft`) — the declared, bounded refine loopback.
 *
 * A `WorkflowEdge` may carry `loopback: { on: 'refine', maxIterations, … }`. It
 * runs from an approval gate back to an ancestor of that gate, and it is the
 * ONLY edge that may close a cycle. When the gate's interrupt resolves with
 * `refine` and rounds remain, the gate's `node.completed` carries a marker
 * `{ edgeId, targetNodeId, round, rearmed }`, the gate's forward edges are not
 * released, and every node of the region (the target, the gate, and every node
 * on a forward path between them) re-runs as a new visit.
 *
 * THE MARKER IS THE RECORD. Visits, rounds and the re-arm on recovery and fork
 * are all folded from markers in the event log (`LoopbackVisits.fold`,
 * `snapshotFromEventPrefix`), never from a live counter, so a fork at round k
 * reproduces round k.
 *
 * DEFAULT OFF. `OPENWOP_BOUNDED_LOOPBACK` gates admission. With it off, a
 * `loopback` edge is refused with `capability_required`; nothing is advertised
 * until RFC 0258 is `Active` (CLAUDE.md wire-advert rule). A definition with no
 * loopback edge never folds anything and every visit is 0, so its interrupt keys
 * are byte-identical to the pre-ADR-1058 keys.
 */
import { canonicalize } from '../host/canonicalJson.js';
import {
  HISTORY_BYTES_FIELD,
  HISTORY_TRUNCATED_FIELD,
  LOOPBACK_CAPABILITY,
  LOOPBACK_EDGE_FIELD,
  LOOPBACK_MARKER_FIELD,
  LOOPBACK_MARKER_HATCH_KEY,
  LOOPBACK_MARKER_WRITE_KEY,
} from './loopbackWire.js';
import { OpenwopError } from '../types.js';
import type { EdgeDef, EdgeLoopback, WorkflowDefinition } from './types.js';
import { normalizeApprovalAction } from './interruptActions.js';

/** The host flag. Read per call so a test can flip it. */
export function isBoundedLoopbackEnabled(): boolean {
  const v = process.env.OPENWOP_BOUNDED_LOOPBACK;
  return v === 'true' || v === '1';
}

/** The host's ceiling on any edge's `maxIterations` (RFC 0258 §E). */
export const LOOPBACK_MAX_ITERATIONS_CEILING = 10;

const LOOPBACK_KEYS: ReadonlySet<string> = new Set(['on', 'maxIterations', 'onExhausted', 'historyInput']);
/** RFC 0258 §A — fields a loopback edge MUST NOT carry. */
const EXCLUDED_EDGE_FIELDS = ['condition', 'sourceOutput', 'targetInput', 'triggerRule'] as const;

const invalid = (message: string, details: Record<string, unknown> = {}): OpenwopError =>
  new OpenwopError('validation_error', message, 400, { field: 'edges', ...details });

/**
 * The ingest half: validate one edge's raw `loopback` (RFC 0258 §A) and return
 * the closed host shape. `edge` is the raw wire edge, checked for the §A
 * exclusions. Throws `capability_required` when the host flag is off.
 */
export function normalizeEdgeLoopback(raw: unknown, edge: Partial<Record<(typeof EXCLUDED_EDGE_FIELDS)[number], unknown>>, edgeId: string): EdgeLoopback {
  if (!isBoundedLoopbackEnabled()) {
    throw new OpenwopError(
      'capability_required',
      `Edge '${edgeId}' declares \`loopback\` (RFC 0258), which this host does not run. It is not run as a plain cycle and not dropped.`,
      400,
      { requiredCapability: LOOPBACK_CAPABILITY, field: `edges.${edgeId}.${LOOPBACK_EDGE_FIELD}` },
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(`edges.${edgeId}.loopback MUST be an object.`, { edgeId });
  const l = raw as Record<string, unknown>;
  for (const k of Object.keys(l)) {
    if (!LOOPBACK_KEYS.has(k)) throw invalid(`edges.${edgeId}.loopback.${k} is not a loopback field.`, { edgeId });
  }
  if (l.on !== 'refine') throw invalid(`edges.${edgeId}.loopback.on MUST be "refine".`, { edgeId });
  const max = l.maxIterations;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
    throw invalid(`edges.${edgeId}.loopback.maxIterations is REQUIRED and MUST be an integer >= 1 (there is no unlimited).`, { edgeId });
  }
  if (max > LOOPBACK_MAX_ITERATIONS_CEILING) {
    throw invalid(`edges.${edgeId}.loopback.maxIterations ${max} exceeds this host's ceiling ${LOOPBACK_MAX_ITERATIONS_CEILING}.`, { edgeId, reason: 'loopback_ceiling' });
  }
  if (l.onExhausted !== undefined && l.onExhausted !== 'withdraw' && l.onExhausted !== 'fail') {
    throw invalid(`edges.${edgeId}.loopback.onExhausted MUST be "withdraw" or "fail".`, { edgeId });
  }
  if (l.historyInput !== undefined && (typeof l.historyInput !== 'string' || l.historyInput.length === 0)) {
    throw invalid(`edges.${edgeId}.loopback.historyInput MUST be a non-empty port key.`, { edgeId });
  }
  for (const f of EXCLUDED_EDGE_FIELDS) {
    if (edge[f] !== undefined) throw invalid(`Edge '${edgeId}' is a loopback edge and MUST NOT carry \`${f}\` (RFC 0258 §A).`, { edgeId });
  }
  return {
    on: 'refine',
    maxIterations: max,
    ...(l.onExhausted !== undefined ? { onExhausted: l.onExhausted as 'withdraw' | 'fail' } : {}),
    ...(typeof l.historyInput === 'string' ? { historyInput: l.historyInput } : {}),
  };
}

/** One admitted loopback edge and its region, in `nodes[]` order. */
export interface LoopbackRegion {
  edge: EdgeDef & { loopback: EdgeLoopback };
  /** The gate (the edge's source). */
  gateNodeId: string;
  /** The re-entered node (the edge's target). */
  targetNodeId: string;
  /** Every region node, in the definition's `nodes[]` order. */
  nodes: string[];
}

/** gate node id → its loopback region. Empty when the definition has none. */
export type LoopbackPlan = ReadonlyMap<string, LoopbackRegion>;

const EMPTY_PLAN: LoopbackPlan = new Map();

function hasLoopback(e: EdgeDef): e is EdgeDef & { loopback: EdgeLoopback } {
  return e.loopback !== undefined && e.loopback !== null;
}

/** True when the edge is a declared loopback the scheduler excludes from the forward graph. */
export function isLoopbackEdge(e: EdgeDef): boolean {
  return hasLoopback(e) && isBoundedLoopbackEnabled();
}

/**
 * RFC 0258 §B — admission. Returns gate → region, or throws `validation_error`
 * for a target that is not an ancestor of the gate, an open region, a gate with
 * two loopback edges, or overlapping regions. (A forward cycle is the scheduler's
 * `cycle_detected`, unchanged.) With the flag off, or with no loopback edges,
 * returns an empty plan and changes nothing.
 */
export function planLoopbacks(definition: WorkflowDefinition): LoopbackPlan {
  const loops = (definition.edges ?? []).filter(hasLoopback);
  if (loops.length === 0 || !isBoundedLoopbackEnabled()) return EMPTY_PLAN;
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const n of definition.nodes) { forward.set(n.nodeId, []); backward.set(n.nodeId, []); }
  for (const e of definition.edges ?? []) {
    if (hasLoopback(e)) continue;
    forward.get(e.sourceNodeId)?.push(e.targetNodeId);
    backward.get(e.targetNodeId)?.push(e.sourceNodeId);
  }
  const reach = (from: string, adj: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length > 0) {
      for (const next of adj.get(queue.shift()!) ?? []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    return seen;
  };
  const order = definition.nodes.map((n) => n.nodeId);
  const plan = new Map<string, LoopbackRegion>();
  const claimed = new Map<string, string>();
  for (const edge of loops) {
    const edgeId = edge.edgeId ?? (edge as { id?: string }).id ?? '';
    const gate = edge.sourceNodeId;
    const target = edge.targetNodeId;
    if (gate === target) throw invalid(`Loopback edge '${edgeId}' MUST re-enter an upstream node, not the gate itself.`, { edgeId, reason: 'loopback_self' });
    const fromTarget = reach(target, forward);
    if (!fromTarget.has(gate)) {
      throw invalid(`Loopback edge '${edgeId}': '${target}' is not an ancestor of the gate '${gate}' (RFC 0258 §B.2).`, { edgeId, reason: 'loopback_not_ancestor' });
    }
    const toGate = reach(gate, backward);
    const region = new Set([...fromTarget].filter((id) => toGate.has(id)));
    for (const id of region) {
      if (id === gate) continue;
      for (const next of forward.get(id) ?? []) {
        if (!region.has(next)) {
          throw invalid(`Loopback edge '${edgeId}': region node '${id}' has an edge to '${next}', outside the region (RFC 0258 §B.3). Only the gate's edges may leave it.`, { edgeId, reason: 'loopback_region_open' });
        }
      }
    }
    if (plan.has(gate)) throw invalid(`Gate '${gate}' is the source of more than one loopback edge (RFC 0258 §B.4).`, { edgeId, reason: 'loopback_overlap' });
    for (const id of region) {
      const other = claimed.get(id);
      if (other !== undefined) throw invalid(`Loopback edges '${other}' and '${edgeId}' have regions sharing '${id}' (RFC 0258 §B.4).`, { edgeId, reason: 'loopback_overlap' });
      claimed.set(id, edgeId);
    }
    plan.set(gate, { edge, gateNodeId: gate, targetNodeId: target, nodes: order.filter((id) => region.has(id)) });
  }
  return plan;
}

/** The marker on the gate's `node.completed` (RFC 0258 §C.1). */
export interface LoopbackMarker {
  edgeId: string;
  targetNodeId: string;
  round: number;
  rearmed: string[];
}

/** The `node.completed` key the marker is written under (see `loopbackWire.ts`). */
export const LOOPBACK_MARKER_KEY = LOOPBACK_MARKER_WRITE_KEY;

/** Read a marker off a `node.completed` payload, or `undefined`. */
export function readLoopbackMarker(payload: unknown): LoopbackMarker | undefined {
  const p = payload as Record<string, unknown> | null | undefined;
  const m = p?.[LOOPBACK_MARKER_HATCH_KEY] ?? p?.[LOOPBACK_MARKER_FIELD];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return undefined;
  const r = m as Record<string, unknown>;
  if (typeof r.edgeId !== 'string' || typeof r.targetNodeId !== 'string' || typeof r.round !== 'number') return undefined;
  if (!Array.isArray(r.rearmed) || !r.rearmed.every((x) => typeof x === 'string')) return undefined;
  return { edgeId: r.edgeId, targetNodeId: r.targetNodeId, round: r.round, rearmed: r.rearmed as string[] };
}

/**
 * Visits and rounds, folded from markers. A node's visit is the number of
 * markers that re-armed it so far, which is interrupt.md's "how many of that
 * node's interrupts had their resolution consumed before this execution began"
 * for the gate (one refine per round), and the round number for every other
 * region node. A retry stays in its visit, because only a marker advances it.
 */
export class LoopbackVisits {
  private readonly visits = new Map<string, number>();
  private readonly rounds = new Map<string, number>();

  visitOf(nodeId: string): number { return this.visits.get(nodeId) ?? 0; }
  roundsTaken(edgeId: string): number { return this.rounds.get(edgeId) ?? 0; }

  rearm(marker: LoopbackMarker): void {
    this.rounds.set(marker.edgeId, Math.max(this.roundsTaken(marker.edgeId), marker.round));
    for (const id of marker.rearmed) this.visits.set(id, this.visitOf(id) + 1);
  }

  static fold(events: ReadonlyArray<{ type: string; nodeId?: string; payload: unknown }>): LoopbackVisits {
    const v = new LoopbackVisits();
    for (const ev of events) {
      if (ev.type !== 'node.completed') continue;
      const m = readLoopbackMarker(ev.payload);
      if (m) v.rearm(m);
    }
    return v;
  }
}

/**
 * The host's resume key for a node-supplied `ctx.suspend` key at `visit`. Visit
 * 0 is the node's key unchanged (byte-identical to every stored run); a later
 * visit appends `#v<n>`, so the durable-resolution store, the interrupt key and
 * the fork derivations never hand visit n an earlier visit's answer
 * (interrupt.md §Re-entry: a later execution MUST derive a different key).
 */
export function qualifyResumeKey(key: string, visit: number): string {
  return visit > 0 ? `${key}#v${visit}` : key;
}

/**
 * The node-facing key of a host resume key, when it belongs to `visit`; else
 * `undefined` (a resolution recorded for another visit is never served).
 */
export function nodeResumeKey(hostKey: string, visit: number): string | undefined {
  if (visit === 0) return hostKey;
  const suffix = `#v${visit}`;
  return hostKey.endsWith(suffix) ? hostKey.slice(0, -suffix.length) : undefined;
}

/** True when a resume value applies `refine` (the RFC 0183 vocabulary, ADR 0725 spellings). */
export function isRefineResolution(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as { action?: unknown; decision?: unknown };
  const raw = typeof v.action === 'string' ? v.action : typeof v.decision === 'string' ? v.decision : undefined;
  return raw !== undefined && normalizeApprovalAction(raw) === 'refine';
}

/**
 * RFC 0258 §C.4 — this host's per-entry cap, advertised as
 * `capabilities.loopback.maxHistoryEntryBytes` once the advert lands (the RFC's
 * floor is 4096).
 */
export const LOOPBACK_MAX_HISTORY_ENTRY_BYTES = 65_536;
/** RFC 0258 §C.4 — the floor a host's advertised cap may not go under. */
export const LOOPBACK_MIN_HISTORY_ENTRY_BYTES = 4096;

/**
 * RFC 0258 §C.4 — a round's recorded outputs, or the typed
 * `{ truncated: true, bytes }` marker when their JCS (RFC 8785) serialization
 * is over the cap. `canonicalize` sorts keys by UTF-16 code unit and
 * serializes with ECMAScript `JSON.stringify`, which is the JCS form for the
 * JSON values an event log holds. Computed from the recorded value only, so
 * every run, replay, fork and host yields the same entry.
 */
export function capHistoryOutputs(outputs: unknown, maxEntryBytes: number): unknown {
  const bytes = Buffer.byteLength(canonicalize(outputs), 'utf8');
  return bytes > maxEntryBytes ? { [HISTORY_TRUNCATED_FIELD]: true, [HISTORY_BYTES_FIELD]: bytes } : outputs;
}

/** One round of a loopback's history (RFC 0258 §C.4). */
export interface LoopbackHistoryEntry {
  round: number;
  /** The target's own `node.completed.outputs` from that round, or the
   *  `{ truncated: true, bytes }` marker past the cap. */
  outputs: unknown;
  /** The gate's `interrupt.resolved.refineFeedback` from that round. */
  refineFeedback?: unknown;
}

/**
 * RFC 0258 §C.4 — the round history a loopback target receives, rebuilt from
 * the run's event log, oldest first. Only recorded values: the target's outputs
 * and the gate's refine feedback for each marked round. No timestamps,
 * principals, run ids or keys, so the same rounds are the same bytes in any
 * run, replay or fork (ADR 1002: model input stays run-independent).
 */
export function rebuildLoopbackHistory(
  events: ReadonlyArray<{ type: string; nodeId?: string; payload: unknown }>,
  region: Pick<LoopbackRegion, 'gateNodeId' | 'targetNodeId'> & { edge: { edgeId: string } },
  maxEntryBytes: number = LOOPBACK_MAX_HISTORY_ENTRY_BYTES,
): LoopbackHistoryEntry[] {
  const out: LoopbackHistoryEntry[] = [];
  let lastOutputs: unknown;
  let feedback: unknown;
  for (const ev of events) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (ev.type === 'node.completed' && ev.nodeId === region.targetNodeId) {
      lastOutputs = p.outputs;
    } else if (ev.type === 'interrupt.resolved' && ev.nodeId === region.gateNodeId) {
      feedback = p.action === 'refine' ? p.refineFeedback : undefined;
    } else if (ev.type === 'node.completed' && ev.nodeId === region.gateNodeId) {
      const m = readLoopbackMarker(ev.payload);
      if (m && m.edgeId === region.edge.edgeId) {
        out.push({ round: m.round, outputs: capHistoryOutputs(lastOutputs ?? null, maxEntryBytes), ...(feedback !== undefined ? { refineFeedback: feedback } : {}) });
      }
      feedback = undefined;
    }
  }
  return out;
}
