/**
 * ADR 0949 P1b — funnel step experiments persist through the experiment engine
 * (`host/experiments/`), by expand/contract (the P1a CMS precedent):
 *
 *   - the engine row is the record of an experiment's arms and status;
 *   - the step's embedded `experiment` stays on the Funnel row as the rollback
 *     mirror AND as the pointer (which experiment is on which step). Every write
 *     goes to the engine first, then the funnel row;
 *   - a step experiment written before P1b (or by the previous image during a
 *     rollback) has no engine row: the first read imports it, insert-if-absent.
 *     A stop the previous image wrote only to the mirror is applied to the
 *     engine on read: convergence runs toward "stopped", the safe direction.
 *
 * Assignment hashes on `funnel:<funnelId>:step:<stepId>` (the legacy scope),
 * carried as `assignmentScope`, so it is byte-identical.
 */
import type { Experiment } from '../../host/experiments/types.js';
import { deleteExperimentRow, getExperimentRow, insertExperimentRowIfAbsent, putExperimentRow } from '../../host/experiments/store.js';
import { deleteExperimentRollup } from '../../host/experiments/rollup.js';
import { deleteFirstExposures } from '../../host/experiments/sticky.js';
import type { StepExperiment } from './funnelsService.js';

export const FUNNEL_STEP_SURFACE = 'funnel.step';

export const stepAssignmentScope = (funnelId: string, stepId: string): string => `funnel:${funnelId}:step:${stepId}`;

export function stepToEngine(tenantId: string, orgId: string, funnelId: string, stepId: string, exp: StepExperiment): Experiment {
  return {
    experimentId: exp.experimentId, tenantId, orgId,
    name: `Step ${stepId}`, hypothesis: '',
    surface: { kind: FUNNEL_STEP_SURFACE, ref: `${funnelId}:${stepId}` },
    unit: 'visitor',
    design: { type: exp.variants.length > 2 ? 'abn' : 'ab' },
    arms: exp.variants.map((v) => ({ key: v.key, ref: v.pageId, weight: v.weight })),
    mode: 'decide', status: exp.status, salt: exp.salt,
    assignmentScope: stepAssignmentScope(funnelId, stepId),
    epochs: [{ epoch: 0, weights: Object.fromEntries(exp.variants.map((v) => [v.key, v.weight])), at: exp.createdAt, reason: 'launch' }],
    legacy: true,
    // A step split records no actor (the route never passed one); `system`
    // keeps the row free of subject data.
    createdBy: 'system', createdAt: exp.createdAt, updatedAt: exp.stoppedAt ?? exp.createdAt,
    startedAt: exp.createdAt,
    ...(exp.stoppedAt ? { stoppedAt: exp.stoppedAt } : {}),
  };
}

export function stepFromEngine(e: Experiment): StepExperiment | null {
  if (e.surface.kind !== FUNNEL_STEP_SURFACE || (e.status !== 'running' && e.status !== 'stopped')) return null;
  return {
    experimentId: e.experimentId, status: e.status, salt: e.salt,
    variants: e.arms.map((a) => ({ key: a.key, pageId: a.ref, weight: a.weight })),
    ...(e.mode === 'optimize' ? { engineMode: 'optimize' as const } : e.epochs.some((x) => x.layout) ? { engineMode: 'ramp' as const } : {}),
    createdAt: e.createdAt,
    ...(e.stoppedAt ? { stoppedAt: e.stoppedAt } : {}),
  };
}

/** Write the engine row (authoritative); the caller then writes the funnel row.
 *  ADR 0949 P2a — an engine-managed (Decide) row keeps its plan, arms and
 *  epochs: only the lifecycle fields are merged onto it. */
export async function saveStepExperiment(tenantId: string, orgId: string, funnelId: string, stepId: string, exp: StepExperiment): Promise<void> {
  const current = await getExperimentRow(tenantId, orgId, exp.experimentId);
  if (current && current.legacy !== true) {
    const next: Experiment = { ...current, status: exp.status, updatedAt: exp.stoppedAt ?? current.updatedAt };
    if (exp.stoppedAt) next.stoppedAt = exp.stoppedAt;
    await putExperimentRow(next);
    return;
  }
  await putExperimentRow(stepToEngine(tenantId, orgId, funnelId, stepId, exp));
}

/** True when the experiment is engine-managed (a Decide experiment), not a
 *  legacy step split. */
export async function isManagedExperiment(tenantId: string, orgId: string, experimentId: string): Promise<boolean> {
  const row = await getExperimentRow(tenantId, orgId, experimentId);
  return !!row && row.legacy !== true;
}

/** A step's experiment loses its step (replaced, step removed, funnel deleted).
 *  A legacy split goes with it, as before P1b. A managed experiment is a record
 *  in its own right: it is kept, and stopped if it was running. */
