/**
 * ADR 0773 B.2 — the tools a Pair turn is offered.
 *
 * The Workflow Architect's pack allowlist serves three surfaces (the main chat,
 * the builder's Pair tab, and anywhere else it is scoped to), and the ADR 0315
 * default-on baseline is unioned onto it. A Pair turn needs four of those
 * seventeen tools; the other thirteen cost ~3.6k prompt tokens on EVERY round of
 * the tool loop (MEASURED from source, 2026-10-03), which is what pushed a first
 * draft past the managed tier's 50,000-token daily cap. Two of them (`persist`,
 * `propose`) would also write a workflow WITHOUT the ghost-layer review that
 * `suggest-edits` exists for.
 *
 * The Pair context route records this as the conversation's ADR 0132 capability
 * scope, intersected with any scope already there, so it only ever NARROWS: the
 * resolver drops an id the agent lacks, and the main chat keeps its full set.
 *
 * Why `validate` is not here: `suggest-edits` already validates the applied
 * candidate closed-world and acyclic (`editOps.ts`), and returns `invalid_ops`.
 * Why `get` is not here: `read-canvas` is how a Pair turn reads the open workflow.
 */
export const PAIR_TOOL_SCOPE: readonly string[] = [
  'openwop:feature.builder-pair.nodes.read-canvas',
  'openwop:feature.builder-pair.nodes.suggest-edits',
  'openwop:feature.workflow-author.nodes.draft',
  'openwop:schema.lookup',
];
