/**
 * The five channel child workflows (ADR 0157 Phase 2), each
 *   generate(channel) → approve (HITL)
 * and skipped without an approval when the brief does not enable the channel
 * (ADR 1020 D3: the edge is `falsy(skipped)`).
 *
 * The workflows ARE the `campaign-channels` chain pack
 * (`examples/workflow-chain-packs/campaign-channels/pack.json`), registered
 * chain-backed under these stable ids by `registerLegacyDefsChainBacked`
 * (`features/index.ts`; ADR 0472 P4). This module holds only what that
 * registrar and the feature gate read: the ids and each node's output role. It
 * used to carry a full in-tree `WorkflowDefinition` per channel that had drifted
 * from the pack (no provider/model, an `itemsFrom` nothing reads, metadata the
 * registrar dropped) while calling itself the readable source. ADR 1020 D7.
 * (The gate prompts no longer promise per-item refine, which `itemsFrom` never
 * delivered; ADR 1020 P3.)
 *
 * @see docs/adr/0157-campaign-studio-channel-generation.md
 * @see docs/adr/1020-campaign-studio-end-to-end-honesty.md
 */

import type { ChainBackedRoleMap } from '../../host/chainBackedWorkflows.js';

/** The five channels, in fan-out order. */
const CHANNELS = ['landing_page', 'ad_variants', 'email_sequence', 'creative_briefs', 'social_posts'] as const;

/** Each channel chain's output roles: the draft is secondary and the approval
 *  primary; on the skip branch (the brief does not enable the channel) the no-op
 *  terminal is primary, so a skipped run still has an output saying why. The two
 *  branches are exclusive. `registerLegacyDefsChainBacked` restores exactly these
 *  (and clears any other). */
export const CHANNEL_WORKFLOWS: ReadonlyArray<ChainBackedRoleMap> = CHANNELS.map((channel) => ({
  workflowId: `campaign-studio.channel.${channel.replace(/_/g, '-')}`,
  nodes: channel === 'creative_briefs'
    // ADR 1020 D14 — creative_briefs ends on creating the approved briefs: that
    // step's summary (how many, and where) is what the run card shows.
    ? [
      { nodeId: 'generate', outputRole: 'secondary' },
      { nodeId: 'approve', outputRole: 'secondary' },
      { nodeId: 'create_briefs', outputRole: 'primary' },
      { nodeId: 'skipped', outputRole: 'primary' },
    ]
    : [
      { nodeId: 'generate', outputRole: 'secondary' },
      { nodeId: 'approve', outputRole: 'primary' },
      { nodeId: 'skipped', outputRole: 'primary' },
    ],
}));

/** The stable workflow ids the orchestration (ADR 0158) dispatches. */
export const CHANNEL_WORKFLOW_IDS: ReadonlyArray<string> = CHANNEL_WORKFLOWS.map((w) => w.workflowId);
