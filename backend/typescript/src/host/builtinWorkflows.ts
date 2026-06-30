/**
 * Feature-contributed BUILT-IN workflows — the hard-coded catalog seam (ADR 0001
 * + ADR 0072). A feature package declares always-present, restart-safe,
 * cross-instance workflow definitions via `BackendFeature.builtinWorkflows`;
 * `registerBackendFeatures` populates this registry at boot, and the workflow
 * catalog (`host/index.ts` source A) resolves them — exactly like the built-in
 * `openwop-app.*` samples and the demo role-workflows (`exampleWorkflows.ts`),
 * NOT the in-memory builder registry (which is process-local + lost on restart).
 *
 * This is a CORE registry features write INTO (the same inversion as
 * `registerFeatureSurface` / `registerToggleDefault`), so the ADR 0001 import
 * boundary holds: core never imports `features/`; features push their built-ins
 * here. Any feature — not just workflow-author — gets restart-safe built-in
 * workflows for free by declaring `builtinWorkflows`.
 *
 * Registration is idempotent by `workflowId` and re-runs on every instance at
 * boot, so the catalog is identical everywhere and survives restart.
 */

import type { WorkflowDefinition } from '../executor/types.js';

const builtins = new Map<string, WorkflowDefinition>();

/** Register (or overwrite) a feature's built-in workflow. Called at boot. */
export function registerBuiltinWorkflow(def: WorkflowDefinition): void {
  builtins.set(def.workflowId, def);
}

/** Resolve a built-in workflow by id, or undefined. Used by the catalog. */
export function getBuiltinWorkflow(workflowId: string): WorkflowDefinition | undefined {
  return builtins.get(workflowId);
}

/** All registered built-in workflows (e.g. for diagnostics / a catalog listing). */
export function listBuiltinWorkflows(): readonly WorkflowDefinition[] {
  return [...builtins.values()];
}
