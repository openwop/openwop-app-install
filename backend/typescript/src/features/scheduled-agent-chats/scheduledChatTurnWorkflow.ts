/**
 * ADR 0125 Phase 2b — the scheduled-chat turn-workflow, CHAIN-BACKED (ADR 0701).
 *
 * The recurring scheduler tick fires a RUN of this workflow (ADR 0025 daemon →
 * runStarter, fire-once via claimOnce). It is a SINGLE `agent-runner` node (the ADR
 * 0089 node) — the tick's `configurable` supplies `agentId` + `task` (the scheduled
 * prompt) + a HOST-OWNED `managed:` credentialRef (the run is autonomous — no
 * user/BYOK exists at tick time, mirroring the widget's host-key boundary).
 *
 * WHAT CHANGED AND WHY (ADR 0701). This used to build an in-tree
 * `WorkflowDefinition` literal and hand it to the RAW `registerWorkflow()` at feature
 * boot — one of the four entries in `test/workflow-pin-site-ratchet.test.ts`'s
 * `PIN_SITE_QUARANTINE`, and the shape `CLAUDE.md` § "Workflows — never hard-code"
 * forbids: a code-pinned workflow is invisible to `/builder` and the `/` picker (both
 * list only the tenant ownership index) and is not tenant-editable.
 *
 * The graph now ships as `core.openwop.workflows.scheduled-chat-turn`
 * (`examples/workflow-chain-packs/scheduled-chat-turn`) and is registered under the
 * SAME workflowId, so every existing scheduler job row, every `workflowId` dispatch
 * (`agentTools.ts`, `scheduledChatService.ts`) and every run stamp keeps resolving —
 * the drain `features/assistant/{loops,actionExecution}.ts` performed before it.
 *
 * WHY THE PER-FIRE VALUES STILL WORK: `registerChainBackedWorkflow` expands with
 * `deferred: true` (RFC 0124), which materializes the chain's `parameters` as
 * run-overridable `variables[]` and then RESTORES the bare launch-contract names —
 * so the node still reads `{type:'variable', variableName:'agentId'}` and the tick's
 * `configurable` still drives it per fire. Verified against the built definition, not
 * assumed: bare `agentId`/`task`/`credentialRef`/`conversationId` in both
 * `variables[]` and the node's `inputs`.
 *
 * Reuses the existing scheduler + agent-runner + managed provider — NO parallel
 * scheduler, dispatch, or run model. Registered idempotently at feature boot.
 */
import { registerChainBackedWorkflow, getChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';

/** Stable id — ALSO the `chainId`, which is what keeps resolve-by-id identical across
 *  the migration (`host/index.ts` catalog source A asks `getChainBackedWorkflow`). */
export const SCHEDULED_CHAT_TURN_WORKFLOW_ID = 'openwop-app.scheduled-chat.turn';

/** The host-owned managed key a scheduled (autonomous, zero-BYOK) run dispatches on. */
export const SCHEDULED_CHAT_CREDENTIAL_REF = 'managed:openwop-free';

/** Register the turn-workflow once (idempotent — safe to call at every feature boot). */
export function seedScheduledChatTurnWorkflow(): void {
  if (!getChainBackedWorkflow(SCHEDULED_CHAT_TURN_WORKFLOW_ID)) {
    registerChainBackedWorkflow(SCHEDULED_CHAT_TURN_WORKFLOW_ID);
  }
}
