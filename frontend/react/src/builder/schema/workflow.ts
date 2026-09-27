/**
 * Builder-side workflow types.
 *
 * The backend executor is a DAG scheduler (see
 * `backend/.../executor/scheduler.ts`). The builder stores a graph
 * (nodes + edges) for the visual editor; the serializer emits the
 * canonical `{ workflowId, nodes, edges }` shape per `spec/v1/
 * workflow-definition.schema.json`. Branching, fan-in, conditional
 * routing, and parallel paths are all supported. Cycles still reject.
 */

export type PortType = 'any' | 'string' | 'number' | 'boolean' | 'object';

export type NodeCategory = 'flow' | 'data' | 'ai' | 'control' | 'integration';

/** Identifier for a palette entry. Static catalog uses friendly slugs
 *  ('noop', 'delay'); pack-derived entries use the full typeId
 *  ('core.openwop.http.fetch'). Either way it's an opaque string the
 *  catalog resolves to a NodeCatalogEntry. */
export type BuilderNodeKind = string;

export interface PortDef {
  name: string;
  type: PortType;
}

export interface BuilderNode {
  id: string;
  kind: BuilderNodeKind;
  /** User-visible label, defaults to the catalog entry label. */
  name: string;
  position: { x: number; y: number };
  /** Node-kind-specific configuration. Mirrors backend node.config. */
  config: Record<string, unknown>;
    /** RFC 0065 — author hint that this terminal node's output is the
   *  workflow's primary deliverable. Advisory: engine ignores the
   *  value; tooling (chat-surface completion cards, run-detail page)
   *  uses it to pick which of N terminal nodes' outputs to surface as
   *  the canonical artifact. Mirrors the wire-level `outputRole` field
   *  on `WorkflowNode` per `schemas/workflow-definition.schema.json`. */
  outputRole?: 'primary' | 'secondary' | undefined;
  /** NOTIF-UX-3 — per-node input BINDINGS (`{"query": "{{params.query}}"}`), the
   *  values `tokenSubstitution` resolves at RUN time. `inputs` is a REQUIRED
   *  field on `WorkflowNode` in `schemas/workflow-definition.schema.json`, but
   *  `BuilderNode` had no home for it, so import dropped it and export could not
   *  emit what it never held: opening a parameterised workflow and saving it
   *  silently stripped every binding. Worse than it sounds — per ADR 0507 an
   *  absent param does not fail loudly, it freezes to `''` and the node SUCCEEDS
   *  on empty input, so the damage surfaces as a plausible-looking run.
   *
   *  Exactly the defect `outputRole` above had (ADR 0440 P1), one field over.
   *  Preserved verbatim rather than modelled: the builder has no editor for
   *  bindings, and round-tripping something you cannot edit is the whole job. */
  inputs?: Record<string, unknown> | undefined;
  /** RFC 0151 §B — the node's inverse action, reachable from a chain via RFC
   *  0157. Same class as `inputs` above, one field over, and the third time this
   *  exact defect has been found: the builder has no editor for a compensator,
   *  so without a home here import drops it and export cannot emit what it never
   *  held — opening a chain-instantiated workflow and saving it would silently
   *  delete the author's declared undo.
   *
   *  That failure is WORSE than the `inputs` one it mirrors. A dropped binding
   *  eventually surfaces as a bad run; a dropped compensator surfaces only when
   *  something has already gone wrong and the unwind reports a clean `none` for
   *  a run that committed real effects.
   *
   *  Preserved VERBATIM rather than modelled — round-tripping what you cannot
   *  edit is the whole job. */
  compensation?: Record<string, unknown> | undefined;
  /** RFC 0151 §B UQ4 — the author's statement that this node's effect has NO
   *  inverse. Round-tripped for the same reason as `compensation`: silently
   *  dropping it lets the §D rollup claim a full undo. */
  irreversibleEffect?: boolean | undefined;
}

/** When a target node has multiple incoming edges, this rule controls
 *  when the target fires. Matches `WorkflowEdge.triggerRule` in
 *  spec/v1/workflow-definition.schema.json. */
export type EdgeTriggerRule =
  | 'all_success'   // wait for every upstream to complete successfully (default)
  | 'any_success'   // fire on the first upstream success
  | 'all_complete'  // wait for every upstream to terminate regardless of outcome
  | 'none_failed'   // fire only if every upstream succeeded (no failures)
  | 'any_failed';   // fire only on an upstream failure (error-routing)

export interface EdgeCondition {
  /** Dotted path into the source's output. */
  path: string;
  op: 'eq' | 'neq' | 'truthy' | 'falsy' | 'exists' | 'contains';
  /** Comparison value (omitted for `truthy`/`falsy`/`exists`). */
  value?: unknown;
}

export interface BuilderEdge {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
  /** Fan-in semantics for the target node. Default `all_success`. */
  triggerRule?: EdgeTriggerRule;
  /** Optional condition predicate. When set, the edge fires only when
   *  the predicate matches the source's output. */
  condition?: EdgeCondition | undefined;
  /** Optional human-readable label rendered on the edge. */
  label?: string | undefined;
}

export interface SavedWorkflow {
  id: string;
  name: string;
  version: string;
  nodes: BuilderNode[];
  edges: BuilderEdge[];
  /** User-provided default inputs (JSON string) for the first node. */
  defaultInputs?: string;
  /** Optional JSON Schema (raw JSON string) describing the run-input form
   *  (ADR 0197). Serialized to `definition.inputSchema` when parseable. */
  inputSchema?: string;
  /**
   * RFC 0124 deferred-mode variable DECLARATIONS, carried VERBATIM.
   *
   * Coupled to `BuilderNode.inputs` and must move with it: deferred expansion
   * rewrites whole-value input tokens to `{type:'variable',variableName}` refs
   * that resolve against the bag seeded from `definition.variables[]`. Preserving
   * the refs while dropping the declarations leaves them resolving to `undefined`
   * — the same silent failure, better camouflaged. `ui/RunInputsForm` also renders
   * from this, so dropping it EMPTIED the run-inputs form.
   */
  variables?: unknown;
  /** RFC 0124 bare-param aliases, carried VERBATIM for the same reason. */
  configurableSchema?: unknown;
  createdAt: string;
  updatedAt: string;
  /** ADR 0369 — carried VERBATIM through load→persist so the debounced
   *  autosave can never accidentally promote a draft (a save that dropped
   *  the flag would clear `transient` on the backend).
   *
   *  This is a BUILDER-OWNED hoist of `metadata.lifecycle`: the builder's own
   *  promote/archive verbs write it, so on save it overlays {@link metadata}.
   *  Exactly one writer — see `mergeDefinitionMetadata` in backendStore. */
  lifecycle?: { transient?: boolean; generatedBy?: string };
  /** ADR 0440 P1 — the loaded definition's `metadata` object, carried VERBATIM
   *  so a builder round trip cannot destroy keys the builder does not model.
   *
   *  Generalizes the `lifecycle` fix above: that ADR 0369 field hoisted ONE
   *  metadata key because dropping it silently promoted drafts. The same defect
   *  applied to every other key — `walkthrough: true` was being erased by any
   *  autosave, which un-registered a walkthrough from
   *  `ctx.features.walkthroughs.listWalkthroughs` while the page still listed it.
   *
   *  Ownership is two-tier: `name` and `lifecycle` are BUILDER-owned (the user
   *  renames; the builder promotes/archives) and overlay this object on save;
   *  every other key is author/server-owned and is neither invented nor dropped. */
  metadata?: Record<string, unknown>;
}
