/**
 * The parent campaign orchestration workflow (ADR 0158 Phase 2 + §P1.5):
 *
 *   validate → kernel → kernel-approve → channel-supervisor → channel-dispatch
 *     → production-plan → consistency → finalize
 *
 * The workflow IS the `campaign-orchestration` chain pack
 * (`examples/workflow-chain-packs/campaign-orchestration/pack.json`), registered
 * chain-backed under its stable id by `registerLegacyDefsChainBacked`
 * (`features/index.ts`; ADR 0472 P4). The supervisor fans the five channel
 * children out in parallel through `core.dispatch` (RFC 0118); each child gets
 * `briefId`/`provider`/`model` from the run's variables by `inputMapping`, and
 * reports back through its `channelResult` variable, mapped out per child for the
 * consistency check (ADR 1020 D1/D2).
 *
 * This module holds only what the registrar reads: the id and the output roles.
 * It used to carry two full in-tree definitions (a parallel and a sequential
 * shape behind an ops kill switch) that had drifted from the pack while calling
 * themselves its readable source. Nothing registered the sequential one. ADR 1020 D7.
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 * @see docs/adr/1020-campaign-studio-end-to-end-honesty.md
 */

import type { ChainBackedRoleMap } from '../../host/chainBackedWorkflows.js';

const ORCHESTRATION_ID = 'campaign-studio.campaign-orchestration';

/** The orchestration's output roles: `finalize` (the campaign) is the primary
 *  output; every other node's role is cleared by the registrar. */
export const campaignOrchestrationParallel: ChainBackedRoleMap = {
  workflowId: ORCHESTRATION_ID,
  nodes: [{ nodeId: 'finalize', outputRole: 'primary' }],
};

export { ORCHESTRATION_ID };
