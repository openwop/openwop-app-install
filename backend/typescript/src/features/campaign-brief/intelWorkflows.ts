/**
 * The two Campaign Brief workflows:
 *
 *  - the messaging kernel (CFP-1): generate-kernel → human approval →
 *    promote-kernel. The kernel is saved onto the brief only by promote-kernel,
 *    after the approval (ADR 1020 D8), so a rejection saves nothing.
 *  - market intel (ADR 0403 Phase 4): extract-voc → generate-angles →
 *    build-targeting → a review checkpoint. The research is saved to the brief's
 *    Intel tab as it is produced (angles and targeting read the stored evidence);
 *    the checkpoint is where a person curates it, and approving it changes
 *    nothing stored (ADR 1020 D8 correction: staging the research is filed as
 *    `CS70WF-36`).
 *
 * Both workflows ARE the `campaign-brief` chain pack
 * (`examples/workflow-chain-packs/campaign-brief/pack.json`), registered
 * chain-backed under these stable ids by `registerLegacyDefsChainBacked`
 * (`features/index.ts`; ADR 0472 P4). This module holds only what that
 * registrar, the feature gate and the launcher tools read: the ids and each
 * node's output role. It used to carry full in-tree definitions that had drifted
 * from the pack (no provider/model inputs, unversioned typeIds, metadata the
 * registrar dropped) and cited the retired `builtinWorkflows` seam (ADR 1020 D7).
 *
 * @see docs/adr/0403-market-intel-pipeline.md
 * @see docs/adr/1020-campaign-studio-end-to-end-honesty.md
 */

/** What `registerLegacyDefsChainBacked` reads: the id and the output roles it
 *  restores onto the expansion (every other role is cleared). */
type RoleMap = { workflowId: string; nodes: ReadonlyArray<{ nodeId: string; outputRole?: 'primary' | 'secondary' }> };

export const MARKET_INTEL_WORKFLOW_ID = 'campaign-studio.market-intel';
export const KERNEL_WORKFLOW_ID = 'campaign-studio.messaging-kernel';

/** The kernel run's primary output is the SAVED kernel (promote-kernel), not the
 *  approval decision; the generated draft is secondary. */
export const KERNEL_WORKFLOWS: ReadonlyArray<RoleMap> = [{
  workflowId: KERNEL_WORKFLOW_ID,
  nodes: [
    { nodeId: 'generate_kernel', outputRole: 'secondary' },
    { nodeId: 'promote', outputRole: 'primary' },
  ],
}];

export const MARKET_INTEL_WORKFLOWS: ReadonlyArray<RoleMap> = [{
  workflowId: MARKET_INTEL_WORKFLOW_ID,
  nodes: [
    { nodeId: 'extract_voc', outputRole: 'secondary' },
    { nodeId: 'generate_angles', outputRole: 'secondary' },
    { nodeId: 'build_targeting', outputRole: 'secondary' },
    { nodeId: 'approve', outputRole: 'primary' },
  ],
}];
