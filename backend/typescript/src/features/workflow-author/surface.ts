/**
 * Workflow-author workflow surface (ADR 0072 / ADR 0014 Phase 1) — the typed
 * `ctx.features['workflow-author']` the meta-workflow's nodes call. Toggle-gated
 * at the registry seam (featureSurfaces.gate, tenant granularity). The catalog +
 * registry it reads/writes are host-global; tenant isolation for the AUTHORED
 * workflow is enforced by the shared registration path it persists through.
 *
 * @see docs/adr/0072-ai-workflow-authoring.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import type { FeatureSurface } from '../../host/featureSurfaces.js';
import {
  buildAuthoringCatalog,
  validateAuthoredWorkflow,
  persistAuthoredWorkflow,
} from './workflowAuthorService.js';

export function buildWorkflowAuthorSurface(_scope: BundleScope): FeatureSurface {
  return {
    /** The legal building-block menu: runnable, schema-resolved nodes (plus the
     *  list of nodes withheld, with reasons) the authoring brain plans against. */
    getCatalog: async () => {
      const c = buildAuthoringCatalog();
      return { nodes: c.nodes, excluded: c.excluded };
    },

    /** Validate a candidate WorkflowDefinition WITHOUT persisting; returns
     *  `{ ok, errors }` so the draft node can repair on the errors. */
    validateDraft: async (args) => {
      const v = validateAuthoredWorkflow((args ?? {}).definition);
      return { ok: v.ok, errors: v.errors };
    },

    /** Validate AND register a candidate through the shared registration path.
     *  Throws on any structural / capability / closed-world violation. */
    persistDraft: async (args) => {
      const out = persistAuthoredWorkflow((args ?? {}).definition);
      return { workflowId: out.workflowId, nodeCount: out.nodeCount };
    },
  };
}
