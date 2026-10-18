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
 * WHAT CHANGED AND WHY (the ADR 0701 / ADR 0703 drain, applied to the last product
 * entry). This used to build an in-tree `WorkflowDefinition` literal and hand it to
 * the raw `registerWorkflow` registrar — the one remaining PRODUCT entry in
 * `test/workflow-pin-site-ratchet.test.ts`'s `PIN_SITE_QUARANTINE`, the shape
 * `CLAUDE.md` § "Workflows — never hard-code" forbids: a code-pinned workflow is
 * invisible to `/builder` and the `/` picker and is not tenant-editable.
 *
 * The graph now ships as `core.openwop.workflows.kicktodo-convene-turn`
 * (`examples/workflow-chain-packs/kicktodo-convene-turn`) and registers CHAIN-BACKED
 * under the SAME workflowId, so the convene tool's and the coach turn's scheduler
 * jobs (`agentTools.ts`, `kickbotCoachTurnService.ts`) and every run stamp keep
 * resolving. It is `internal: true` (ADR 0879 D9, the channel-turn precedent): it is
 * infrastructure fired with programmatic params, not a gallery template.
 *
 * The per-job values still work because `registerChainBackedWorkflow` expands with
 * `deferred: true` (RFC 0124): the chain's `parameters` become run-overridable
 * `variables[]` under their BARE names, so the node still reads
 * `{type:'variable', variableName:'agentId'}` and the job's `configurable` still
 * drives it. The single node is the terminal, so expansion marks it
 * `outputRole: 'primary'` — the role the literal declared.
 *
 * @see src/features/channels/channelTurnWorkflow.ts — the drained precedent (ADR 0703)
 * @see src/host/agentRunnerNode.ts — the gated agent-runner this wraps
 */
import { registerChainBackedWorkflow, getChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';

export const KICKTODO_CONVENE_TURN_WORKFLOW_ID = 'openwop-app.kicktodo.convene-turn';

/** The host-owned managed key a convened specialist (autonomous, zero-BYOK) runs on. */
export const KICKTODO_CONVENE_CREDENTIAL_REF = 'managed:openwop-free';

/** Register the convene turn-workflow once (idempotent — safe at every feature boot). */
export function seedKicktodoConveneTurnWorkflow(): void {
  if (!getChainBackedWorkflow(KICKTODO_CONVENE_TURN_WORKFLOW_ID)) {
    registerChainBackedWorkflow(KICKTODO_CONVENE_TURN_WORKFLOW_ID);
  }
}
