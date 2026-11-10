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
 * ADR 0773 OQ4, answered: the catalog `role:"gate"` does not REPLACE this list,
 * it is UNIONED with it (`isApprovalGateTypeId` below). `nodeRoleMap()` reads pack
 * manifests only, so a host-registered gate (`core.approvalGate`, `core.interrupt`)
 * has no role and needs this list. A pack's gate needs nothing here: its manifest
 * `role:"gate"` is enough, whether the pack is first-party, an adopter's
 * or registry-installed. Before the union, seven first-party pack gates
 * and every adopter or registry gate were false negatives.
 *
 * Add-only: a manifest can make a node a gate, never stop one being a gate. A
 * pack that declares `core.approvalGate` with `role:"pure"` changes nothing.
 *
 * Conservative by design: a false positive only means a human confirms a keep;
 * a false negative would let an auto-keep edit a gate. So an unreadable pack
 * directory answers "gate" for everything, not "gate" for nothing.
 *
 * Do not add a PACK node to this list: declare `role:"gate"` in its manifest.
 * `test/adr0773-gate-set-from-manifests.test.ts` pins the list at nine entries.
 */
import { nodeRoleMap } from './nodeCatalogBuilder.js';

export const APPROVAL_GATE_TYPE_IDS: ReadonlySet<string> = new Set([
  'core.approvalGate',
  'core.interrupt',
  'core.chat.approvalGate',
  'core.hitl.approval-request',
  'core.hitl.ask-user',
  'core.hitl.form-request',
  'kanban.board.review',
  // ADR 0942 D5 — the campaign autonomy gate (approval lane decided by the policy).
  'feature.campaign-orchestration.nodes.autonomy-gate',
  // ADR 0950 P2 — the experiment promotion gate (the same ADR 0942 decision).
  'feature.experiments.nodes.policy-gate',
]);

/**
 * The ONE gate predicate: the static host list ∪ every loaded pack manifest's
 * `role:"gate"` node. A `@version` suffix is ignored. Call this, not
 * `APPROVAL_GATE_TYPE_IDS.has`, wherever a decision depends on "is this a gate".
 */
export function isApprovalGateTypeId(typeId: string): boolean {
  const bare = typeId.replace(/@.*$/, '');
  if (APPROVAL_GATE_TYPE_IDS.has(bare)) return true;
  try {
    return nodeRoleMap().get(bare) === 'gate';
  } catch {
    return true; // fail closed: an unreadable pack dir must not un-gate anything
  }
}