export async function releaseStepExperiment(tenantId: string, orgId: string, experimentId: string, now: string): Promise<void> {
  const row = await getExperimentRow(tenantId, orgId, experimentId);
  if (!row) return;
  if (row.legacy === true) { await deleteStepExperiment(tenantId, orgId, experimentId); return; }
  if (row.status === 'running') await putExperimentRow({ ...row, status: 'stopped', stoppedAt: now, updatedAt: now });
}

/**
 * The step's experiment as the engine holds it. `mirror` is the embedded copy
 * from the funnel row the caller already read (the pointer). Null when the step
 * has none, or when the engine row is not a funnel step experiment.
 */
export async function resolveStepExperiment(tenantId: string, orgId: string, funnelId: string, stepId: string, mirror: StepExperiment | undefined): Promise<StepExperiment | null> {
  if (!mirror) return null;
  let row = await getExperimentRow(tenantId, orgId, mirror.experimentId);
  // ADR 0949 P2c — a step may carry the POINTER only (`{ experimentId }`, what
  // the contract step stores). Only a full copy (salt + variants) can be
  // imported or converge a stop: minting an engine row from a pointer would
  // write an experiment with no salt and no arms.
  const full = isFullStepExperiment(mirror);
  if (!row && full) {
    await insertExperimentRowIfAbsent(stepToEngine(tenantId, orgId, funnelId, stepId, mirror));
    row = await getExperimentRow(tenantId, orgId, mirror.experimentId);
  } else if (row && full && row.status === 'running' && mirror.status === 'stopped') {
    row = { ...row, status: 'stopped', stoppedAt: mirror.stoppedAt ?? row.updatedAt, updatedAt: mirror.stoppedAt ?? row.updatedAt };
    await putExperimentRow(row);
  }
  if (!row || row.surface.ref !== `${funnelId}:${stepId}`) return null;
  return stepFromEngine(row);
}

/** ADR 0949 P2c (A2) — the experiment a step POINTS at, as the funnel shows
 *  it, whatever its engine status. `resolveStepExperiment` answers only for a
 *  running or stopped experiment (serving and results read it), but a step
 *  stays linked to its experiment after a promotion concludes it: the
 *  promotion's rollback finds its step by that link. An ended experiment no
 *  longer assigns, so it shows as stopped. Null when the engine does not hold
 *  the experiment for this step. */
export async function linkedStepExperiment(tenantId: string, orgId: string, funnelId: string, stepId: string, experimentId: string): Promise<StepExperiment | null> {
  const row = await getExperimentRow(tenantId, orgId, experimentId);
  if (!row || row.surface.ref !== `${funnelId}:${stepId}` || row.surface.kind !== FUNNEL_STEP_SURFACE) return null;
  const live = stepFromEngine(row);
  if (live) return live;
  if (row.status === 'proposed' || row.status === 'draft') return null;
  const stoppedAt = row.stoppedAt ?? row.updatedAt;
  return stepFromEngine({ ...row, status: 'stopped', stoppedAt });
}

/** ADR 0949 P2c (A3) — whether a step may store its experiment as the bare
 *  pointer: exactly when `linkedStepExperiment` answers for it. Every read
 *  hydrates and prefers that answer over a stored copy, so the pointer loses
 *  nothing a reader sees, and A2 (the rollback floor, which hydrates the same
 *  way) reads it back the same. That covers a managed experiment that ends with
 *  no funnel write (concluded, promoted, abandoned, rolled back: shown stopped).
 *  A `proposed` or `draft` experiment, or one held for another step, keeps the
 *  full copy; nothing returns an experiment to either status, and only a draft
 *  that never launched is deleted.
 *  (A2 stored the pointer only for a legacy split, running or stopped, because
 *  its floor A1 dropped a pointer to an ended experiment.) */
export async function storesAsPointer(tenantId: string, orgId: string, funnelId: string, stepId: string, experimentId: string): Promise<boolean> {
  return (await linkedStepExperiment(tenantId, orgId, funnelId, stepId, experimentId)) !== null;
}

/** ADR 0949 P2c — whether a step's embedded experiment is a full copy (the
 *  P1b rollback mirror) rather than the bare pointer. */
export function isFullStepExperiment(e: StepExperiment | undefined): e is StepExperiment {
  return !!e && typeof e.salt === 'string' && Array.isArray(e.variants);
}

/** Remove a step experiment's engine row and its derived rollup. */
export async function deleteStepExperiment(tenantId: string, orgId: string, experimentId: string): Promise<void> {
  await deleteExperimentRow(tenantId, orgId, experimentId);
  await deleteExperimentRollup(tenantId, orgId, experimentId);
  await deleteFirstExposures({ tenantId, experimentId });
}
