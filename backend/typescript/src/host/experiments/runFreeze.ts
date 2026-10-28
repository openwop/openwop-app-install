/**
 * ADR 0949 D3 / P3 — assignment for run-based units (a contact in a journey or
 * an email send), frozen per run so a replay or a `:fork` assigns exactly as the
 * source did.
 *
 * What is frozen is ONE instant, `run.metadata['openwop-app.experiments'].asOf`,
 * stamped at run start by a run-start contributor (ADR 0099). Allocation epochs
 * are append-only and each carries its `at`, so the instant determines, for
 * every experiment, the epoch (and therefore the weights) in effect when the run
 * began. A `:fork` copies the stamp verbatim and the contributor contributes
 * nothing to a derived run (ADR 0604), so the fork keeps the source's weights
 * even after an Optimize epoch or a ramp moved them. This replaces D1's
 * per-experiment `{planHash, epoch, weights}` map: it needs no store read at run
 * start and cannot go stale, and the planHash is immutable once locked.
 */
import { resolveOne } from '../featureToggles/service.js';
import type { RunStartContext } from '../runStartContext.js';
import { assignWeightedVariant } from '../variantAssignment.js';
import type { AllocationEpoch, Arm, Experiment } from './types.js';

export const EXPERIMENTS_RUN_KEY = 'openwop-app.experiments';

export interface ExperimentsRunStamp { asOf: string }

export function readExperimentsRunStamp(metadata: Readonly<Record<string, unknown>> | undefined): ExperimentsRunStamp | null {
  const raw = metadata?.[EXPERIMENTS_RUN_KEY] as { asOf?: unknown } | undefined;
  return raw && typeof raw.asOf === 'string' ? { asOf: raw.asOf } : null;
}

/** Stamp the run's assignment instant; nothing on a derived (forked) run, and
 *  nothing for a tenant without the `experiments` feature. */
export async function experimentsRunStartContributor(ctx: RunStartContext): Promise<Record<string, unknown>> {
  if (ctx.derivedFromRun) return {};
  const toggle = await resolveOne('experiments', { tenantId: ctx.tenantId });
  if (!toggle?.enabled) return {};
  return { [EXPERIMENTS_RUN_KEY]: { asOf: new Date().toISOString() } satisfies ExperimentsRunStamp };
}

/** The epoch in effect at `asOf`: the latest one at or before it, else the
 *  launch epoch (an experiment launched after the run began assigns at launch
 *  weights). Null for an experiment that never launched. */
export function epochAt(exp: Pick<Experiment, 'epochs'>, asOf: string): AllocationEpoch | null {
  let found: AllocationEpoch | null = null;
  for (const e of exp.epochs) if (e.at <= asOf && (!found || e.epoch > found.epoch)) found = e;
  return found ?? exp.epochs[0] ?? null;
}

export interface UnitAssignment { arm: Arm; epoch: number; weights: Record<string, number> }

/** Was the experiment assigning at `asOf`? Running now, or stopped, abandoned
 *  or rolled back (ADR 0950) only AFTER the run began, so a fork taken after
 *  the stop still assigns exactly as its source did. */
function assigningAt(exp: Experiment, asOf: string): boolean {
  if (exp.status === 'running') return true;
  return (exp.status === 'stopped' || exp.status === 'abandoned' || exp.status === 'rolled_back') && !!exp.startedAt && !!exp.stoppedAt && exp.stoppedAt > asOf;
}

/**
 * A unit's arm at `asOf`: `assignWeightedVariant(unitKey, scope, salt, weights
 * of the epoch in effect)`. Only an experiment that was assigning at `asOf`
 * assigns; anything else is `null` and the caller treats the unit as untested.
 */
export function assignAt(exp: Experiment, unitKey: string, asOf: string): UnitAssignment | null {
  if (!unitKey || !assigningAt(exp, asOf)) return null;
  const epoch = epochAt(exp, asOf);
  if (!epoch) return null;
  // A ramp epoch carries its band layout (ADR 0950 D3); the layout, not the
  // per-arm totals, decides which band a bucket falls in.
  const arms = epoch.layout ?? exp.arms.map((a) => ({ key: a.key, weight: epoch.weights[a.key] ?? 0 })).filter((a) => a.weight > 0);
  const key = assignWeightedVariant(unitKey, exp.assignmentScope ?? exp.experimentId, exp.salt, arms);
  const arm = exp.arms.find((a) => a.key === key);
  return arm ? { arm, epoch: epoch.epoch, weights: epoch.weights } : null;
}
