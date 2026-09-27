/**
 * Builder graph → backend WorkflowDefinition.
 *
 * The backend executor is a DAG scheduler (see
 * `backend/.../executor/scheduler.ts`). Branching, fan-in, conditional
 * routing, and parallel paths are all supported. The serializer
 * emits the canonical `{ workflowId, nodes, edges }` shape with a
 * stable topological ordering for replay-friendly diffs.
 *
 * Rejected at serialize time:
 *   - empty graphs
 *   - cycles (Kahn's algorithm — finds the first reachable cycle node)
 *   - nodes unreachable from any source node
 */

import { catalogEntry } from '../palette/catalogRegistry.js';
import i18n from '../../i18n/index.js';
import type {
  BuilderEdge,
  BuilderNode,
  EdgeCondition,
  EdgeTriggerRule,
  SavedWorkflow,
} from './workflow.js';

export interface BackendNode {
  nodeId: string;
  typeId: string;
  config?: Record<string, unknown>;
  /** RFC 0065 — author hint that this terminal node's output is the
   *  workflow's primary deliverable. Forwarded verbatim to the BE
   *  workflow-definition row so consumers (chat-surface, run-detail,
   *  third-party hosts) can pick the canonical artifact deterministically.
   *  Engine MUST NOT depend on the value (advisory). */
  outputRole?: 'primary' | 'secondary';
  /** NOTIF-UX-3 — per-node run-time input bindings, forwarded verbatim. REQUIRED
   *  on `WorkflowNode` in the wire schema; the builder dropped it entirely, so a
   *  save stripped every `{{params.*}}` binding the definition carried. */
  inputs?: Record<string, unknown>;
  /** RFC 0151 §B (reachable from a chain via RFC 0157) — the node's inverse
   *  action, forwarded verbatim. The host validator accepts and persists it, so
   *  not emitting it here is a save that deletes it. */
  compensation?: Record<string, unknown>;
  /** RFC 0151 §B UQ4 — "this effect has no inverse", forwarded verbatim. */
  irreversibleEffect?: boolean;
}

export interface BackendEdge {
  edgeId: string;
  sourceNodeId: string;
  sourceOutput?: string;
  targetNodeId: string;
  targetInput?: string;
  /** Default `all_success` per spec. Emitted only when not the default. */
  triggerRule?: EdgeTriggerRule;
  condition?: EdgeCondition;
  label?: string;
}

export interface BackendWorkflowDefinition {
  workflowId: string;
  /** ADR 0197 — JSON Schema for the run-input form. The backend validates the
   *  shape (object) and preserves it verbatim (workflowDefinitionValidation);
   *  RunsIndexPage renders it via SchemaInputForm. Emitted only when the
   *  author's draft parses to an object. */
  inputSchema?: Record<string, unknown>;
  /** RFC 0124 variable declarations + bare-param aliases, carried verbatim.
   *  Declared because `serializeWorkflow` EMITS them — a return type that denies
   *  fields the function produces means a typed consumer cannot read them, and
   *  the conditional spread keeps tsc quiet about the omission. */
  variables?: unknown;
  configurableSchema?: unknown;
  nodes: BackendNode[];
  /** Emitted whenever the graph has at least one edge. Linear (one-source,
   *  one-sink, single-chain) workflows still emit edges so the backend
   *  scheduler can route consistently. */
  edges: BackendEdge[];
}

export class SerializeError extends Error {
  constructor(message: string, readonly nodeId?: string) {
    super(message);
    this.name = 'SerializeError';
  }
}

/**
 * Kahn's algorithm. Returns a topological ordering (one of possibly
 * many). When a cycle exists, returns `{ cycleNodeId }` naming a node
 * still inside the residual cycle.
 */
