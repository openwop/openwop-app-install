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

import { registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';

export const WORKFLOW_AUTHOR_META_ID = 'openwop-app.workflow-author';

export function registerWorkflowAuthorMetaWorkflow(): void {
  registerChainBackedWorkflow(WORKFLOW_AUTHOR_META_ID, {
    postProcess: (def) => {
      for (const n of def.nodes) {
        if (n.nodeId.endsWith('_draft') || n.nodeId === 'draft' || n.nodeId.endsWith('_validate') || n.nodeId === 'validate') n.outputRole = 'secondary';
        else if (n.nodeId.endsWith('_persist') || n.nodeId === 'persist') n.outputRole = 'primary';
        else if (n.outputRole !== undefined) delete n.outputRole;
      }
    },
  });
}
