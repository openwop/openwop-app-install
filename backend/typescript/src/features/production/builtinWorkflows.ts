/**
 * Production Intelligence built-in workflow (ADR 0172 / CFP-1 remediation).
 *
 * The ONE packaged, versioned production-plan workflow the Production Planner
 * ignites from the chat via the `openwop:production.plan` action tool. It is a
 * single real node — the SAME `feature.production.nodes.plan-generate` node the
 * campaign spine slots (`orchestrationWorkflow.ts`) — so the chat path generates
 * the plan INSIDE a run (recorded, replay/fork-safe, artifact emitted through the
 * run envelope, plan persisted via `ctx.features.production.savePlan` with the
 * deterministic per-run `pln:run:<runId>` key), instead of the pre-remediation
 * chat path that generated nothing but prose.
 *
 * Registered via `BackendFeature.builtinWorkflows` (restart-safe, cross-instance —
 * the ADR 0072 precedent the campaign spine + Challenge Factory use).
 *
 * @see docs/adr/0172-production-intelligence-vendor-directory.md
 */

import type { WorkflowDefinition } from '../../executor/types.js';

const input = (variableName: string) => ({ type: 'variable' as const, variableName });

export const PRODUCTION_PLAN_WORKFLOW_ID = 'openwop-app.production.plan';

/** Single-node plan workflow — `plan-generate` (role:action; recorded output ⇒
 *  replay/fork read the persisted plan verbatim). Inputs seed from the tool's
 *  `startWorkflowRun` inputs by name; `provider`/`model` are unset in production
 *  (the node defaults to the managed provider) and set by the mock-AI test seam. */
const productionPlanWorkflow: WorkflowDefinition = {
  workflowId: PRODUCTION_PLAN_WORKFLOW_ID,
  variables: [
    { name: 'orgId' },
    { name: 'channels' },
    { name: 'assets' },
    { name: 'briefId' },
    { name: 'provider' },
    { name: 'model' },
  ],
  nodes: [
    {
      nodeId: 'plan-generate',
      typeId: 'feature.production.nodes.plan-generate',
      inputs: {
        orgId: input('orgId'),
        channels: input('channels'),
        assets: input('assets'),
        briefId: input('briefId'),
        provider: input('provider'),
        model: input('model'),
      },
    },
  ],
  metadata: { kind: 'production-plan', feature: 'production' },
};

export const productionBuiltinWorkflows: readonly WorkflowDefinition[] = [productionPlanWorkflow];
