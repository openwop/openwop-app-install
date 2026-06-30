/**
 * AI Workflow Author (ADR 0072). An **always-on** feature-package: the authoring
 * brain the core builder lacks. From a natural-language intent it reads the live
 * node catalog as its closed-world menu, plans a node/edge DAG, and persists a
 * schema-valid WorkflowDefinition through the SHARED registration path so it
 * opens in the existing xyflow builder.
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
 * meta-workflow is a hard-coded **built-in** (`builtinWorkflows` → catalog
 * source A), NOT the in-memory builder registry.
 *
 * Faces (ADR 0014): the REST routes (incl. the `draft` dispatcher), the
 * `ctx.features['workflow-author']` workflow surface, the
 * `feature.workflow-author.{nodes,agents}` packs, and the meta-workflow built-in.
 *
 * RFC gate (ADR 0072): host-extension under /v1/host/openwop-app/workflow-author/*,
 * "workflow" is not a normative wire object. NO new RFC.
 *
 * @see docs/adr/0072-ai-workflow-authoring.md
 */

import type { BackendFeature } from '../types.js';
import { registerWorkflowAuthorRoutes } from './routes.js';
import { buildWorkflowAuthorSurface } from './surface.js';
import { workflowAuthorMetaDefinition } from './metaWorkflow.js';

export const workflowAuthorFeature: BackendFeature = {
  id: 'workflow-author',
  registerRoutes: (deps) => registerWorkflowAuthorRoutes(deps),
  surface: { id: 'workflow-author', build: buildWorkflowAuthorSurface },
  // No toggleDefault → always-on (the surface gates open; the routes don't 404).
  builtinWorkflows: [workflowAuthorMetaDefinition],
  requiredPacks: [
    { name: 'feature.workflow-author.nodes', version: '1.0.0' },
    { name: 'feature.workflow-author.agents', version: '1.0.0' },
  ],
};
