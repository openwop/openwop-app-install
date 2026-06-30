/**
 * The pinned AI workflow-author meta-workflow (ADR 0072) — a workflow whose job
 * is to author OTHER workflows. Registered at feature boot so it is dispatchable
 * via `POST /v1/runs` (and the feature's `draft` route).
 *
 * Pipeline (DAG, acyclic — the repair loop lives INSIDE the draft node, since the
 * scheduler forbids cycles):
 *   draft  → calls the LLM with the live node catalog, emits a candidate def
 *   validate → re-checks the candidate against the catalog + registration
 *              contract; FAILS the run (so persist never fires) when invalid
 *   persist → registers the validated definition; output carries the workflowId
 *
 * `validate → persist` carries `triggerRule: all_success`, so a failed validate
 * short-circuits the run and the caller sees the structured errors.
 */

import type { WorkflowDefinition } from '../../executor/types.js';

export const WORKFLOW_AUTHOR_META_ID = 'openwop-app.workflow-author';

export const DRAFT_NODE_TYPE_ID = 'feature.workflow-author.nodes.draft';
export const VALIDATE_NODE_TYPE_ID = 'feature.workflow-author.nodes.validate';
export const PERSIST_NODE_TYPE_ID = 'feature.workflow-author.nodes.persist';

export const workflowAuthorMetaDefinition: WorkflowDefinition = {
  workflowId: WORKFLOW_AUTHOR_META_ID,
  nodes: [
    { nodeId: 'draft', typeId: DRAFT_NODE_TYPE_ID, outputRole: 'secondary' },
    { nodeId: 'validate', typeId: VALIDATE_NODE_TYPE_ID, outputRole: 'secondary' },
    { nodeId: 'persist', typeId: PERSIST_NODE_TYPE_ID, outputRole: 'primary' },
  ],
  edges: [
    { edgeId: 'e_draft_validate', sourceNodeId: 'draft', targetNodeId: 'validate' },
    { edgeId: 'e_validate_persist', sourceNodeId: 'validate', targetNodeId: 'persist', triggerRule: 'all_success' },
  ],
  variables: [
    { name: 'intent', type: 'string', description: 'The natural-language automation intent to author a workflow for.', required: true },
  ],
  metadata: { kind: 'meta-workflow', feature: 'workflow-author' },
};
