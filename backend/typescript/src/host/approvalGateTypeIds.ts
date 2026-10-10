/**
 * ADR 0773 (Architect review A9) — the ONE host list of node typeIds that are
 * human approval / interrupt gates.
 *
 * Before this module the set lived only as scattered literals
 * (`host/workflowTemplates.ts`, `host/approverResolution.ts`,
 * `features/campaign-orchestration/orchestrationWorkflow.ts`) and as private
 * constants inside the ADR 0582 witness tests. The builder-pair suggestion lane
 * needs it at RUN time: an AI edit that touches a gate, or an edge incident to
 * one, is `gateSensitive` and is never auto-kept — the ADR 0582 invariant that
 * an effect must not quietly route around an approval.
 *
 * `nodeRoleMap()` (`host/nodeCatalogBuilder.ts`) cannot serve this yet: it reads
 * pack manifests only, so host-registered gates resolve to `unclassified`
 * (ADR 0773 OQ4 records whether the catalog `role:"gate"` should replace this).
 *
 * Conservative by design: a false positive only means a human confirms a keep;
 * a false negative would let an auto-keep edit a gate.
 */
export const APPROVAL_GATE_TYPE_IDS: ReadonlySet<string> = new Set([
  'core.approvalGate',
  'core.interrupt',
  'core.chat.approvalGate',
  'core.hitl.approval-request',
  'core.hitl.ask-user',
  'core.hitl.form-request',
  'kanban.board.review',
]);
