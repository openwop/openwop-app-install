/**
 * Synthetic agent-mention workflow — ADR 0089 Phase 4 (Option B).
 *
 * A one-node workflow that wraps the `local.openwop-app.agent-runner` node so a
 * tool-bearing @mentioned agent's tool loop runs as a STANDARD persisted run
 * (dispatched via the normal `/v1/runs` / `startWorkflowRun` path) and is
 * embedded in chat as a `workflow_run` bubble. No bespoke run primitive — it is
 * a plain `WorkflowDefinition`, resolved by the catalog like the other built-in
 * `openwop-app.*` synthetic workflows, so replay/fork/observability are inherited.
 *
 * The `agentId` + `task` (and the optional BYOK `provider` / `model` /
 * `credentialRef`) are workflow VARIABLES seeded from the run inputs and threaded
 * into the agent-runner node via `{type:'variable'}` input declarations — the
 * `notebooks.summarize` precedent.
 *
 * @see src/host/agentRunnerNode.ts — the gated agent-runner this wraps
 * @see docs/adr/0089-chat-driven-agent-tool-loop.md §3-4 (Option B) + §8 plan
 */

import type { WorkflowDefinition } from '../executor/types.js';
import { AGENT_RUNNER_TYPE_ID } from './agentRunnerNode.js';

export const AGENT_MENTION_WORKFLOW_ID = 'openwop-app.agent-mention';

export const agentMentionWorkflowDefinition: WorkflowDefinition = {
  workflowId: AGENT_MENTION_WORKFLOW_ID,
  nodes: [
    {
      nodeId: 'run',
      typeId: AGENT_RUNNER_TYPE_ID,
      inputs: {
        agentId: { type: 'variable', variableName: 'agentId' },
        task: { type: 'variable', variableName: 'task' },
        provider: { type: 'variable', variableName: 'provider' },
        model: { type: 'variable', variableName: 'model' },
        credentialRef: { type: 'variable', variableName: 'credentialRef' },
      },
      outputRole: 'primary',
    },
  ],
  variables: [
    { name: 'agentId', type: 'string', description: 'The @mentioned manifest agent to run as a deep investigation.', required: true },
    { name: 'task', type: 'string', description: 'The user task/question the agent should investigate.', required: true },
    { name: 'provider', type: 'string', description: 'Optional BYOK provider to run the agent on (else the managed tier).', required: false },
    { name: 'model', type: 'string', description: 'Optional BYOK model id.', required: false },
    { name: 'credentialRef', type: 'string', description: 'Optional BYOK credential ref for the run.', required: false },
  ],
  metadata: { kind: 'agent-mention', adr: '0089' },
};

/**
 * The run `configurable` for a deep-investigation dispatch. A non-managed BYOK
 * `credentialRef` MUST be registered here so `prepareRunSecrets` resolves it into
 * the nested run's secret scope (the AI adapter's `resolveCredential` reads it);
 * passing it only via `inputs` leaves a BYOK run throwing `byok_required_but_unresolved`.
 * A managed ref (`managed:*`) needs no secret, so the configurable stays empty.
 */
export function agentMentionConfigurable(credentialRef?: string): Record<string, unknown> {
  return credentialRef && !credentialRef.startsWith('managed:')
    ? { credentialRefs: [credentialRef] }
    : {};
}
