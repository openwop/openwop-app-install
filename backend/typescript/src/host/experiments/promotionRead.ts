/** ADR 0950: a promotion replay shows the safety decisions its source made.
 * Ordinary reads stay live. Only an executing, claimed promotion records one
 * immutable report per node; a fork inherits it through the existing run owner.
 * This is evidence, never authority to ramp or publish. */
import { OpenwopError } from '../../types.js';
import { hostExtStorage } from '../hostExtPersistence.js';
import { currentEffectContext } from '../runEffectContext.js';
import type { BundleScope } from '../inMemorySurfaces.js';
import type { Experiment } from './types.js';
import { assertPromotionRun } from './promote.js';
import { PROMOTION_READ_PREFIX } from './promotionReadKey.js';

export async function promotionRead(
  scope: BundleScope, experiment: Experiment, workflowId: string, operation: 'gates' | 'recheck' | 'monitor',
  compute: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const context = currentEffectContext();
  const runId = scope.runId?.slice(scope.runId.lastIndexOf('/') + 1);
  if (!runId || !context?.nodeId || context.runId !== runId) return compute();
  const storage = hostExtStorage();
  const run = await storage.getRun(runId);
  if (!run || run.tenantId !== scope.tenantId || run.workflowId !== workflowId) return compute();
  const key = `${PROMOTION_READ_PREFIX}${context.nodeId}`;
  const read = (raw: unknown): Record<string, unknown> => {
    const frame = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const report = frame?.report;
    if (frame?.experimentId !== experiment.experimentId || frame.orgId !== experiment.orgId
      || frame.nodeId !== context.nodeId || frame.operation !== operation
      || !report || typeof report !== 'object' || Array.isArray(report)) {
      throw new OpenwopError('conflict', 'The recorded promotion check does not match this node.', 409, { reason: 'promotion_read_mismatch' });
    }
    return report as Record<string, unknown>;
  };
  if (Object.hasOwn(run.metadata ?? {}, key)) return read(run.metadata![key]);
  if (context.replaying) {
    throw new OpenwopError('conflict', 'This source run recorded no safety check for this node.', 409, { reason: 'promotion_read_missing' });
  }
  assertPromotionRun(experiment, runId);
  const report = await compute();
  const frame = { experimentId: experiment.experimentId, orgId: experiment.orgId, nodeId: context.nodeId, operation, report };
  if (await storage.mergeRunMetadata(runId, { [key]: frame }, { ifAbsentKey: key })) return report;
  // A competing execution's committed report, never our discarded computation.
  return read((await storage.getRun(runId))?.metadata?.[key]);
}
