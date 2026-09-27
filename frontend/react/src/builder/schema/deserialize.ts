/**
 * Canonical WorkflowDefinition → builder graph (inverse of serialize.ts).
 *
 * Accepts the authoring/example shape used by `examples/*` and by the
 * registry chain-pack compositions:
 *   nodes: { id, typeId, name?, position?, config? }
 *   edges: { id?, sourceNodeId, targetNodeId, sourceOutput?, targetInput?,
 *            triggerRule?, condition?, label? }
 * and the backend shape (`nodeId` instead of `id`).
 *
 * Each node's `typeId` is resolved to a catalog `kind`; edges that omit
 * ports inherit the node's first catalog port (canonical edges usually
 * carry no port names — see serialize.ts, which omits the default
 * `out`/`in`). Throws `CanonicalParseError` naming the offending typeIds
 * when a node kind isn't installed on this host (so the import fails
 * loudly rather than dropping nodes silently).
 */

import { catalogEntryByTypeId } from '../palette/catalogRegistry.js';
import i18n from '../../i18n/index.js';
import type { NodeCatalogEntry } from '../palette/nodeCatalog.js';
import type {
  BuilderEdge,
  BuilderNode,
  EdgeCondition,
  EdgeTriggerRule,
} from './workflow.js';

export class CanonicalParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalParseError';
  }
}

interface CanonicalNode {
  id?: string;
  nodeId?: string;
  typeId?: string;
  name?: string;
  position?: { x?: number; y?: number };
  config?: Record<string, unknown>;
  /** RFC 0065 advisory — read back so a round trip preserves it (ADR 0440 P1). */
  outputRole?: 'primary' | 'secondary';
  /** NOTIF-UX-3 — run-time input bindings; read back for the same reason. */
  inputs?: Record<string, unknown>;
  /** RFC 0151 §B (chain-reachable via RFC 0157) — the node's inverse action;
   *  read back so a builder round trip cannot delete it. */
  compensation?: Record<string, unknown>;
  /** RFC 0151 §B UQ4 — "this effect has no inverse"; read back likewise. */
  irreversibleEffect?: boolean;
}

interface CanonicalEdge {
  id?: string;
  edgeId?: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  sourceOutput?: string;
  targetInput?: string;
  triggerRule?: string;
  condition?: EdgeCondition;
  label?: string;
}

interface CanonicalDefinition {
  workflowId?: string;
  id?: string;
  name?: string;
  /** OpenWOP WorkflowDefinition carries the display name here (builder-authored
   *  defs omit it — the name lives in the SavedWorkflow/ownership record); pack-
   *  instantiated templates set `metadata.name` = the template label. */
  metadata?: { name?: unknown };
  nodes?: CanonicalNode[];
  edges?: CanonicalEdge[];
  defaultInputs?: unknown;
  /** RFC 0124 variable declarations — carried verbatim, NOT default inputs. */
  variables?: unknown;
  configurableSchema?: unknown;
  /** ADR 0197 — run-input form schema; round-trips into SavedWorkflow.inputSchema. */
  inputSchema?: unknown;
}

const TRIGGER_RULES: ReadonlySet<string> = new Set<EdgeTriggerRule>([
  'all_success',
  'any_success',
  'all_complete',
  'none_failed',
  'any_failed',
]);

/** True when `obj` looks like a canonical WorkflowDefinition (nodes carry
 *  a `typeId`) rather than a builder SavedWorkflow (nodes carry `kind`).
 *  Lets the import path pick a parser without guessing. */
