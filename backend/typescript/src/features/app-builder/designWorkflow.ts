/**
 * The app-builder design chain — REGISTRATION ADAPTER (ADR 0346 4a).
 *
 * The chain itself lives in the `vendor.openwop.app-builder.workflows` pack
 * (`examples/workflow-chain-packs/app-builder/pack.json`, `kind:"workflow-chain"`) —
 * the RFC 0013-portable single source that closes the ADR 0305 Phase-F promise.
 * This module is the MINIMUM host glue that turns the portable fragment into
 * the always-present `app-builder.design` builtin at boot:
 *
 *   1. RFC 0124 deferred expansion (`expandChain({deferred:true})`) so `idea`
 *      stays a RUNTIME variable — Path A would freeze it at expansion.
 *   2. Rename the prefix-materialized variable back to `idea` (the chat/App
 *      Architect launch contract supplies `{idea}` by name).
 *   3. Re-stamp output roles: expansion marks the TERMINAL node primary (the
 *      review gate), but the ONE typed deliverable is the audit's artifact
 *      (the ADR 0325 correction) — prd/research/plan stay secondary.
 *   4. Model policy (ADR 0346 4b): nodes carrying `modelClass` get the host-
 *      resolved `(provider, model)` stamped over the pack's portable defaults,
 *      recording the resolved choice in the registered definition (runs
 *      snapshot their definition — replay reads it verbatim).
 *
 * Registration is idempotent per boot (`registerChainBackedWorkflow`, the
 * chainId-only API imported below), and the chain remains a normal gallery chain
 * for user instantiation. (ADR 0643 / `KBWF-14` — this line used to name
 * `registerBuiltinWorkflow`, an API this module stopped using at `:106` and which
 * no longer exists; the stale name was the reason the ADR 0472 anti-pattern grep
 * returned a non-empty result for a file that is already compliant.)
 */
import { getChain, loadWorkflowChainPacks } from '../../host/workflowChainPackLoader.js';
import { registerChainBackedWorkflow, buildChainBackedDefinition } from '../../host/chainBackedWorkflows.js';
import { resolveModelForClass } from '../../host/modelClassResolver.js';
import { catalogTypeListForPrompt } from './componentCatalog.js';
import { locateRepoDir } from '../../host/_repoPath.js';
import { createLogger } from '../../observability/logger.js';
import type { WorkflowDefinition } from '../../executor/types.js';

const log = createLogger('features.app-builder.designWorkflow');

export const APP_BUILDER_DESIGN_WORKFLOW_ID = 'app-builder.design';
export const APP_BUILDER_REPAIR_WORKFLOW_ID = 'app-builder.repair';
export const APP_BUILDER_PLAN_TO_KANBAN_WORKFLOW_ID = 'app-builder.plan-to-kanban';
const AUDIT_TYPE = 'feature.app-builder.nodes.audit';
// The typed-record + AI stages persist as SECONDARY deliverables (ADR 0346 4c/4d).
const SECONDARY_TYPES = new Set(['feature.app-builder.nodes.research', 'feature.app-builder.nodes.capture']);
const CHAT_COMPLETION = 'core.ai.chatCompletion';
// ADR 0358 — the substitution anchor: everything after this marker in a
// chatCompletion prompt is the closed type list, re-derived at registration.
const CATALOG_MARKER = 'Use ONLY these component types:';

/** The chain registry is boot-loaded from the default roots; when this feature
 *  registers in a context that skipped that pass (unit tests, embedded boots),
 *  load OUR pack directly from the repo `packs/` tree — same file, one source. */
function ensureChainLoaded(): void {
  if (getChain(APP_BUILDER_DESIGN_WORKFLOW_ID)
    && getChain(APP_BUILDER_REPAIR_WORKFLOW_ID)
    && getChain(APP_BUILDER_PLAN_TO_KANBAN_WORKFLOW_ID)) return;
  const chainRoot = locateRepoDir(new URL('.', import.meta.url).pathname, 'examples', 'workflow-chain-packs/app-builder/pack.json');
  loadWorkflowChainPacks({ roots: [`${chainRoot}/workflow-chain-packs`] });
}

/** App-builder-specific post-processing of the expanded design/repair definition —
 *  runs AFTER the generic chain-backed expand + stable-id + param-name restore (now
 *  owned by `host/chainBackedWorkflows.ts`, ADR 0472 Phase 1). Sets output roles,
 *  resolves the model policy, and re-binds the SSoT component catalog live. */
