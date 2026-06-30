/**
 * ADR 0154 Phase 4 — the built-in channel agent-turn workflow.
 *
 * When a human posts in a channel that addresses an agent member, the channel
 * route fires a RUN of this workflow (via the shared `startWorkflowRun`). It is a
 * SINGLE core `agent-runner` node — the dispatch
 * supplies `agentId` + `task` (the post text) + a HOST-OWNED `managed:` credential
 * (the run is system-fired — no user/BYOK, the scheduled-chat boundary) + the
 * channel `conversationId`, so the agent's reply is appended AS an assistant turn
 * in that channel (the agent-runner's ADR 0125 Phase 2c projection).
 *
 * Channels-owned (no feature→feature import) but reuses the CORE agent-runner +
 * managed provider + run engine — NO parallel dispatch/run model. Registered
 * idempotently at channels feature boot.
 */
import { registerWorkflow, getRegisteredWorkflow } from '../../host/workflowsRegistry.js';
import { AGENT_RUNNER_TYPE_ID } from '../../host/agentRunnerNode.js';
import type { WorkflowDefinition } from '../../executor/types.js';

export const CHANNEL_TURN_WORKFLOW_ID = 'openwop-app.channel.turn';

/** The host-owned managed key a channel agent turn dispatches on (system-fired —
 *  no user/BYOK at post time, mirroring the scheduled-chat boundary). */
export const CHANNEL_MANAGED_CREDENTIAL_REF = 'managed:openwop-free';

const DEF: WorkflowDefinition = {
  workflowId: CHANNEL_TURN_WORKFLOW_ID,
  nodes: [{
    nodeId: 'run',
    typeId: AGENT_RUNNER_TYPE_ID,
    inputs: {
      agentId: { type: 'variable', variableName: 'agentId' },
      task: { type: 'variable', variableName: 'task' },
      credentialRef: { type: 'variable', variableName: 'credentialRef' },
      // The agent-runner posts its reply into this conversation (the channel).
      conversationId: { type: 'variable', variableName: 'conversationId' },
    },
    outputRole: 'primary',
  }],
  variables: [
    { name: 'agentId', type: 'string', description: 'The addressed agent member to run.', required: true },
    { name: 'task', type: 'string', description: 'The channel post the agent responds to.', required: true },
    { name: 'credentialRef', type: 'string', description: 'The host-owned managed credential (system-fired — no BYOK).', required: false },
    { name: 'conversationId', type: 'string', description: 'The channel the reply posts into.', required: false },
  ],
  edges: [],
};

/** Register the channel turn-workflow once (idempotent — safe at every boot). */
export function seedChannelTurnWorkflow(): void {
  if (!getRegisteredWorkflow(CHANNEL_TURN_WORKFLOW_ID)) registerWorkflow(DEF);
}