export function looksCanonical(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const nodes = (obj as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return false;
  const first = nodes[0] as Record<string, unknown> | null;
  return Boolean(first) && typeof first!.typeId === 'string' && typeof first!.kind !== 'string';
}

export interface DeserializeResult {
  name: string;
  nodes: BuilderNode[];
  edges: BuilderEdge[];
  defaultInputs: string;
  /** Pretty-printed JSON string, or '' when the definition has none. */
  inputSchema: string;
  /** RFC 0124 variable declarations, carried verbatim (see SavedWorkflow). */
  variables?: unknown;
  /** RFC 0124 bare-param aliases, carried verbatim. */
  configurableSchema?: unknown;
}

// Simple grid layout for nodes that arrive without a position.
function autoPosition(index: number): { x: number; y: number } {
  const COLS = 4;
  return { x: (index % COLS) * 220, y: Math.floor(index / COLS) * 140 };
}

function normalizeInputSchema(def: CanonicalDefinition): string {
  const v = def.inputSchema;
  if (v && typeof v === 'object' && !Array.isArray(v)) return JSON.stringify(v, null, 2);
  return '';
}

function normalizeDefaultInputs(def: CanonicalDefinition): string {
  // §Correction 2026-08-03 — the `?? def.variables` fallback used to live here.
  // `variables` is an ARRAY of RFC 0124 declarations, not a default-input object;
  // stringifying it into the textarea labelled "Default inputs (JSON)" showed the
  // author the wrong thing AND was the only place it survived, so a save dropped
  // it. It now round-trips as `SavedWorkflow.variables`, which is what it is.
  const candidate = def.defaultInputs;
  if (typeof candidate === 'string') return candidate;
  if (candidate && typeof candidate === 'object') {
    return JSON.stringify(candidate, null, 2);
  }
  return '{}';
}

export function fromCanonicalDefinition(input: unknown): DeserializeResult {
  const def = (input && typeof input === 'object' ? input : {}) as CanonicalDefinition;
  const rawNodes = Array.isArray(def.nodes) ? def.nodes : [];
  if (rawNodes.length === 0) {
    throw new CanonicalParseError(i18n.t('builder:errDefinitionNoNodes'));
  }

  const entryByNodeId = new Map<string, NodeCatalogEntry>();
  const unresolved: string[] = [];
  const nodes: BuilderNode[] = [];

  rawNodes.forEach((n, i) => {
    const id = n.id ?? n.nodeId;
    const typeId = n.typeId;
    if (!id || !typeId) {
      throw new CanonicalParseError(i18n.t('builder:errNodeMissingIdOrTypeId', { index: i }));
    }
    const entry = catalogEntryByTypeId(typeId);
    if (!entry) {
      unresolved.push(typeId);
      return;
    }
    entryByNodeId.set(id, entry);
    const pos =
      n.position && typeof n.position.x === 'number' && typeof n.position.y === 'number'
        ? { x: n.position.x, y: n.position.y }
        : autoPosition(i);
    nodes.push({
      id,
      kind: entry.kind,
      name: n.name ?? entry.label,
      position: pos,
      config: n.config && typeof n.config === 'object' ? { ...n.config } : {},
      // Same class as `outputRole` below, found 2026-08-03: the host persists
      // `node.inputs` and the builder dropped it on every save.
      ...(n.inputs && typeof n.inputs === 'object' && !Array.isArray(n.inputs)
        ? { inputs: { ...n.inputs } }
        : {}),
      // ADR 0440 P1 — read the RFC 0065 advisory back. `BuilderNode` has always
      // modelled `outputRole` and `serialize` has always emitted it, but import
      // dropped it, so a builder round trip silently cleared the author's
      // "this is the primary deliverable" hint.
      ...(n.outputRole === 'primary' || n.outputRole === 'secondary' ? { outputRole: n.outputRole } : {}),
      // NOTIF-UX-3 — same failure as `outputRole` above, one field over: without
      // this the bindings never reach the builder, so saving destroys them.
      ...(n.inputs && typeof n.inputs === 'object' && !Array.isArray(n.inputs)
        ? { inputs: { ...n.inputs } }
        : {}),
      // RFC 0151 §B / RFC 0157 — read the inverse action back. `serialize` can
      // only emit what the builder holds, so this half is what actually stops a
      // save from deleting a chain-declared compensator.
      ...(n.compensation && typeof n.compensation === 'object' && !Array.isArray(n.compensation)
        ? { compensation: { ...n.compensation } }
        : {}),
      // RFC 0151 §B UQ4 — read "no inverse" back.
      ...(typeof n.irreversibleEffect === 'boolean' ? { irreversibleEffect: n.irreversibleEffect } : {}),
    });
  });

  if (unresolved.length > 0) {
    const uniq = [...new Set(unresolved)];
    throw new CanonicalParseError(
      i18n.t('builder:errCantLoadNodeTypes', { count: uniq.length, types: uniq.join(', ') }),
    );
  }

  const rawEdges = Array.isArray(def.edges) ? def.edges : [];
  const edges: BuilderEdge[] = rawEdges.map((e, i) => {
    const source = e.sourceNodeId ?? '';
    const target = e.targetNodeId ?? '';
    const srcEntry = entryByNodeId.get(source);
    const tgtEntry = entryByNodeId.get(target);
    const edge: BuilderEdge = {
      id: e.id ?? e.edgeId ?? `e_${i}`,
      source,
      sourcePort: e.sourceOutput ?? srcEntry?.outputs[0]?.name ?? 'out',
      target,
      targetPort: e.targetInput ?? tgtEntry?.inputs[0]?.name ?? 'in',
    };
    if (e.triggerRule && TRIGGER_RULES.has(e.triggerRule)) {
      edge.triggerRule = e.triggerRule as EdgeTriggerRule;
    }
    if (e.condition) edge.condition = e.condition;
    if (e.label) edge.label = e.label;
    return edge;
  });

  // Prefer a top-level `name`, then the OpenWOP `metadata.name` (where pack-
  // instantiated templates carry their label), and only then the import fallback
  // — otherwise every backend-loaded template opened "Imported workflow".
  const metaName = typeof def.metadata?.name === 'string' ? def.metadata.name : '';
  const name = (typeof def.name === 'string' && def.name.trim())
    ? def.name
    : (metaName.trim() ? metaName : i18n.t('builder:importedWorkflow'));

  return {
    name,
    nodes,
    edges,
    defaultInputs: normalizeDefaultInputs(def),
    inputSchema: normalizeInputSchema(def),
    ...(def.variables !== undefined ? { variables: def.variables } : {}),
    ...(def.configurableSchema !== undefined ? { configurableSchema: def.configurableSchema } : {}),
  };
}