function topoSort(
  nodes: ReadonlyArray<BuilderNode>,
  edges: ReadonlyArray<BuilderEdge>,
): { order: BuilderNode[] } | { cycleNodeId: string } {
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const outgoing = new Map<string, BuilderEdge[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
    outgoing.get(e.source)?.push(e);
  }
  // Stable seed: sort starting nodes by Y then X so layout reflects ordering.
  const ready: BuilderNode[] = nodes
    .filter((n) => (indegree.get(n.id) ?? 0) === 0)
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
  const order: BuilderNode[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  while (ready.length > 0) {
    const current = ready.shift();
    if (!current) break;
    order.push(current);
    const out = outgoing.get(current.id) ?? [];
    // Deterministic neighbor ordering by target node position.
    const neighbors = [...new Set(out.map((e) => e.target))]
      .map((id) => byId.get(id))
      .filter((n): n is BuilderNode => Boolean(n))
      .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
    for (const n of neighbors) {
      const d = (indegree.get(n.id) ?? 0) - 1;
      indegree.set(n.id, d);
      if (d === 0) ready.push(n);
    }
  }
  if (order.length !== nodes.length) {
    // Any node still with indegree > 0 is on or downstream of a cycle.
    const stuck = nodes.find((n) => (indegree.get(n.id) ?? 0) > 0);
    return { cycleNodeId: stuck?.id ?? nodes[0]?.id ?? '' };
  }
  return { order };
}

/**
 * Serialize result that also exposes the builder-node-id → backend-node-id
 * map. The live-execution overlay needs it to paint run status onto the canvas,
 * since run events carry the backend `nodeId`.
 *
 * Since ADR 0440 P1 the emitted id is the builder id VERBATIM wherever it can go
 * on the wire, so this is usually an identity map. It is still required: the
 * `safeUniqueNodeId` fallback re-derives an id for file-imported nodes whose ids
 * are arbitrary JSON, and for the collision case — and in exactly those cases
 * the overlay would mis-paint without the translation.
 */
export interface SerializeResult {
  definition: BackendWorkflowDefinition;
  /** builder BuilderNode.id → backend node.nodeId */
  builderIdToBackend: Record<string, string>;
  /** backend node.nodeId → builder BuilderNode.id (inverse, for overlay) */
  backendIdToBuilder: Record<string, string>;
}

/** ADR 0197 — publish the author's schema draft only once it parses to a
 *  plain object; a half-typed draft (or an array/scalar) is simply omitted. */
function parseInputSchema(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The wire's node-id pattern (`workflowDefinitionValidation.ts` NODE_ID_PATTERN). */
const WIRE_NODE_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * The node id to emit (ADR 0440 P1). Preserves `builderId` — it IS the id the
 * definition was loaded with — so a builder round trip stops renaming nodes out
 * from under the run history that references them.
 *
 * Falls back to the legacy `${safeKind}_${i}` shape ONLY when the id can't go on
 * the wire (a file import carries arbitrary JSON ids) or would duplicate one
 * already emitted, so the uniqueness + validity guarantee the unconditional
 * regeneration used to provide is kept without its destructiveness.
 */
function safeUniqueNodeId(builderId: string, kind: string, index: number, used: Set<string>): string {
  if (WIRE_NODE_ID.test(builderId) && builderId.length <= 64 && !used.has(builderId)) return builderId;
  const safeKind = kind.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
  let candidate = `${safeKind}_${index}`;
  for (let n = 2; used.has(candidate); n += 1) candidate = `${safeKind}_${index}_${n}`;
  return candidate;
}

export function serializeWorkflow(wf: SavedWorkflow): BackendWorkflowDefinition {
  return serializeWithIdMap(wf).definition;
}

export function serializeWithIdMap(wf: SavedWorkflow): SerializeResult {
  // Strip client-only nodes (sticky notes, future annotation kinds) before
  // any validation: they have no inputs/outputs by construction, so the
  // reachability check below would flag them as orphans. They persist on
  // the builder canvas + in localStorage; they just don't reach the
  // backend definition or the runtime executor.
  const executableNodes = wf.nodes.filter((n) => !catalogEntry(n.kind)?.clientOnly);
  const executableEdges = wf.edges; // Edges can't touch sticky notes — they have no ports.
  if (executableNodes.length === 0) {
    throw new SerializeError(
      wf.nodes.length === 0
        ? i18n.t('builder:errWorkflowNoNodes')
        : i18n.t('builder:errWorkflowNoExecutableNodes'),
    );
  }
  const wfExec: SavedWorkflow = { ...wf, nodes: executableNodes, edges: executableEdges };
  return serializeExecutable(wfExec);
}

function serializeExecutable(wf: SavedWorkflow): SerializeResult {
  if (wf.nodes.length === 0) {
    throw new SerializeError(i18n.t('builder:errWorkflowNoNodes'));
  }

  // Verify every edge references known nodes before topo-sorting.
  const nodeIds = new Set(wf.nodes.map((n) => n.id));
  for (const e of wf.edges) {
    if (!nodeIds.has(e.source)) {
      throw new SerializeError(i18n.t('builder:errEdgeUnknownSource', { edgeId: e.id }), e.source);
    }
    if (!nodeIds.has(e.target)) {
      throw new SerializeError(i18n.t('builder:errEdgeUnknownTarget', { edgeId: e.id }), e.target);
    }
  }

  // Topological sort serves two purposes here: cycle detection (a
  // cycle returns `{cycleNodeId}` instead of an order) and as the
  // historical source of the nodeId index. Keep the cycle check;
  // drop the topo order as the index source — see the comment on
  // `backendNodes` below for why.
  const sortResult = topoSort(wf.nodes, wf.edges);
  if ('cycleNodeId' in sortResult) {
    throw new SerializeError(
      i18n.t('builder:errWorkflowCycle', { nodeId: sortResult.cycleNodeId }),
      sortResult.cycleNodeId,
    );
  }

  // Reachability check: every node MUST be reachable from at least one source
  // (a node with no incoming edges). Topo-sort returning order.length ===
  // nodes.length already proves there's no cycle, but doesn't catch isolated
  // sub-graphs. With a single shared source set walk, we can flag orphans.
  if (wf.nodes.length > 1) {
    const incoming = new Map<string, number>(wf.nodes.map((n) => [n.id, 0]));
    for (const e of wf.edges) incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
    const sources = wf.nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0);
    if (sources.length === 0) {
      // Should be unreachable because topo would have flagged the cycle, but
      // defensive — surfaces clearly if the algorithm changes.
      throw new SerializeError(i18n.t('builder:errWorkflowNoSourceNodes'));
    }
    // BFS from all sources.
    const outgoing = new Map<string, string[]>(wf.nodes.map((n) => [n.id, []]));
    for (const e of wf.edges) outgoing.get(e.source)?.push(e.target);
    const reachable = new Set<string>();
    const queue = sources.map((s) => s.id);
    while (queue.length) {
      const cur = queue.shift();
      if (!cur || reachable.has(cur)) continue;
      reachable.add(cur);
      for (const t of outgoing.get(cur) ?? []) if (!reachable.has(t)) queue.push(t);
    }
    if (reachable.size !== wf.nodes.length) {
      const orphan = wf.nodes.find((n) => !reachable.has(n.id));
      throw new SerializeError(
        orphan
          ? i18n.t('builder:errNodeDisconnected', { name: orphan.name })
          : i18n.t('builder:errNodesDisconnected'),
        orphan?.id,
      );
    }
  }

  // Map builder nodes → backend nodes via the catalog. Backend nodeId
  // pattern is [a-zA-Z0-9_-]{1,64}; we synthesize from the catalog
  // kind + the FE-authored position. We deliberately DO NOT use the
  // topological ordering as the index source: topo position is
  // unstable across fan-out branch interleavings, so a workflow
  // displayed as
  //   1 Start · 2 Prepare · 3 Critic 1 · 4 Summary 1 · 5 Critic 2 ...
  // would serialize Critic 1 as `chat_2` (FE index) under FE-order
  // but as `chat_2` OR `chat_3` (etc.) under topo-order — the BE
  // scheduler interleaves Critic 1 with Critic 2 / Critic 3 since
  // all three are simultaneously ready after Prepare completes. The
  // bubble's step list (`useChatSession.ts`'s `nodeNames` map) keys
  // off FE position; if serialize.ts uses a different position the
  // bubble misses the corresponding `node.completed` event and rows
  // never tick over to ✓. The BE scheduler does its own topo sort
  // from edges, so pre-sorted node order in the payload is purely
  // informational — preserving FE order costs nothing on the runtime
  // and fixes the step-list drift.
  // ADR 0440 P1 — PRESERVE the incoming nodeId. This used to regenerate every
  // id as `${safeKind}_${i}`, so opening a workflow and touching anything (the
  // autosave is a 1.5s debounce — no explicit Save) silently renamed `t1…t5` to
  // `ui_walkthrough_step_0…`. Runs re-resolve their definition by id with NO
  // per-run snapshot (ADR 0369; the DELETE route refuses deletion for exactly
  // this reason), so historical run events then referenced node ids no longer in
  // the definition — and the walkthrough funnel keys `stalledByNode` off them.
  //
  // `BuilderNode.id` already IS the incoming backend nodeId (deserialize.ts sets
  // `n.id ?? n.nodeId`), and builder-created ids are `n_<8 hex>`, so both normal
  // sources already satisfy the wire pattern. Sanitization is retained ONLY as a
  // fallback for file imports, whose ids are arbitrary JSON.
  const usedNodeIds = new Set<string>();
  const backendNodes: BackendNode[] = wf.nodes.map((n, i) => {
    const entry = catalogEntry(n.kind);
    if (!entry) {
      throw new SerializeError(i18n.t('builder:errUnknownNodeKind', { kind: n.kind }), n.id);
    }
    const nodeId = safeUniqueNodeId(n.id, entry.kind, i, usedNodeIds);
    usedNodeIds.add(nodeId);
    return {
      nodeId,
      typeId: entry.typeId,
      ...(Object.keys(n.config).length > 0 ? { config: n.config } : {}),
      ...(n.inputs && Object.keys(n.inputs).length > 0 ? { inputs: n.inputs } : {}),
      ...(n.outputRole !== undefined ? { outputRole: n.outputRole } : {}),
      // NOTIF-UX-3 — emit the run-time input bindings back. Omitted when empty so
      // a builder-authored node (which has no bindings) keeps the shape it had.
      ...(n.inputs && Object.keys(n.inputs).length > 0 ? { inputs: n.inputs } : {}),
      // RFC 0151 §B / RFC 0157 — emit the inverse action back. The host validator
      // accepts and persists `compensation`, so omitting it here made every
      // builder save delete the compensator on a chain-instantiated workflow.
      ...(n.compensation && Object.keys(n.compensation).length > 0 ? { compensation: n.compensation } : {}),
      // RFC 0151 §B UQ4 — emit "no inverse" back. Boolean, so the emptiness test
      // used above would be wrong here: `false` is a value the author wrote.
      ...(n.irreversibleEffect !== undefined ? { irreversibleEffect: n.irreversibleEffect } : {}),
    };
  });

  // Build a map from builder-node-id → backend-node-id so edges resolve.
  const builderIdToBackend = new Map<string, string>(
    wf.nodes.map((n, i) => [n.id, backendNodes[i]!.nodeId]),
  );

  const backendEdges: BackendEdge[] = wf.edges.map((e) => {
    const sourceNodeId = builderIdToBackend.get(e.source);
    const targetNodeId = builderIdToBackend.get(e.target);
    if (!sourceNodeId || !targetNodeId) {
      // Already validated above; defensive.
      throw new SerializeError(i18n.t('builder:errEdgeBackendIdResolution', { edgeId: e.id }), e.source);
    }
    const out: BackendEdge = {
      edgeId: e.id,
      sourceNodeId,
      targetNodeId,
    };
    if (e.sourcePort && e.sourcePort !== 'output' && e.sourcePort !== 'out') {
      out.sourceOutput = e.sourcePort;
    }
    if (e.targetPort && e.targetPort !== 'input' && e.targetPort !== 'in') {
      out.targetInput = e.targetPort;
    }
    if (e.triggerRule && e.triggerRule !== 'all_success') out.triggerRule = e.triggerRule;
    if (e.condition) out.condition = e.condition;
    if (e.label) out.label = e.label;
    return out;
  });

  const backendIdToBuilder: Record<string, string> = {};
  for (const [builderId, backendId] of builderIdToBackend) {
    backendIdToBuilder[backendId] = builderId;
  }

  const inputSchema = parseInputSchema(wf.inputSchema);
  return {
    definition: {
      workflowId: wf.id,
      nodes: backendNodes,
      edges: backendEdges,
      ...(inputSchema ? { inputSchema } : {}),
      // Def-level companions of `node.inputs` — `validateWorkflowDefinition`
      // accepts both, and the deferred-mode variable refs inside `node.inputs`
      // are meaningless without the declarations they resolve against.
      ...(wf.variables !== undefined ? { variables: wf.variables } : {}),
      ...(wf.configurableSchema !== undefined ? { configurableSchema: wf.configurableSchema } : {}),
    },
    builderIdToBackend: Object.fromEntries(builderIdToBackend),
    backendIdToBuilder,
  };
}
