/**
 * Channel child workflows (ADR 0157 Phase 2). One factory builds the five
 * standalone channel workflows the orchestration (ADR 0158) fans out over. Each:
 *   generate(channel)  →  approve (HITL, per-item refine on array channels)
 *
 * The `generate` node bundles the content-quality + brand-compliance checks (the
 * executor's input-ref vocabulary doesn't carry MyndHyve's cross-node
 * {connection} wiring — see the node pack note), so the workflow stays a clean
 * generate → approve DAG. Registered via `BackendFeature.builtinWorkflows`
 * (restart-safe, cross-instance) — the ADR 0072 precedent, NOT the in-memory
 * builder registry.
 *
 * @see docs/adr/0157-campaign-studio-channel-generation.md
 */

import type { WorkflowDefinition } from '../../executor/types.js';

const GENERATE = 'feature.campaign-channels.nodes.generate';
const APPROVE = 'core.approvalGate';

/** The five channels + which draft array supports per-item refine (Partial
 *  Accepter). Landing page is a single page → no per-item refine. */
const CHANNELS: ReadonlyArray<{ channel: string; itemsFrom?: string; prompt: string }> = [
  { channel: 'landing_page', prompt: 'Review the generated landing page.' },
  { channel: 'ad_variants', itemsFrom: 'platformSets', prompt: 'Review the generated ad variants — accept all or refine a platform set.' },
  { channel: 'email_sequence', itemsFrom: 'emails', prompt: 'Review the generated email sequence — accept all or refine specific emails.' },
  { channel: 'creative_briefs', itemsFrom: 'briefs', prompt: 'Review the generated creative briefs — accept all or refine a format.' },
  { channel: 'social_posts', itemsFrom: 'posts', prompt: 'Review the generated social posts — accept all or refine specific posts.' },
];

function channelWorkflow(channel: string, itemsFrom: string | undefined, prompt: string): WorkflowDefinition {
  return {
    workflowId: `campaign-studio.channel.${channel.replace(/_/g, '-')}`,
    nodes: [
      {
        nodeId: 'generate',
        typeId: GENERATE,
        outputRole: 'secondary',
        inputs: {
          briefId: { type: 'variable', variableName: 'briefId' },
          channel: { type: 'static', value: channel },
        },
      },
      {
        nodeId: 'approve',
        typeId: APPROVE,
        outputRole: 'primary',
        config: { prompt, ...(itemsFrom ? { itemsFrom } : {}) },
      },
    ],
    edges: [{ edgeId: 'e_generate_approve', sourceNodeId: 'generate', targetNodeId: 'approve' }],
    variables: [
      { name: 'briefId', type: 'string', description: 'The campaign brief to generate this channel from.', required: true },
    ],
    metadata: { kind: 'campaign-channel', feature: 'campaign-channels', channel },
  };
}

export const CHANNEL_WORKFLOWS: ReadonlyArray<WorkflowDefinition> =
  CHANNELS.map((c) => channelWorkflow(c.channel, c.itemsFrom, c.prompt));

/** The stable workflow ids the orchestration (ADR 0158) dispatches. */
export const CHANNEL_WORKFLOW_IDS: ReadonlyArray<string> = CHANNEL_WORKFLOWS.map((w) => w.workflowId);
