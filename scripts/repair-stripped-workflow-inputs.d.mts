// Types for repair-stripped-workflow-inputs.mjs. The implementation stays plain
// ESM JavaScript because `scripts/*.mjs` are run directly by node (no build
// step); this declaration exists so the vitest suite importing it is fully typed
// — an untyped .mjs import resolves to `any`, which is banned in this repo.

export interface RepairNode {
  /**
   * The node identity, `nodeId` — the SAME field `preserveDroppedFields` keys
   * its restoration on (`executor/types.ts:403`).
   *
   * §Correction: this was declared `id`, which no WorkflowDefinition node has.
   * A declaration that names a field the runtime does not have does not fail to
   * compile — it makes the WRONG code typecheck, which is how the repair shipped
   * writing one node's inputs onto every node.
   */
  nodeId: string;
  typeId?: string;
  inputs?: Record<string, unknown>;
}

export interface RepairDefinition {
  workflowId?: string;
  nodes?: RepairNode[];
  variables?: unknown[];
  configurableSchema?: unknown;
}

export interface RepairHead {
  workflowId: string;
  definition: RepairDefinition;
  /** The `host_ext_kv` row key, when the caller read one. */
  key?: string;
  /**
   * The row's value EXACTLY as read, retained for the compare-and-swap on
   * write. Declared because the IO shell sets it — an undeclared field the
   * runtime depends on is a declaration that lies by omission.
   */
  raw?: string;
}

export interface RepairRevision {
  workflowId: string;
  /** Durable per-workflow order. NOT `createdAt`, which ties at ms resolution. */
  seq?: number;
  revisionHash?: string;
  definition: RepairDefinition;
  /**
   * The field contract the writer of this revision DECLARED (ADR 0524 Phase E).
   * A latest revision declaring `inputs` means an empty head is deliberate, and
   * `planRepair` refuses to touch it.
   */
  declaredFields?: string[];
}

export interface RepairPlan {
  workflowId: string;
  /** The revision the values came from, for the audit trail. */
  fromRevision: string | null;
  restoredNodes: number;
  fields: string[];
  definition: RepairDefinition;
}

/** The most recent revision that ACTUALLY carried inputs (by `seq`), or null. */
export declare function pickRepairSource(revisions: RepairRevision[]): RepairRevision | null;

/**
 * Plan the repair for ONE head, or null when there is nothing to do.
 *
 * Refuses to act when the head already carries inputs on any node, when no
 * revision has values to restore, or — per node — when the node's `typeId`
 * changed, because inputs are shaped for a specific node schema.
 */
export declare function planRepair(head: RepairHead, revisions: RepairRevision[]): RepairPlan | null;

/** Plan the whole population. Pure: no IO, no clock, no randomness. */
export declare function planAll(heads: RepairHead[], revisions: RepairRevision[]): RepairPlan[];

/**
 * Render the plan. Refuses on an empty population rather than reporting
 * "nothing to repair", which a wrong DSN would otherwise produce.
 */
export declare function formatPlan(
  plans: Array<Pick<RepairPlan, 'workflowId' | 'restoredNodes' | 'fields' | 'fromRevision'>>,
  heads: number,
  applied: boolean,
): string;
