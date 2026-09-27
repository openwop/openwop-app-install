/**
 * The parent campaign orchestration workflow (ADR 0158 Phase 2 + §P1.5) — the
 * declarative spine that ties Campaign Studio together. Registered via
 * `BackendFeature.builtinWorkflows` (restart-safe, cross-instance — the ADR 0072
 * precedent).
 *
 *   validate → kernel → kernel-approve → [channel fan-out] → consistency → finalize
 *
 * Every node keys on the `briefId` variable (the shared state), so the executor's
 * cross-node data-flow vocabulary is sufficient — no {connection} wiring needed.
 *
 * TWO channel fan-out shapes, selected at registration by `parallelFanOutEnabled()`:
 *
 *  - PARALLEL (ADR 0158 §P1.5 — the default on this host): a
 *    `core.orchestrator.supervisor` (RFC 0006) emits one `next-worker` decision
 *    naming all five channel workflow ids, and a single `core.dispatch` node fans
 *    them out concurrently with `fanOutPolicy:'parallel'` +
 *    `joinPolicy:{mode:'wait-all', onChildFailure:'collect'}` (RFC 0118). ~5×
 *    faster; one stalled channel no longer blocks the others.
 *
 *  - SEQUENTIAL: five `core.subWorkflow` nodes chained — each channel child
 *    blocks the next. The conservative fallback for hosts that do not advertise
 *    `dispatch.fanOutSupported`, and the forced shape under the ops kill-switch.
 *
 * RFC 0118 is Accepted and the host arm (openwop-app #994) landed — the host
 * advertises `capabilities.dispatch.fanOutSupported:true` — so the default now
 * DERIVES from that advertisement (`dispatchCapability()`, the single source of
 * truth). `OPENWOP_CAMPAIGN_FANOUT_PARALLEL` stays as a two-way ops override
 * ('true' forces parallel, 'false' forces sequential). Both shapes share the same
 * workflowId, so the swap is clean (existing runs snapshot their own def; new
 * runs use the active one — replay-safe).
 *
 * Selective-channel generation (only enabled channels) is the Campaign Strategist
 * agent path (ADR 0058); this spine generates the full set.
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 * @see ../openwop/RFCS/0118-parallel-subworkflow-fan-out-and-join.md
 */

import type { WorkflowDefinition } from '../../executor/types.js';
import { dispatchCapability } from '../../host/dispatchFanOut.js';
import { CHANNEL_WORKFLOW_IDS } from '../campaign-channels/channelWorkflows.js';

const VALIDATE = 'feature.campaign-brief.nodes.validate';
const KERNEL = 'feature.campaign-brief.nodes.generate-kernel';
const APPROVE = 'core.approvalGate';
const SUBFLOW = 'core.subWorkflow';
const SUPERVISOR = 'core.orchestrator.supervisor';
const DISPATCH = 'core.dispatch';
const CONSISTENCY = 'feature.campaign-orchestration.nodes.consistency-check';
const FINALIZE = 'feature.campaign-orchestration.nodes.finalize';

const ORCHESTRATION_ID = 'campaign-studio.campaign-orchestration';
const briefIdInput = { briefId: { type: 'variable', variableName: 'briefId' } } as const;

type Node = { nodeId: string; typeId: string; config?: Record<string, unknown>; inputs?: Record<string, unknown>; outputRole?: 'primary' | 'secondary' };

function linearEdges(nodeIds: readonly string[]): Array<{ edgeId: string; sourceNodeId: string; targetNodeId: string }> {
  const edges = [];
  for (let i = 1; i < nodeIds.length; i++) edges.push({ edgeId: `e${i}`, sourceNodeId: nodeIds[i - 1]!, targetNodeId: nodeIds[i]! });
  return edges;
}

