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
 *
 * WHAT CHANGED AND WHY (ADR 0703). This used to build an in-tree `WorkflowDefinition`
 * literal and hand it to the RAW `registerWorkflow()` — instance #3 of the `SCWF-1`
 * class and one of the entries in `test/workflow-pin-site-ratchet.test.ts`'s
 * `PIN_SITE_QUARANTINE`, the shape `CLAUDE.md` § "Workflows — never hard-code" forbids:
 * a code-pinned workflow is invisible to `/builder` and the `/` picker and is not
 * tenant-editable.
 *
 * The graph now ships as `core.openwop.workflows.channel-turn`
 * (`examples/workflow-chain-packs/channel-turn`) and registers CHAIN-BACKED under the
 * SAME workflowId, so `channelAgentDispatch.ts`'s `startWorkflowRun` and every run
 * stamp keep resolving — the drain assistant (7→5), `workflowAuthorSeed` (5→4) and
 * scheduled-agent-chats (4→3) performed before it.
 *
 * The per-post values still work because `registerChainBackedWorkflow` expands with
 * `deferred: true` (RFC 0124): the chain's `parameters` become run-overridable
 * `variables[]` with their BARE launch-contract names restored, so the node still reads
 * `{type:'variable', variableName:'agentId'}` and the dispatch's `configurable`
 * (`channelAgentDispatch.ts:114`) still drives it per post.
 */
import { registerChainBackedWorkflow, getChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';

export const CHANNEL_TURN_WORKFLOW_ID = 'openwop-app.channel.turn';

/** The host-owned managed key a channel agent turn dispatches on (system-fired —
 *  no user/BYOK at post time, mirroring the scheduled-chat boundary). */
export const CHANNEL_MANAGED_CREDENTIAL_REF = 'managed:openwop-free';


/** Register the channel turn-workflow once (idempotent — safe at every boot). */
export function seedChannelTurnWorkflow(): void {
  if (!getChainBackedWorkflow(CHANNEL_TURN_WORKFLOW_ID)) {
    registerChainBackedWorkflow(CHANNEL_TURN_WORKFLOW_ID);
  }
}
