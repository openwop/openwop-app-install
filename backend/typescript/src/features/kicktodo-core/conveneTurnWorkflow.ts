/**
 * ADR 0442 P5 (live-convene completion) — the built-in turn-workflow a convened
 * KickTodo specialist runs on.
 *
 * When KickBot convenes a specialist (`openwop:kicktodo.convene`), the tool
 * registers a fire-now one-shot scheduler job firing THIS workflow. It is a
 * SINGLE host `agent-runner` node (the ADR 0089 node): the job's `configurable`
 * supplies `agentId` (the specialist) + `task` + a HOST-OWNED `managed:`
 * credentialRef (the specialist runs on the managed tier — no BYOK; a chat-time
 * tool is credential-less by design, OWASP/prompt-injection) + `conversationId`
 * so the specialist's advisory reply posts back into KickBot's conversation as a
 * turn (ADR 0125 Phase 2c).
 *
 * WHY a scheduler job (not a direct run): a chat-time feature tool's `BundleScope`
 * carries no run-starter deps (`storage`/`hostSuite`), so it CANNOT call
 * `startWorkflowRun` — but it CAN reach the process-global scheduler
 * (`registerJob`). This is the exact `openwop:tasks.schedule-followup` seam
 * (ADR 0309), and running a live nested sub-agent synchronously inside the tool
 * turn is a discouraged pattern (cost/blocking/recursion) — an async post-back is
 * the endorsed split.
 *
 * Reuses the existing scheduler + agent-runner + managed provider — NO parallel
 * scheduler, dispatch, or run model (the `scheduled-agent-chats`/`channels`
 * per-feature turn-workflow precedent). The specialist's read-only toolAllowlist
 * confines the LIVE turn exactly as the deterministic contract-check does, so a
 * convened specialist still cannot write domain state.
 *
 * @see src/features/scheduled-agent-chats/scheduledChatTurnWorkflow.ts — the pattern
 * @see src/host/agentRunnerNode.ts — the gated agent-runner this wraps
 */
import { registerWorkflow, getRegisteredWorkflow } from '../../host/workflowsRegistry.js';
import { AGENT_RUNNER_TYPE_ID } from '../../host/agentRunnerNode.js';
import type { WorkflowDefinition } from '../../executor/types.js';

export const KICKTODO_CONVENE_TURN_WORKFLOW_ID = 'openwop-app.kicktodo.convene-turn';

/** The host-owned managed key a convened specialist (autonomous, zero-BYOK) runs on. */
export const KICKTODO_CONVENE_CREDENTIAL_REF = 'managed:openwop-free';

const DEF: WorkflowDefinition = {
  workflowId: KICKTODO_CONVENE_TURN_WORKFLOW_ID,
  nodes: [{
    nodeId: 'run',
    typeId: AGENT_RUNNER_TYPE_ID,
    inputs: {
      agentId: { type: 'variable', variableName: 'agentId' },
      task: { type: 'variable', variableName: 'task' },
      credentialRef: { type: 'variable', variableName: 'credentialRef' },
      // Post the specialist's reply back into KickBot's conversation as a turn.
      conversationId: { type: 'variable', variableName: 'conversationId' },
    },
    outputRole: 'primary',
  }],
  variables: [
    { name: 'agentId', type: 'string', description: 'The convened specialist to run.', required: true },
    { name: 'task', type: 'string', description: 'The advisory task the specialist runs on.', required: true },
    { name: 'credentialRef', type: 'string', description: 'The host-owned managed credential (no BYOK from a chat tool).', required: false },
    { name: 'conversationId', type: 'string', description: 'KickBot conversation the advice posts into (ADR 0125 Phase 2c).', required: false },
  ],
  edges: [],
};

/** Register the convene turn-workflow once (idempotent — safe at every feature boot). */
export function seedKicktodoConveneTurnWorkflow(): void {
  if (!getRegisteredWorkflow(KICKTODO_CONVENE_TURN_WORKFLOW_ID)) registerWorkflow(DEF);
}