const prefixNodes: Node[] = [
  { nodeId: 'validate', typeId: VALIDATE, inputs: { ...briefIdInput } },
  { nodeId: 'kernel', typeId: KERNEL, inputs: { ...briefIdInput } },
  { nodeId: 'kernel-approve', typeId: APPROVE, config: { prompt: 'Review the messaging kernel — the foundation every channel echoes.', title: 'Approve the messaging kernel?' } },
];
const suffixNodes: Node[] = [
  // ADR 0356 P1 — the ADR 0172-designed post-merge slot: production planning
  // runs over the merged channel set, BEFORE the consistency check. The node
  // SKIPS honestly (success + skipped:true) when the production toggle is off,
  // so the spine is safe unconditionally; finalize links the persisted plan.
  { nodeId: 'production-plan', typeId: 'feature.production.nodes.plan-generate', inputs: { ...briefIdInput } },
  { nodeId: 'consistency', typeId: CONSISTENCY, inputs: { ...briefIdInput } },
  { nodeId: 'finalize', typeId: FINALIZE, inputs: { ...briefIdInput }, outputRole: 'primary' },
];

// ── SEQUENTIAL channel fan-out: 5 chained core.subWorkflow nodes ──
function channelNode(workflowId: string): Node {
  return {
    nodeId: workflowId.replace('campaign-studio.channel.', 'sw-'),
    typeId: SUBFLOW,
    config: { workflowId, waitForCompletion: true, onChildFailure: 'absorb', inputMapping: { briefId: 'briefId' } },
  };
}

// ── PARALLEL channel fan-out (RFC 0118): supervisor decision → core.dispatch ──
const supervisorNode: Node = {
  nodeId: 'channel-supervisor',
  typeId: SUPERVISOR,
  config: {
    mockDispatchPlan: [
      { kind: 'next-worker', nextWorkerIds: [...CHANNEL_WORKFLOW_IDS] },
      { kind: 'terminate', reason: 'channels-dispatched' },
    ],
  },
};
const dispatchNode: Node = {
  nodeId: 'channel-dispatch',
  typeId: DISPATCH,
  config: {
    workerDispatchModel: 'child-run',
    fanOutPolicy: 'parallel',
    joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' },
    inputMapping: { briefId: 'briefId' },
  },
};

function buildOrchestration(parallel: boolean): WorkflowDefinition {
  const channel: Node[] = parallel ? [supervisorNode, dispatchNode] : CHANNEL_WORKFLOW_IDS.map(channelNode);
  const nodes: Node[] = [...prefixNodes, ...channel, ...suffixNodes];
  return {
    workflowId: ORCHESTRATION_ID,
    nodes,
    edges: linearEdges(nodes.map((n) => n.nodeId)),
    variables: [{ name: 'briefId', type: 'string', description: 'The confirmed campaign brief to orchestrate.', required: true }],
    metadata: {
      kind: 'campaign-orchestration',
      feature: 'campaign-orchestration',
      fanOut: parallel ? 'parallel' : 'sequential',
      parallelUpgrade: 'RFC-0118',
    },
  };
}

/**
 * Whether the parallel channel fan-out spine is active. The default now tracks
 * the host's own advertisement (`dispatchCapability().fanOutSupported`, the
 * RFC 0118 single source of truth) — the "one config flip" ADR 0158 §P1.5
 * promised, taken once RFC 0118 reached Accepted and the host arm (#994) landed.
 *
 * `OPENWOP_CAMPAIGN_FANOUT_PARALLEL` remains as a two-way ops override:
 * `'true'` forces parallel, `'false'` forces sequential (the kill-switch for a
 * live service), unset follows the capability.
 */
export function parallelFanOutEnabled(): boolean {
  const override = process.env.OPENWOP_CAMPAIGN_FANOUT_PARALLEL;
  if (override === 'true') return true;
  if (override === 'false') return false;
  return dispatchCapability().fanOutSupported;
}

/** Sequential spine — the fallback shape (capability-absent hosts / ops kill-switch). */
export const campaignOrchestrationWorkflow: WorkflowDefinition = buildOrchestration(false);
/** Parallel spine (ADR 0158 §P1.5 / RFC 0118) — the default on this host (#994). */
export const campaignOrchestrationParallel: WorkflowDefinition = buildOrchestration(true);

/** The registered built-in — parallel iff activated, else sequential. */
export const CAMPAIGN_ORCHESTRATION: ReadonlyArray<WorkflowDefinition> = [
  parallelFanOutEnabled() ? campaignOrchestrationParallel : campaignOrchestrationWorkflow,
];

export { ORCHESTRATION_ID };
