/**
 * ADR 0820 §7 / strategy G6 — the RUN-START gate by owning feature.
 *
 * A FEATURE-OWNED workflow is one a feature registers (a chain-backed same-id
 * workflow, `registerChainBackedWorkflow(id, { featureId })`) or declares
 * (`registerWorkflowFeature(id, featureId)`), plus any tenant copy instantiated
 * from such a chain (`metadata.expandedFrom.chainId` names the source chain, so a
 * `from-chain` mint inherits its feature). Everything else (host system
 * workflows, user-authored graphs, gallery templates no feature claims) is NOT
 * feature-owned and is never refused here.
 *
 * The check runs inside the ADR 0823 launch funnel (`resolveLaunchWorkflow`) and
 * the relaunch branch of `resolveRunDefinition`, AFTER the ownership predicate,
 * so it covers API runs, schedule fires, trigger fires, kanban, MCP, CRM and
 * sub-workflow children together, and a foreign id still resolves as a plain
 * not-found (no oracle).
 *
 * Semantics, per launch:
 *   - `resolveOne(featureId, subject)` — toggle AND plan (ADR 0819 §1);
 *   - `null` (no toggle registered for the id) ⇒ NOT gated: an always-on feature
 *     has no toggle, and a sellable feature always has one (ADR 0820 §1);
 *   - disabled ⇒ a TYPED throw (`WorkflowFeatureRefusedError`, 403 `forbidden`,
 *     `details.reason` = `not_entitled` | `feature_disabled` | `feature_unavailable`);
 *   - a resolver THROW ⇒ refused `unresolved` (fail-closed: a toggle we cannot
 *     read is not a licence to run someone's paid workflow).
 *
 * A refused launch mints nothing and consumes nothing: it throws before any run
 * row, run-limit reservation or budget write.
 *
 * Core registry (ADR 0001 inversion, the `registerToggleDefault` shape): core
 * never imports `features/`; features push their ownership in at boot.
 */

import { OpenwopError } from '../types.js';
import type { WorkflowDefinition } from '../executor/types.js';
import { resolveOne } from './featureToggles/service.js';
import type { ToggleSubject } from './featureToggles/types.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.workflowFeatureGate');

/** workflowId OR source chainId → owning feature (toggle) id. */
const owners = new Map<string, string>();

/** Declare that `workflowOrChainId` belongs to `featureId` (a TOGGLE id). Last wins. */
export function registerWorkflowFeature(workflowOrChainId: string, featureId: string): void {
  if (!workflowOrChainId || !featureId) return;
  owners.set(workflowOrChainId, featureId);
}

/** Declare several ids at once (a feature's legacy-def array). */
export function registerWorkflowsFeature(ids: Iterable<string>, featureId: string): void {
  for (const id of ids) registerWorkflowFeature(id, featureId);
}

/**
 * The feature that owns `workflowId`, or `null`. The id itself wins; otherwise
 * the definition's source chain (`metadata.expandedFrom.chainId`) — the tenant
 * copy a `from-chain` instantiation minted from a feature's chain.
 */
export function workflowOwningFeature(workflowId: string, definition?: Pick<WorkflowDefinition, 'metadata'> | null): string | null {
  const direct = owners.get(workflowId);
  if (direct) return direct;
  const expandedFrom = (definition?.metadata as Record<string, unknown> | undefined)?.expandedFrom;
  const chainId = expandedFrom && typeof expandedFrom === 'object' ? (expandedFrom as Record<string, unknown>).chainId : undefined;
  return typeof chainId === 'string' ? owners.get(chainId) ?? null : null;
}

export type FeatureRefusal = 'plan' | 'toggle' | 'unresolved';

/** The typed run-start refusal. 403 `forbidden`, the billing paywall's shape
 *  (`details.feature`), so every HTTP lane renders it as the upgrade lock and
 *  every internal launcher can tell it from not-found. */
export class WorkflowFeatureRefusedError extends OpenwopError {
  constructor(
    readonly featureId: string,
    readonly blockedBy: FeatureRefusal,
    readonly workflowId: string,
  ) {
    super(
      'forbidden',
      blockedBy === 'plan'
        ? `This workflow belongs to the ${featureId} feature, which is not included in this workspace's plan.`
        : blockedBy === 'unresolved'
          ? `This workflow belongs to the ${featureId} feature, which could not be checked right now. Try again shortly.`
          : `This workflow belongs to the ${featureId} feature, which is not enabled for this workspace.`,
      403,
      {
        feature: featureId,
        workflowId,
        reason: blockedBy === 'plan' ? 'not_entitled' : blockedBy === 'unresolved' ? 'feature_unavailable' : 'feature_disabled',
      },
    );
    this.name = 'WorkflowFeatureRefusedError';
  }
}

/** Who is launching, beyond the tenant: the acting user (user-bucketed toggles)
 *  and the listed operator's `planExempt` (set only by `toggleSubjectOf(req)`). */
export type LaunchSubject = Omit<ToggleSubject, 'tenantId'>;

/**
 * Resolve feature access for a launch. `null` ⇒ allowed (not gated: no toggle
 * registered); otherwise the refusal kind. Never throws.
 */
export async function featureAccessRefusal(featureId: string, tenantId: string, subject: LaunchSubject = {}): Promise<FeatureRefusal | null> {
  try {
    const resolved = await resolveOne(featureId, { ...subject, tenantId });
    if (resolved === null) return null;
    if (resolved.enabled) return null;
    if (resolved.blockedBy === 'plan') return 'plan';
    if (resolved.blockedBy === 'unresolved') return 'unresolved';
    return 'toggle';
  } catch (err) {
    log.warn('workflow_feature_unresolved', { featureId, tenantId, error: err instanceof Error ? err.message : String(err) });
    return 'unresolved';
  }
}

/**
 * THE run-start check. Throws `WorkflowFeatureRefusedError` when `workflowId`
 * (or its source chain) is owned by a feature `tenantId` may not use; a no-op
 * for a workflow no feature owns.
 */
export async function assertWorkflowFeatureLaunchable(
  tenantId: string,
  workflowId: string,
  definition: Pick<WorkflowDefinition, 'metadata'> | null | undefined,
  subject: LaunchSubject = {},
): Promise<void> {
  const featureId = workflowOwningFeature(workflowId, definition);
  if (!featureId) return;
  const refusal = await featureAccessRefusal(featureId, tenantId, subject);
  if (refusal === null) return;
  log.info('workflow_launch_refused_feature', { tenantId, workflowId, featureId, blockedBy: refusal });
  throw new WorkflowFeatureRefusedError(featureId, refusal, workflowId);
}

/** Test seam. */
export function _resetWorkflowFeaturesForTest(): void {
  owners.clear();
}
