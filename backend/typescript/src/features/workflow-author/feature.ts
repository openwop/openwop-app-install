/**
 * AI Workflow Author (ADR 0072). An **always-on** feature-package: the authoring
 * brain the core builder lacks. From a natural-language intent it reads the live
 * node catalog as its closed-world menu, plans a node/edge DAG, and persists a
 * schema-valid WorkflowDefinition through the SHARED registration path so it is
 * READY TO OPEN in the existing xyflow builder (ADR 0596 `WFAU-1`: the
 * Create-with-AI panel renders a link — nothing auto-navigates).
 *
 * Always-on (no toggle): the builder is itself a core, ungated surface, so AI
 * authoring rides alongside it without a flag (graduated 2026-06-19; the
 * `workflow-author` toggle is retired in `features/index.ts`). The
 * `ctx.features['workflow-author']` surface is therefore ungated too
 * (`featureSurfaces` alwaysOn when no toggle default is registered).
 *
 * No parallel architecture: the catalog comes from `host/nodeCatalogBuilder.ts`
 * (the same source the palette uses), the closed-world check from the core
 * helpers there, persistence through `host/workflowDefinitionValidation.ts` +
 * `host/workflowsRegistry.ts` (the same validator + registry the
 * `POST /v1/host/openwop-app/workflows` route uses), run dispatch through the
 * core `host/runDispatch.ts` helper (shared with `POST /v1/runs`), and the
 * meta-workflow is a **chain-backed** workflow (ADR 0472 P4) — the RFC 0013 chain
 * pack `examples/workflow-chain-packs/workflow-author/`, registered same-id via
 * `registerChainBackedWorkflow`, so the definition the run dispatches is EXPANDED
 * from the pack rather than pinned in TypeScript.
 *
 * NOT `builtinWorkflows` (ADR 0596 doc-rot fix). This block said "a hard-coded
 * built-in (`builtinWorkflows` → catalog source A)" while `registerRoutes` below
 * — twelve lines away — already called `registerChainBackedWorkflow` under a
 * comment naming the migration. The seam is not merely deprecated: the
 * `BackendFeature.builtinWorkflows` FIELD is GONE (declaring one is a TypeScript
 * error), `host/builtinWorkflows.ts` is DELETED, and `LEGACY_PINNED_WORKFLOWS` is
 * frozen empty by the ADR 0472 ratchet. A reader who trusted this sentence would
 * go looking for a mechanism that cannot be declared.
 *
 * Faces (ADR 0014): the REST routes (incl. the `draft` dispatcher), the
 * `ctx.features['workflow-author']` workflow surface, the
 * `feature.workflow-author.{nodes,agents}` packs, and the meta-workflow chain
 * pack `core.openwop.workflows.workflow-author`.
 *
 * RFC gate (ADR 0072): host-extension under /v1/host/openwop-app/workflow-author/*,
 * "workflow" is not a normative wire object. NO new RFC.
 *
 * @see docs/adr/0072-ai-workflow-authoring.md
 */

import type { BackendFeature } from '../types.js';
import { registerWorkflowAuthorRoutes } from './routes.js';
import { registerWorkflowAuthorMetaWorkflow } from './metaWorkflow.js';
import { registerWorkflowAuthorAgentTools } from './agentTools.js';
import { buildWorkflowAuthorSurface } from './surface.js';

export const workflowAuthorFeature: BackendFeature = {
  id: 'workflow-author',
  registerRoutes: (deps) => {
    registerWorkflowAuthorMetaWorkflow(); // ADR 0472 P4 — migrated to chain-backed
    // CFP-1 — the Workflow Architect's chat tools ride the ADR 0308 D2
    // feature-registered-builtin seam (registration is process-wide; toggle/
    // acting-user honesty lives in each tool's run). Same lifecycle as the routes.
    registerWorkflowAuthorAgentTools();
    registerWorkflowAuthorRoutes(deps);
  },
  surface: { id: 'workflow-author', build: buildWorkflowAuthorSurface },
  // No toggleDefault → always-on (the surface gates open; the routes don't 404).
  requiredPacks: [
    { name: 'feature.workflow-author.nodes', version: '1.0.4' },
    { name: 'feature.workflow-author.agents', version: '1.1.1' },
  ],
};
