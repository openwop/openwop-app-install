/**
 * ADR 0950 P0 — the promotion gates for one experiment, read-only: rebuild the
 * rollup through the surface adapter, compute the Decide verdict, ask the
 * surface whether the winner's content may be published now (G8), and evaluate
 * the eight gates over that snapshot. Promotes nothing (that is P1/P2).
 */
import { experimentSurface } from './adapters.js';
import { evaluateGates, type GateReport } from './gates.js';
import { observeExperiment, verdictFromCells } from './observe.js';
import type { Experiment, PromotionAdmission } from './types.js';
import { OpenwopError } from '../../types.js';
import { minStageMs } from './promote.js';
import { evaluateStageCheck } from './stageCheck.js';
import { MIN_SESSIONS_PER_VARIANT } from '../variantAssignment.js';

export async function checkPromotionGates(exp: Experiment, now: string): Promise<GateReport> {
  const obs = await observeExperiment(exp, now);
  const verdict = verdictFromCells(exp, obs.cells, obs.coverage, now);
  const first = evaluateGates({ experiment: exp, cells: obs.cells, verdict, now, content: null });
  if (!first.winner) return first;
  const check = experimentSurface(exp.surface.kind)?.checkPromotable;
  const content = check ? await check(exp, first.winner) : null;
  return evaluateGates({ experiment: exp, cells: obs.cells, verdict, now, content });
}

/** New promotions elect a winner through all eight gates. A stopped promotion
 * run resumes the already elected winner, checked on the current stage's exact
 * cohort/allocation. Launch-weight SRM over mixed ramp history is meaningless. */
export async function checkPromotionAdmission(exp: Experiment, now: string): Promise<PromotionAdmission> {
  if (!exp.promotion) {
    const report = await checkPromotionGates(exp, now);
    if (!report.allPass || !report.winner || !exp.plan) {
      const failed = report.gates.filter((gate) => gate.status !== 'pass').map((gate) => gate.id);
      throw new OpenwopError('conflict', `Promotion gates not met: ${failed.join(', ')}.`, 409, { reason: 'gate_failed', gates: failed });
    }
    return { winner: report.winner, planHash: exp.plan.planHash, cellsHash: report.snapshot.cellsHash, checkedAt: now };
  }
  const prior = exp.promotionGate;
  const epoch = [...exp.epochs].reverse().find((entry) => entry.reason === 'ramp');
  if (exp.status !== 'running' || exp.mode !== 'decide' || exp.legacy || !exp.plan || !prior
    || prior.planHash !== exp.plan.planHash || prior.winner !== exp.promotion.winner
    || !epoch || epoch.stage === undefined || !Number.isInteger(epoch.stage) || epoch.stage < 1 || epoch.stage > 3
    || !exp.arms.some((arm, index) => index > 0 && arm.key === prior.winner)) {
    throw new OpenwopError('conflict', 'This promotion has no matching original gate evidence to resume.', 409, { reason: 'promotion_resume_unverified' });
  }
  if (!Number.isFinite(Date.parse(epoch.at)) || Date.parse(now) - Date.parse(epoch.at) < minStageMs()) {
    throw new OpenwopError('conflict', 'The current promotion stage is not ready to be judged.', 409, { reason: 'stage_too_soon', since: epoch.at });
  }
  const observation = await observeExperiment(exp, now, { firstExposedSince: epoch.at });
  const check = evaluateStageCheck({ experiment: exp, cells: observation.cells, coverage: observation.coverage, epoch, now,
    kind: exp.promotion.finalizedAt ? 'monitor' : 'recheck', minUnitsPerArm: Math.ceil((exp.plan.minSamplePerArm ?? MIN_SESSIONS_PER_VARIANT) / 4) });
  if (check.outcome !== 'pass') {
    throw new OpenwopError('conflict', 'The current promotion stage does not pass its safety checks.', 409, { reason: 'promotion_resume_gate_failed', stage: epoch.stage, outcome: check.outcome, stageReason: check.reason });
  }
  const content = await experimentSurface(exp.surface.kind)?.checkPromotable?.(exp, prior.winner);
  if (!content?.ok) throw new OpenwopError('conflict', 'The recorded winner cannot be published now.', 409, { reason: 'gate_failed', gates: ['G8'] });
  return { winner: prior.winner, planHash: prior.planHash, cellsHash: check.snapshot.cellsHash, checkedAt: now, resumedFromStage: epoch.stage, epoch: epoch.epoch };
}