function appBuilderPostProcess(def: WorkflowDefinition): void {
  // (3) + (4) per node: output roles by typeId; model policy for modelClass.
  // (5) ADR 0358 — SSoT catalog binding: any prompt carrying the closed
  // component-type list gets it re-derived LIVE from APP_BUILDER_COMPONENTS at
  // registration, so the pack's portable copy can never drift what a run's
  // model actually sees. Pure function of the catalog in array order —
  // registration stays deterministic (the templatesAndChain test pins both).
  for (const node of def.nodes) {
    delete node.outputRole;
    if (node.typeId === AUDIT_TYPE) node.outputRole = 'primary';
    else if (SECONDARY_TYPES.has(node.typeId)) node.outputRole = 'secondary';
    else if (node.typeId === CHAT_COMPLETION) node.outputRole = 'secondary';
    const cfg = (node.config ?? {}) as Record<string, unknown>;
    if (typeof cfg.modelClass === 'string') {
      const resolved = resolveModelForClass(cfg.modelClass);
      if (resolved) {
        cfg.provider = resolved.provider;
        cfg.model = resolved.model;
      }
      delete cfg.modelClass; // the executor/node contract is (provider, model)
      node.config = cfg;
    }
    if (node.typeId === CHAT_COMPLETION && typeof cfg.systemPrompt === 'string' && cfg.systemPrompt.includes(CATALOG_MARKER)) {
      cfg.systemPrompt = cfg.systemPrompt.slice(0, cfg.systemPrompt.indexOf(CATALOG_MARKER) + CATALOG_MARKER.length)
        + ' ' + catalogTypeListForPrompt() + '.';
      node.config = cfg;
    }
  }

  def.metadata = {
    ...(def.metadata ?? {}),
    kind: def.workflowId === APP_BUILDER_PLAN_TO_KANBAN_WORKFLOW_ID
      ? 'app-builder-plan-to-kanban'
      : 'app-builder-design',
    feature: 'app-builder',
  };
}

/** The design chain's expanded definition (kept as a named export — tests +
 *  future callers address it directly). Built via the generic chain-backed builder
 *  (ADR 0472 Phase 1) with the app-builder post-processor. */
export function buildDesignWorkflowDefinition(): WorkflowDefinition {
  ensureChainLoaded();
  return buildChainBackedDefinition(APP_BUILDER_DESIGN_WORKFLOW_ID, { postProcess: appBuilderPostProcess });
}

/** The repair chain's expanded definition (ADR 0346 4d). */
export function buildRepairWorkflowDefinition(): WorkflowDefinition {
  ensureChainLoaded();
  return buildChainBackedDefinition(APP_BUILDER_REPAIR_WORKFLOW_ID, { postProcess: appBuilderPostProcess });
}

/** The editable, approval-gated canvas-to-Kanban chain. Its only App Builder
 * behavior is the typed proposal adapter; materialization remains the generic
 * core pack node so other canvases can use the same work-item lifecycle. */
export function buildPlanToKanbanWorkflowDefinition(): WorkflowDefinition {
  ensureChainLoaded();
  return buildChainBackedDefinition(APP_BUILDER_PLAN_TO_KANBAN_WORKFLOW_ID, { postProcess: appBuilderPostProcess });
}

/** Boot registration (called from the feature's registerRoutes — the standard
 *  features-push-into-core inversion). ADR 0472 Phase 1 — migrated OFF the
 *  deprecated `registerBuiltinWorkflow` onto the sanctioned chain-backed API
 *  (`registerChainBackedWorkflow`, chainId-only, resolve-by-id under the stable
 *  chainId). Still fails LOUD-but-SOFT at boot (the API swallows + logs per-chain;
 *  the pre-load stays guarded here) — the blast radius is "app-builder AI authoring
 *  absent", never "no app at all" (grade pass 2026-07-11 AB-CODE-3). */
export function registerDesignChainWorkflow(): void {
  try {
    ensureChainLoaded();
  } catch (err) {
    log.error('design_chain_registration_failed', { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  registerChainBackedWorkflow(APP_BUILDER_DESIGN_WORKFLOW_ID, { postProcess: appBuilderPostProcess });
  registerChainBackedWorkflow(APP_BUILDER_REPAIR_WORKFLOW_ID, { postProcess: appBuilderPostProcess });
  registerChainBackedWorkflow(APP_BUILDER_PLAN_TO_KANBAN_WORKFLOW_ID, { postProcess: appBuilderPostProcess });
}
