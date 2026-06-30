/**
 * Demo seed for the AI Workflow Author (ADR 0072) — a small set of **showcase
 * workflows that look like authored output**, so a first-time visitor sees what
 * the "Create with AI" flow produces (and has something runnable to open in the
 * builder) without needing a configured AI provider.
 *
 * Built ENTIRELY from deterministic demo catalog nodes (`local.sample.demo.mock-ai`,
 * `core.approvalGate`) — the same posture as `exampleWorkflows.ts` — so every
 * seeded workflow runs end-to-end with NO BYOK and replays deterministically.
 * Each carries `metadata.showcase = true` + `metadata.authoring` provenance so
 * the UI can badge it illustrative (never passes synthetic output off as a real
 * authoring run).
 *
 * Workflows are host-global (keyed by workflowId, not per-tenant), so — like the
 * CMS-homepage seeder — count/seed/clear operate on the global registry and the
 * `tenantId` argument is accepted for the seeder interface but not used to scope.
 *
 * @see docs/adr/0072-ai-workflow-authoring.md
 * @see src/host/exampleWorkflows.ts — the deterministic-node posture this mirrors
 */

import type { WorkflowDefinition } from '../executor/types.js';
import {
  registerWorkflow,
  getRegisteredWorkflow,
  deleteRegisteredWorkflow,
} from './workflowsRegistry.js';

/** A showcase workflow + the natural-language intent it illustrates. */
interface ShowcaseSpec {
  intent: string;
  definition: WorkflowDefinition;
}

function showcase(name: string, intent: string, definition: WorkflowDefinition): ShowcaseSpec {
  return {
    intent,
    definition: {
      ...definition,
      metadata: {
        ...(definition.metadata ?? {}),
        name,
        showcase: true,
        source: 'workflow-author-demo',
        // Illustrative provenance — mirrors the real `metadata.authoring` the
        // draft node stamps, but flagged so the UI never reads it as a real run.
        authoring: { intent, model: 'demo', illustrative: true },
      },
    },
  };
}

export const WORKFLOW_AUTHOR_SHOWCASE: ReadonlyArray<ShowcaseSpec> = [
  showcase(
    'AI-authored · Lead triage & notify',
    'When a new high-value lead arrives, summarize it, hold for a quick human review, then notify the deal owner.',
    {
      workflowId: 'openwop-app.authored.lead-triage',
      nodes: [
        { nodeId: 'summarize', typeId: 'local.sample.demo.mock-ai' },
        { nodeId: 'review', typeId: 'core.approvalGate', config: { prompt: 'Route this lead to the deal owner?' } },
        { nodeId: 'notify', typeId: 'local.sample.demo.mock-ai', outputRole: 'primary' },
      ],
      edges: [
        { edgeId: 'e1', sourceNodeId: 'summarize', targetNodeId: 'review' },
        { edgeId: 'e2', sourceNodeId: 'review', targetNodeId: 'notify' },
      ],
    },
  ),
  showcase(
    'AI-authored · Document extract & summarize',
    'Extract the key points from an uploaded document and produce a one-paragraph summary.',
    {
      workflowId: 'openwop-app.authored.doc-summary',
      nodes: [
        { nodeId: 'extract', typeId: 'local.sample.demo.mock-ai' },
        { nodeId: 'summarize', typeId: 'local.sample.demo.mock-ai', outputRole: 'primary' },
      ],
      edges: [{ edgeId: 'e1', sourceNodeId: 'extract', targetNodeId: 'summarize' }],
    },
  ),
];

/** How many showcase workflows are currently registered (host-global). */
export function countWorkflowAuthorShowcase(): number {
  return WORKFLOW_AUTHOR_SHOWCASE.filter((s) => getRegisteredWorkflow(s.definition.workflowId)).length;
}

/** Register the showcase workflows that are missing (idempotent, non-destructive). */
export function seedWorkflowAuthorShowcase(): { created: number; details: Record<string, unknown> } {
  let created = 0;
  const ids: string[] = [];
  for (const s of WORKFLOW_AUTHOR_SHOWCASE) {
    if (getRegisteredWorkflow(s.definition.workflowId)) continue;
    registerWorkflow(s.definition);
    created++;
    ids.push(s.definition.workflowId);
  }
  return { created, details: { workflows: ids } };
}

/** Remove the canonical showcase workflows (only the seeded ids, never user work). */
export function clearWorkflowAuthorShowcase(): { cleared: number; details: Record<string, unknown> } {
  let cleared = 0;
  const ids: string[] = [];
  for (const s of WORKFLOW_AUTHOR_SHOWCASE) {
    if (deleteRegisteredWorkflow(s.definition.workflowId)) {
      cleared++;
      ids.push(s.definition.workflowId);
    }
  }
  return { cleared, details: { workflows: ids } };
}
