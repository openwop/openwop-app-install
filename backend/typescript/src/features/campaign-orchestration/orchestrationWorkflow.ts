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
 *  - SEQUENTIAL (default): five `core.subWorkflow` nodes chained — each channel
 *    child blocks the next. Correct, conservative, and the current default.
 *
 *  - PARALLEL (ADR 0158 §P1.5): a `core.orchestrator.supervisor` (RFC 0006) emits
 *    one `next-worker` decision naming all five channel workflow ids, and a single
 *    `core.dispatch` node fans them out concurrently with `fanOutPolicy:'parallel'`
 *    + `joinPolicy:{mode:'wait-all', onChildFailure:'collect'}` (RFC 0118). ~5×
 *    faster; one stalled channel no longer blocks the others.
 *
 * The host arm (RFC 0118 executor, openwop-app #994) has LANDED — the host now
 * advertises `capabilities.dispatch.fanOutSupported:true` and ACCEPTS the parallel
 * `core.dispatch` config at registration (proven by the "PARALLEL spine REGISTERS"
 * test). Parallel is therefore a LIVE opt-in: set `OPENWOP_CAMPAIGN_FANOUT_PARALLEL=true`
 * to make it the active spine (see `parallelFanOutEnabled()`). The default stays
 * SEQUENTIAL pending an operational decision to flip — both shapes share the same
 * workflowId, so flipping is a clean swap (existing runs snapshot their own def;
 * new runs use the active one — replay-safe).
 *
 * Selective-channel generation (only enabled channels) is the Campaign Strategist
 * agent path (ADR 0058); this spine generates the full set.
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 * @see ../openwop/RFCS/0118-parallel-subworkflow-fan-out-and-join.md
 */

import type { WorkflowDefinition } from '../../executor/types.js';
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
 * Whether the parallel channel fan-out spine is active. The host arm (RFC 0118,
 * #994) has landed — the host advertises `capabilities.dispatch.fanOutSupported:true`
 * and accepts the parallel config — so this is a LIVE opt-in, not a blocked flag.
 * Default OFF (sequential) pending an operational decision to make parallel the
 * default; set `OPENWOP_CAMPAIGN_FANOUT_PARALLEL=true` to activate.
 *
 * TODO(follow-on): once a synchronous host-capability accessor exists, read
 * `capabilities.dispatch.fanOutSupported` here so activation can track the
 * advertisement automatically (this env switch stays as an ops override).
 */
export function parallelFanOutEnabled(): boolean {
  return process.env.OPENWOP_CAMPAIGN_FANOUT_PARALLEL === 'true';
}

/** Sequential spine (the default; the asserted-stable shape). */
export const campaignOrchestrationWorkflow: WorkflowDefinition = buildOrchestration(false);
/** Parallel spine (ADR 0158 §P1.5 / RFC 0118) — live opt-in; registers against the host (#994). */
export const campaignOrchestrationParallel: WorkflowDefinition = buildOrchestration(true);

/** The registered built-in — parallel iff activated, else sequential. */
export const CAMPAIGN_ORCHESTRATION: ReadonlyArray<WorkflowDefinition> = [
  parallelFanOutEnabled() ? campaignOrchestrationParallel : campaignOrchestrationWorkflow,
];

export { ORCHESTRATION_ID };
