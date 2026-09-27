# ADR 0364 — Workflow-builder real-time collaboration: Yjs over the DAG store (ADR 0361 Phase 3)

Status: Accepted (2026-07-13) — Phase 1 (transport-independent binding) lands
now; Phases 2–4 are gated (see the phase table's named gates).

## Context

ADR 0361 reserved the builder's collab composition point without faking it:
the zustand DAG store has no Yjs binding, and ADR 0359's bindings serve
trait-shaped canvas docs. What exists today:

- **Transport (canvas-coupled end-to-end):** the ADR 0359 WebSocket serves
  `/v1/host/openwop-app/canvas-collab/:canvasId`; joins authorize via
  `getCanvasForTenant`; the registry (`collabRegistry.ts`) keys on
  `canvasTypeId` with derive-into-`host.canvas` semantics. A workflow room
  needs a RESOURCE generalization of that seam (route, authz, snapshot
  persistence, derive target).
- **Durable authority:** ADR 0163's tenant-scoped
  `/v1/host/openwop-app/workflows` index (write-through; localStorage demoted
  to offline cache) owns the EDITED graph; the engine registration owns RUNS.
- **Binding:** `canvas/collabDocBinding.ts` pairs collection items by
  reference-sharing + POSITIONAL fallback — correct for id-less canvas
  elements, WRONG for a DAG: workflow nodes/edges carry stable ids
  (`n_*`/`e_*`), edges reference node ids, and positional pairing mis-pairs
  concurrent same-index insertions (one user's field edit lands on another
  user's node).
- **Timing:** the canvas-collab transport is mid-canary (WS ticket auth
  #1782–#1785); all collab toggles are OFF product-wide (a product decision).

## Decision

1. **Phase 1 (now, transport-independent):** extend `collabDocBinding` with an
   ADDITIVE `idKey` pairing mode — when a collection spec names an `idKey`,
   items pair by that stable id (delete/insert/update derived from id
   diffing); absent, today's reference+positional behavior is byte-identical.
   Ship the workflow shape (`builder/collab/workflowCollabShape.ts`:
   `nodes`/`edges` collections with `idKey: 'id'`; `name`/`defaultInputs`/
   `inputSchema` as root scalars) + convergence tests (two `Y.Doc`s,
   concurrent node move + edge add + rename → identical materialization,
   identity preserved). This is the ADR 0359 pattern: the binding proved by
   convergence tests before any room exists.
2. **Phase 2 (gated):** generalize the transport's resource seam — a
   `CollabResource` abstraction over {canvas, workflow}: route
   `/v1/host/openwop-app/workflow-collab/:workflowId`, authz = tenant
   ownership via the ADR 0163 index, snapshot persistence + lease/fan-out
   REUSED from `collabRoom` (extend, never fork), derive target = the
   ADR 0163 workflow row (the D2 posture: REST saves lock/derive while a
   room lives; the CRDT snapshot is authoritative). Toggle gate = 
   `realtime-collab` × `workflow-builder` at the socket.
3. **Phase 3 (gated):** the builder store⇄binding adapter goes LIVE — store
   mutations route through `binding.set/replace`, per-user `Y.UndoManager`
   replaces the snapshot stack while a room lives (solo path unchanged),
   presence on nodes (the D5 row-marker pattern).
4. **Phase 4:** toggle flip — a product decision, not engineering.

## Wire/RFC

None. The transport stays a non-normative host extension (the ADR 0359
precedent); no run-event, capability advert, or endpoint-contract change.

## Alternatives considered

- **Implement the transport now** — rejected: `host/collab/` is mid-canary
  (#1782–#1785); extending it to a second resource kind while its auth/canary
  posture is actively stabilizing is drift-on-purpose, for capability that
  stays OFF anyway.
- **ADR-only (defer the binding too)** — rejected: the binding slice has no
  real gate; deferring it is scope-cutting. It also de-risks the one NOVEL
  piece (id-keyed DAG pairing) with pure, convergence-tested code.
- **A separate workflow-collab transport** — rejected: a second
  room/lease/fan-out stack is the parallel-architecture smell; Phase 2
  extends the ONE transport behind a resource seam.
- **Positional pairing as-is for workflows** — rejected: concurrent
  same-index node insertions cross-wire field edits between users' nodes;
  edges referencing node ids make identity errors user-visible.

## Phases

| Phase | Scope | Gate |
|---|---|---|
| 1 | `idKey` pairing in `collabDocBinding` (additive) + `workflowCollabShape` + convergence tests | FE suite (lands now) |
| 2 | Transport resource seam ({canvas, workflow}), workflow room authz/persist/derive | **canvas-collab canary verified live** + coordinated with the collab session |
| 3 | Store adapter live: binding-routed mutations, per-user undo swap, node presence | Phase 2 + builder parity pins |
| 4 | Toggle flip | **product decision** (all collab toggles OFF by design) |

## Versioning note (Track B of the Phase-3 plan)

Canvas-style version history for workflows stays a recorded TRIGGER, not
work: build it (own ADR) only on a real demand signal — a user asking for
workflow history/compare, or a destructive-edit incident. The ADR 0163 row +
CRDT snapshot make it additive when triggered.
