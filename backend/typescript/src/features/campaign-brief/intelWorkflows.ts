/**
 * Market-intel research chain (ADR 0403 Phase 4) — extract-voc →
 * generate-angles → build-targeting → human approval, as a
 * `BackendFeature.builtinWorkflows` entry (the CHANNEL_WORKFLOWS / ADR 0072
 * precedent: restart-safe, cross-instance, composing this feature's OWN pack
 * nodes — NOT a new in-tree workflow namespace).
 *
 * Correction note vs the ADR text: the ADR said "a `tmpl.*`-tagged builtin";
 * feature-owned real-I/O workflows live on the feature's builtinWorkflows seam
 * (tmpl.* stays deterministic-stub-only) — recorded in the ADR implementation log.
 *
 * Correction note (2026-08-30, ADR 0472 P4): the `BackendFeature.builtinWorkflows`
 * SEAM referenced above (and at the `@` blocks below) is RETIRED — the field is
 * gone (declaring one is a TypeScript error). These `KERNEL_WORKFLOWS` /
 * `MARKET_INTEL_WORKFLOWS` arrays are now the chain-backed SSoT sources, registered
 * at boot via `registerLegacyDefsChainBacked(...)` (features/index.ts, ADR 0472 P4);
 * they remain restart-safe / cross-instance and compose this feature's own pack
 * nodes exactly as before, only the registration lane changed.
 *
 * @see docs/adr/0403-market-intel-pipeline.md
 */

import type { WorkflowDefinition } from '../../executor/types.js';

const NODES = 'feature.campaign-brief.nodes';

export const MARKET_INTEL_WORKFLOW_ID = 'campaign-studio.market-intel';

/**
 * CFP-1 — the messaging-kernel workflow (the flagship #4). `generate-kernel`
 * (assembleContext → callAI → setKernel, all in the surface) → a human approval
 * gate. Before CFP-1 the `generate-kernel` node had NO igniter anywhere (no
 * route, no containing workflow, not a chat tool) — the Campaign Brief
 * Strategist's `openwop:campaign-brief.generate-kernel` action tool now ignites
 * THIS workflow via `startWorkflowRun`, and the gate renders inline in the
 * parent run so the human approves the kernel (never a bare auto-persist claim).
 * Same builtinWorkflows seam as market-intel — restart-safe, cross-instance,
 * composing this feature's OWN pack nodes.
 */
export const KERNEL_WORKFLOW_ID = 'campaign-studio.messaging-kernel';

export const KERNEL_WORKFLOWS: ReadonlyArray<WorkflowDefinition> = [
  {
    workflowId: KERNEL_WORKFLOW_ID,
    nodes: [
      {
        nodeId: 'generate_kernel',
        typeId: `${NODES}.generate-kernel`,
        outputRole: 'secondary',
        inputs: { briefId: { type: 'variable', variableName: 'briefId' } },
      },
      {
        nodeId: 'approve',
        typeId: 'core.approvalGate',
        outputRole: 'primary',
        config: { prompt: 'Review the generated messaging kernel — the headline, supporting statement, proof points, CTAs, and tone every channel will echo. Approve it before generating channel assets, or ask the Strategist to regenerate.' },
      },
    ],
    edges: [
      { edgeId: 'e_kernel_approve', sourceNodeId: 'generate_kernel', targetNodeId: 'approve' },
    ],
    variables: [
      { name: 'briefId', type: 'string', description: 'The campaign brief to generate the messaging kernel for.', required: true },
    ],
    metadata: { kind: 'messaging-kernel', feature: 'campaign-brief' },
  },
];

export const MARKET_INTEL_WORKFLOWS: ReadonlyArray<WorkflowDefinition> = [
  {
    workflowId: MARKET_INTEL_WORKFLOW_ID,
    nodes: [
      {
        nodeId: 'extract_voc',
        typeId: `${NODES}.extract-voc`,
        outputRole: 'secondary',
        inputs: { briefId: { type: 'variable', variableName: 'briefId' } },
      },
      {
        nodeId: 'generate_angles',
        typeId: `${NODES}.generate-angles`,
        outputRole: 'secondary',
        inputs: { briefId: { type: 'variable', variableName: 'briefId' } },
      },
      {
        nodeId: 'build_targeting',
        typeId: `${NODES}.build-targeting`,
        outputRole: 'secondary',
        inputs: {
          briefId: { type: 'variable', variableName: 'briefId' },
          platform: { type: 'variable', variableName: 'platform' },
        },
      },
      {
        nodeId: 'approve',
        typeId: 'core.approvalGate',
        outputRole: 'primary',
        config: { prompt: 'Review the extracted evidence, angles, and targeting pack — every item cites its source. Curate in the brief\'s Intel tab before generating channel assets.' },
      },
    ],
    edges: [
      { edgeId: 'e_voc_angles', sourceNodeId: 'extract_voc', targetNodeId: 'generate_angles' },
      { edgeId: 'e_angles_targeting', sourceNodeId: 'generate_angles', targetNodeId: 'build_targeting' },
      { edgeId: 'e_targeting_approve', sourceNodeId: 'build_targeting', targetNodeId: 'approve' },
    ],
    variables: [
      { name: 'briefId', type: 'string', description: 'The campaign brief to research.', required: true },
      { name: 'platform', type: 'string', description: 'Targeting platform: meta | google | linkedin | tiktok.', required: true },
    ],
    metadata: { kind: 'market-intel', feature: 'campaign-brief' },
  },
];
