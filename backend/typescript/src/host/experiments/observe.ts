/**
 * ADR 0950 P0 — ONE implementation of "rebuild this experiment's rollup through
 * its surface adapter and read the totals", shared by the experiments routes,
 * the promotion gates and the CMS promote path (it used to live inside the
 * experiments service). The rollup is a derived cache; a rebuild is idempotent.
 */
import { OpenwopError } from '../../types.js';
import { experimentSurface } from './adapters.js';
import { decideVerdict, type DecideResult } from './decide.js';
import { foldDailyCells, readExperimentRollup, totalsByArm, writeExperimentRollup, type ExperimentDailyCell } from './rollup.js';
import type { Experiment } from './types.js';

export interface ObservedExperiment {
  cells: ExperimentDailyCell[];
  totals: Map<string, { n: number; sum: number }>;
  coverage: 'complete' | 'partial';
  retainedSince: string | null;
}

export async function observeExperiment(
  exp: Experiment, now: string, options: { firstExposedSince?: string } = {},
): Promise<ObservedExperiment> {
  const asOf = Date.parse(now);
  const since = options.firstExposedSince === undefined ? undefined : Date.parse(options.firstExposedSince);
  if (since !== undefined && (!Number.isFinite(since) || !Number.isFinite(asOf))) {
    throw new OpenwopError('validation_error', 'The stage cohort needs valid start and end instants.', 400, { field: 'firstExposedSince' });
  }
  const adapter = experimentSurface(exp.surface.kind);
  if (!adapter) throw new OpenwopError('validation_error', `Experiments cannot run on \`${exp.surface.kind}\`.`, 400, { field: 'surface.kind', reason: 'unsupported_surface' });
  const obs = await adapter.observe(exp);
  await writeExperimentRollup(exp.tenantId, exp.orgId, exp.experimentId, foldDailyCells(exp.tenantId, exp.orgId, exp.experimentId, obs.units),
    { coverage: obs.coverage, sourceRetainedSince: obs.sourceRetainedSince }, now);
  // Stage cohorts are filtered on raw first-exposure instants, before daily
  // aggregation. Filtering the daily cells includes pre-ramp units on that day.
  // The shared cache above stays the FULL experiment; a stage read cannot
  // overwrite the ordinary results and gate checklist with a partial cohort.
  if (since !== undefined) {
    const units = obs.units.filter((u) => { const at = Date.parse(u.firstExposureAt); return at >= since && at <= asOf; });
    const cells = foldDailyCells(exp.tenantId, exp.orgId, exp.experimentId, units);
    return { cells, totals: totalsByArm(cells), coverage: obs.coverage, retainedSince: obs.sourceRetainedSince };
  }
  const { cells, header } = await readExperimentRollup(exp.tenantId, exp.orgId, exp.experimentId);
  return { cells, totals: totalsByArm(cells), coverage: header?.coverage ?? obs.coverage, retainedSince: header?.sourceRetainedSince ?? obs.sourceRetainedSince };
}

/** The Decide verdict over a set of cells (primary + guardrail totals). Pure. */
export function verdictFromCells(exp: Experiment, cells: readonly ExperimentDailyCell[], coverage: 'complete' | 'partial', now: string): DecideResult {
  const totals = totalsByArm(cells);
  const guardrailTotals = new Map((exp.plan?.guardrails ?? []).map((g) => [g.metric.name, totalsByArm(cells, g.metric.name)] as const));
  return decideVerdict(exp, exp.arms.map((a) => ({
    key: a.key, units: totals.get(a.key)?.n ?? 0, conversions: totals.get(a.key)?.sum ?? 0,
    guardrails: Object.fromEntries([...guardrailTotals].map(([m, t]) => [m, t.get(a.key)?.sum ?? 0])),
  })), coverage, now);
}
