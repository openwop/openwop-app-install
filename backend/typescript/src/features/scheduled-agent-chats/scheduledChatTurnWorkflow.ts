/**
 * ADR 0125 Phase 2b — the built-in scheduled-chat turn-workflow.
 *
 * The recurring scheduler tick fires a RUN of this workflow (ADR 0025 daemon →
 * runStarter, fire-once via claimIdempotency). It is a SINGLE `agent-runner` node
 * (the ADR 0089 node) — the tick's `configurable` supplies `agentId` + `task`
 * (the scheduled prompt) + a HOST-OWNED `managed:` credentialRef (the run is
 * autonomous — no user/BYOK exists at tick time, mirroring the widget's host-key
 * boundary). The agent runs once and records its reply as the run output; surfacing
 * that reply AS a turn in the bound conversation is the Phase 2c/3 projection.
 *
 * Reuses the existing scheduler + agent-runner + managed provider — NO parallel
 * scheduler, dispatch, or run model. Registered idempotently at feature boot.
 */
import { registerWorkflow, getRegisteredWorkflow } from '../../host/workflowsRegistry.js';
import { AGENT_RUNNER_TYPE_ID } from '../../host/agentRunnerNode.js';
import type { WorkflowDefinition } from '../../executor/types.js';

export const SCHEDULED_CHAT_TURN_WORKFLOW_ID = 'openwop-app.scheduled-chat.turn';

/** The host-owned managed key a scheduled (autonomous, zero-BYOK) run dispatches on. */
export const SCHEDULED_CHAT_CREDENTIAL_REF = 'managed:openwop-free';

// The agent-runner reads its NODE INPUTS (resolveParams), so the tick's run variables
// (populated from the job `configurable`) MUST be mapped onto the node inputs + declared
// as `variables` — mirroring the ADR-0089 @mention workflow. Without this mapping the
// node sees no `agentId` and fails ("requires an agentId").
const DEF: WorkflowDefinition = {
  workflowId: SCHEDULED_CHAT_TURN_WORKFLOW_ID,
  nodes: [{
    nodeId: 'run',
    typeId: AGENT_RUNNER_TYPE_ID,
    inputs: {
      agentId: { type: 'variable', variableName: 'agentId' },
      task: { type: 'variable', variableName: 'task' },
      credentialRef: { type: 'variable', variableName: 'credentialRef' },
      // ADR 0125 Phase 2c — targets the bound conversation so the reply posts as a turn.
      conversationId: { type: 'variable', variableName: 'conversationId' },
    },
    outputRole: 'primary',
  }],
  variables: [
    { name: 'agentId', type: 'string', description: 'The scheduled agent to run.', required: true },
    { name: 'task', type: 'string', description: 'The scheduled prompt the agent runs on.', required: true },
    { name: 'credentialRef', type: 'string', description: 'The host-owned managed credential (autonomous tick — no BYOK).', required: false },
    { name: 'conversationId', type: 'string', description: 'The bound conversation the reply posts into (ADR 0125 Phase 2c).', required: false },
  ],
  edges: [],
};

/** Register the turn-workflow once (idempotent — safe to call at every feature boot). */
export function seedScheduledChatTurnWorkflow(): void {
  if (!getRegisteredWorkflow(SCHEDULED_CHAT_TURN_WORKFLOW_ID)) registerWorkflow(DEF);
}
