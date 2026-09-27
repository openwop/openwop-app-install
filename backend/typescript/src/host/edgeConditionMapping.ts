/**
 * Edge-condition normalization — the SINGLE authority that turns any
 * edge-condition shape arriving at an ingest seam into the host executor's
 * `EdgeDef.condition {path,op,value}` (the shape `scheduler.ts evaluateCondition`
 * actually reads).
 *
 * Two shapes reach the host today:
 *   - the WIRE shape `{type,left,right}` — what `workflow-definition.schema.json`
 *     §EdgeCondition defines, so what a conformant SDK/third-party client emits;
 *   - the HOST-native shape `{path,op,value}` — what the first-party builder
 *     (`EdgeInspector.tsx`) emits and what the executor consumes directly.
 *
 * Before this module the two condition-ingest seams disagreed: chain expansion
 * (`workflowChainPackLoader.ts`) mapped wire→host, but the workflow-definition
 * register route (`validateWorkflowDefinition`) cast ANY object straight through
 * — so a wire-shaped condition registered via `POST /v1/host/openwop-app/workflows`
 * reached the executor with `path`/`op` both undefined and the edge was silently
 * DROPPED (fail-closed dead branch, no error). This unifies BOTH seams on one
 * mapper so the register route honestly honors the wire shape it advertises
 * accepting. ADR 0207 §Phase 2.
 *
 * Normalization is WRITE-TIME only (registration / authoring / chain expansion —
 * see the `validateWorkflowDefinition` callers). Stored definitions are already
 * host-shaped at rest, so this touches no in-flight run and carries no replay/
 * fork hazard; a definition registered before this fix keeps its stored shape
 * until it is re-registered.
 */
import { OpenwopError } from '../types.js';
import type { EdgeDef } from '../executor/types.js';

/** The wire edge-condition shape (workflow-definition.schema.json §EdgeCondition,
 *  RFC 0013 §edges "same shape as a top-level workflow edge"). RFC 0134 added the
 *  `truthy`/`falsy` operators (a `left` path, no `right`). */
export interface WireEdgeCondition {
  type?: 'expression' | 'equals' | 'notEquals' | 'contains' | 'regex' | 'truthy' | 'falsy';
  left?: string;
  right?: unknown;
  expression?: string;
}

type HostCondition = NonNullable<EdgeDef['condition']>;
type HostOp = HostCondition['op'];

/** Wire condition `type` → host `op`. Only the operators this host actually
 *  evaluates are mappable; `expression` and `regex` have no host op and are
 *  rejected fail-closed (honest — the host does not evaluate them, so an edge
 *  using them must not silently ship as one that never fires). RFC 0134:
 *  `truthy`/`falsy` map to the identically-named host ops (already in `HOST_OPS`),
 *  so a chain fragment can now express a boolean-gate branch (the F2 unblock for the
 *  approval-gate + reject-safe-barrier pattern — ADR 0472). They carry no `right`;
 *  `mapEdgeCondition` still requires `left` for them (a truthy/falsy edge missing
 *  `left` is `chain_edge_condition_invalid`, never a silently dead edge). */
const WIRE_OP: Partial<Record<NonNullable<WireEdgeCondition['type']>, HostOp>> = {
  equals: 'eq',
  notEquals: 'neq',
  contains: 'contains',
  truthy: 'truthy',
  falsy: 'falsy',
};

/** The host ops `evaluateCondition` understands (scheduler.ts). */
const HOST_OPS: ReadonlySet<HostOp> = new Set<HostOp>([
  'eq',
  'neq',
  'truthy',
  'falsy',
  'exists',
  'contains',
]);

/** Map a WIRE `{type,left,right}` condition to the host `{path,op,value}` shape.
 *  Throws `chain_edge_condition_unsupported` for `expression`/`regex` (no host
 *  op) and `chain_edge_condition_invalid` for a missing/empty `left` path. */
export function mapEdgeCondition(c: WireEdgeCondition, edgeRef: string): HostCondition {
  const op = c.type ? WIRE_OP[c.type] : undefined;
  if (!op) {
    throw new OpenwopError(
      'validation_error',
      `chain_edge_condition_unsupported: edge ${edgeRef} uses condition type '${c.type ?? 'missing'}' — this host evaluates only equals/notEquals/contains/truthy/falsy on chain edges.`,
      400,
      { edge: edgeRef, type: c.type },
    );
  }
  if (typeof c.left !== 'string' || c.left.length === 0) {
    throw new OpenwopError(
      'validation_error',
      `chain_edge_condition_invalid: edge ${edgeRef} condition needs a non-empty 'left' path.`,
      400,
      { edge: edgeRef },
    );
  }
  // RFC 0134: `truthy`/`falsy` take NO `right` — a host MUST ignore a stray one, so
  // drop it rather than carry an inert `value` (the executor's truthy/falsy op ignores
  // it anyway; dropping keeps the stored condition clean + unambiguously spec-compliant).
  const carriesValue = c.right !== undefined && op !== 'truthy' && op !== 'falsy';
  return { path: c.left, op, ...(carriesValue ? { value: c.right } : {}) };
}

/** Normalize ANY edge-condition shape at an ingest seam to the host
 *  `{path,op,value}`. Discriminates:
 *    - host-native `{path,op,value?}` → pass through (first-party builder emits this);
 *    - wire `{type,left,right?}`      → `mapEdgeCondition`;
 *    - anything else                  → reject fail-closed (never a silently-dead edge).
 *  This is the ONE mapper both condition-ingest seams route through. */
export function normalizeEdgeCondition(raw: unknown, edgeRef: string): HostCondition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpenwopError(
      'validation_error',
      `chain_edge_condition_invalid: edge ${edgeRef} condition MUST be an object.`,
      400,
      { edge: edgeRef },
    );
  }
  const c = raw as Record<string, unknown>;
  // Host-native shape — discriminated by `op`/`path` (absent from the wire shape).
  if ('op' in c || 'path' in c) {
    if (typeof c.op !== 'string' || !HOST_OPS.has(c.op as HostOp)) {
      throw new OpenwopError(
        'validation_error',
        `chain_edge_condition_invalid: edge ${edgeRef} uses unknown op '${String(c.op)}' — host ops are ${[...HOST_OPS].join('/')}.`,
        400,
        { edge: edgeRef },
      );
    }
    if (typeof c.path !== 'string' || c.path.length === 0) {
      throw new OpenwopError(
        'validation_error',
        `chain_edge_condition_invalid: edge ${edgeRef} condition needs a non-empty 'path'.`,
        400,
        { edge: edgeRef },
      );
    }
    return { path: c.path, op: c.op as HostOp, ...('value' in c ? { value: c.value } : {}) };
  }
  // Wire shape (or unknown — `mapEdgeCondition` rejects it fail-closed).
  return mapEdgeCondition(c as WireEdgeCondition, edgeRef);
}
