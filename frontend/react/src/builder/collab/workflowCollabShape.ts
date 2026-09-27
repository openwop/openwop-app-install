/**
 * Workflow collab shape (ADR 0364 Phase 1) — the `CollabDocShape` projecting a
 * `SavedWorkflow` graph into a Y.Doc via the ONE binding
 * (`canvas/collabDocBinding`): `nodes` and `edges` are ID-KEYED collections
 * (`n_*`/`e_*` — edges reference node ids, so pairing MUST follow identity,
 * never position); `name`/`defaultInputs`/`inputSchema` ride the root map as
 * scalars.
 *
 * TRANSPORT-INDEPENDENT by design: no room, socket, or toggle references —
 * Phases 2–3 (the resource seam + the live store adapter with the per-user
 * undo swap) are gated in the ADR (canvas-collab canary + the collab product
 * decision). Convergence is pinned by `__tests__/workflowCollab.test.ts`.
 *
 * Type-only import: `collabDocBinding` statically imports yjs and MUST be
 * dynamic-imported by runtime consumers (the module's bundle note); a type
 * import erases at compile time and keeps yjs out of eager chunks.
 *
 * Known limitation (inherited, documented in the binding): an array REORDER
 * rebuilds the non-LIS items, losing their CRDT identity for concurrently
 * in-flight peer field edits. Benign for workflows — node/edge array order is
 * not semantic (position is a field; the builder store appends) — but a
 * Phase-3 adapter MUST NOT introduce order-normalizing writes (e.g. sorting
 * nodes by id before commit), which would turn every commit into a reorder.
 */
import type { CollabDocShape } from '../../canvas/collabDocBinding.js';

export const WORKFLOW_COLLAB_SHAPE: CollabDocShape = {
  collections: [
    { key: 'nodes', idKey: 'id' },
    { key: 'edges', idKey: 'id' },
    // ADR 0524 — declared as a COLLECTION, not a root scalar. `variables` is an
    // array, and as a scalar it would be whole-object last-writer-wins: two
    // peers editing different variables, one silently loses. Keyed on `name`
    // (RFC 0124 variable declarations have no `id`), it converges per-variable.
    // A rename reads as delete+create, which is acceptable for a declaration
    // list. `configurableSchema` stays a scalar below because it is a plain
    // object edited as a unit — the same semantics `inputSchema` already has.
    { key: 'variables', idKey: 'name' },
  ],
};

/** The SavedWorkflow fields the binding carries (the graph + its scalars);
 *  `id`/`version`/timestamps stay REST-owned (the ADR 0163 row), never in
 *  the room — a peer must not be able to rewrite the document's identity. */
export const WORKFLOW_COLLAB_FIELDS = [
  'nodes', 'edges', 'name', 'defaultInputs', 'inputSchema',
  // ADR 0524 — allowlist #7. This list was written for ADR 0364 when
  // `SavedWorkflow` had no such fields; ADR 0523 P1 added them and nothing
  // compared the two lists, so a peer's variable edits never reached another
  // peer and the last scalar write erased them. That is this ADR's own root
  // cause — a type says a field exists while a hand-maintained allowlist drops
  // it — recurring in a site the ADR never counted. Now ratcheted (see
  // `node-field-contract-parity.test.ts`).
  'variables', 'configurableSchema',
] as const;

/** Project the room-carried slice of a SavedWorkflow-shaped object. */
export function workflowCollabSlice(wf: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of WORKFLOW_COLLAB_FIELDS) {
    if (wf[k] !== undefined) out[k] = wf[k];
  }
  return out;
}
