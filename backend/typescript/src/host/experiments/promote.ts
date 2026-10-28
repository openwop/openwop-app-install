/**
 * ADR 0950 P1 — the promotion actions on the engine, each idempotent and
 * CAS-guarded, each appending a decision to the tenant's hash chain:
 *
 *   applyRamp   append a `ramp` epoch whose band layout grows the winner
 *               monotonically (`rampLayout`); keyed by `stage`, so a retry or a
 *               fork finds the stage applied and changes nothing.
 *   finalize    the surface ships the winner's content and returns what it
 *               replaced (`baselineRef`), recorded on the experiment.
 *   rollback    a `rollback` epoch (every unit back on control), status
 *               `rolled_back`, and the surface restores the recorded baseline.
 *               Never blocked by policy (D4): it moves toward the known baseline.
 *
 * The decision log entry (`experiment.decision`, D6) carries ids, the stage,
 * the numbers and the actor, never content or visitor identifiers.
 */
import { OpenwopError } from '../../types.js';
import { appendAudit } from '../auditChainService.js';
import { rampLayout } from '../variantAssignment.js';
import { experimentSurface } from './adapters.js';
import { getExperimentRow, mutateExperimentRow } from './store.js';
import type { AllocationEpoch, Experiment, PromotionAdmission } from './types.js';

function conflict(reason: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new OpenwopError('conflict', message, 409, { reason, ...extra });
}
const notFound = (): never => { throw new OpenwopError('not_found', 'Experiment not found.', 404, {}); };

export interface PromotionContext { actor: string; runId?: string; now: string }

/** D3 — the winner's share at each stage: 50, 90, then everything but the holdout. */
export function stagePct(stage: number, holdoutPct: number): number {
  if (stage === 1) return 50;
  if (stage === 2) return 90;
  if (stage === 3) return 100 - holdoutPct;
  throw new OpenwopError('validation_error', `A promotion has stages 1, 2 and 3 (got ${stage}).`, 400, { field: 'stage', reason: 'invalid_stage' });
}
export const MIN_HOLDOUT_PCT = 1;
export const MAX_HOLDOUT_PCT = 5;

/** D3 — a stage is judged no sooner than 24 hours after it applied. A test may
 *  shorten it, never production (`NODE_ENV === 'test'` only). */
export const MIN_STAGE_MS = 24 * 3_600_000;
export function minStageMs(): number {
  const raw = Number(process.env.OPENWOP_EXPERIMENTS_MIN_STAGE_MS);
  return process.env.NODE_ENV === 'test' && Number.isFinite(raw) && raw >= 0 ? raw : MIN_STAGE_MS;
}

/** The chokepoint (architect review #1): only the experiment's claimed promotion
 *  run may ramp, finalize or roll back through a run. */
export function assertPromotionRun(exp: Experiment, runId: string | undefined): void {
  const bare = runId ? runId.slice(runId.lastIndexOf('/') + 1) : undefined;
  if (!bare || exp.promotionRunId !== bare) {
    conflict('not_the_promotion_run', 'Only the run that started this promotion may change it. Start a promotion from the experiment.');
  }
}

/** A missing run may still be inside the starter's insert window. */
export type PromotionRunState = 'live' | 'terminal' | 'missing';
export const PROMOTION_START_GRACE_MS = 5 * 60_000;

/** Claim before starting the run. Missing runs retain their reservation for the
 * startup grace; terminal runs release immediately. The row CAS checks both the
 * holder and reservation time so a competing claim cannot be overwritten. */
export async function claimPromotionRun(
  tenantId: string, orgId: string, experimentId: string, runId: string,
  readRunState: (runId: string) => Promise<PromotionRunState>, now = new Date().toISOString(),
  admission?: PromotionAdmission,
): Promise<Experiment> {
  const exp = (await getExperimentRow(tenantId, orgId, experimentId)) ?? notFound();
  const holder = exp.promotionRunId;
  if (holder && holder !== runId) {
    const state = await readRunState(holder);
    if (state === 'missing' && exp.promotionRunClaimedAt === undefined) {
      // Older claims predate reservation timestamps. Start their grace when
      // first observed missing; do not guess that an in-flight insert crashed.
      await mutateExperimentRow(tenantId, orgId, experimentId, (row) => {
        if (row.promotionRunId !== holder || row.promotionRunClaimedAt !== undefined) {
          conflict('promotion_in_progress', 'This experiment is already being promoted.', { runId: row.promotionRunId });
        }
        return { ...row, promotionRunClaimedAt: now };
      });
      conflict('promotion_in_progress', 'The previous run is missing. Its startup grace has begun; retry after the grace period.', { runId: holder });
    }
    const claimedAt = Date.parse(exp.promotionRunClaimedAt ?? '');
    // An unreadable reservation is refused rather than guessed stale.
    const pending = state === 'missing' && (!Number.isFinite(claimedAt) || Date.parse(now) - claimedAt < PROMOTION_START_GRACE_MS);
    if (state === 'live' || pending) conflict('promotion_in_progress', 'This experiment is already being promoted.', { runId: holder });
  }
  const next = await mutateExperimentRow(tenantId, orgId, experimentId, (row) => {
    if (row.promotionRunId !== holder || row.promotionRunClaimedAt !== exp.promotionRunClaimedAt) {
      conflict('promotion_in_progress', 'This experiment is already being promoted.', { runId: row.promotionRunId });
    }
    if (admission) {
      const epoch = [...row.epochs].reverse().find((entry) => entry.reason === 'ramp');
      if (row.status !== 'running' || row.mode !== 'decide' || row.legacy || row.plan?.planHash !== admission.planHash
        || (admission.resumedFromStage === undefined ? !!row.promotion : row.promotion?.winner !== admission.winner
          || row.promotionGate?.winner !== admission.winner || row.promotionGate?.planHash !== admission.planHash
          || epoch?.stage !== admission.resumedFromStage || epoch?.epoch !== admission.epoch)) {
        conflict('promotion_admission_changed', 'The experiment changed after its promotion checks. Retry.');
      }
    }
    return { ...row, promotionRunId: runId, promotionRunClaimedAt: now,
      ...(admission && !row.promotion ? { promotionGate: admission } : {}) };
  });
  return next ?? notFound();
}

/** Undo a claim whose run never started. */
export async function releasePromotionRun(tenantId: string, orgId: string, experimentId: string, runId: string): Promise<void> {
  await mutateExperimentRow(tenantId, orgId, experimentId, (row) => {
    if (row.promotionRunId !== runId) return null;
    const { promotionRunId: _gone, promotionRunClaimedAt: _claimedAt, ...rest } = row;
    return rest;
  });
}

async function logDecision(exp: Experiment, action: 'ramp' | 'finalize' | 'rollback', ctx: PromotionContext, detail: Record<string, unknown>): Promise<void> {
  await appendAudit(exp.tenantId, 'experiment.decision', {
    experimentId: exp.experimentId, orgId: exp.orgId, ...(exp.campaignId ? { campaignId: exp.campaignId } : {}),
    ...(ctx.runId ? { runId: ctx.runId } : {}), action, planHash: exp.plan?.planHash ?? null, actor: ctx.actor, ...detail,
  });
}

const totals = (layout: ReadonlyArray<{ key: string; weight: number }>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const s of layout) out[s.key] = (out[s.key] ?? 0) + s.weight;
  return out;
};

/** A stage already applied is `existing` only when the retry asks for the same
 *  stage: a replay or a retried node repeats its inputs exactly, so different
 *  numbers under one stage are a caller bug, refused rather than ignored. */
function sameStage(exp: Experiment, done: AllocationEpoch, input: { winner: string; winnerPct: number; holdoutPct: number }): 'existing' {
  if ((done.weights[input.winner] ?? 0) !== input.winnerPct || exp.promotion?.winner !== input.winner || exp.promotion?.holdoutPct !== input.holdoutPct) {
    conflict('stage_mismatch', 'This stage was already applied with different numbers.', { stage: done.stage });
  }
  return 'existing';
}

/** Apply promotion stage `stage` (1, 2, 3 …): the winner at `winnerPct`, a
 *  `holdoutPct` control band kept aside. Idempotent per stage. */
export async function applyRamp(tenantId: string, orgId: string, experimentId: string, input: { stage: number; winner: string; winnerPct: number; holdoutPct: number }, ctx: PromotionContext): Promise<{ experiment: Experiment; outcome: 'applied' | 'existing' }> {
  const exp = (await getExperimentRow(tenantId, orgId, experimentId)) ?? notFound();
  if (exp.promotionRunId !== undefined) assertPromotionRun(exp, ctx.runId);
  const same = (e: AllocationEpoch): boolean => e.reason === 'ramp' && e.stage === input.stage;
  const applied = exp.epochs.find(same);
  if (applied) return { experiment: exp, outcome: sameStage(exp, applied, input) };
  const state: { outcome: 'applied' | 'existing' } = { outcome: 'existing' };
  // Every refusal is decided on the row the CAS writes, so two concurrent stages
  // cannot both pass an order check made on a stale read (code-review).
  // The mutator re-runs on a CAS retry, so each attempt resets the flag.
  const next = await mutateExperimentRow(tenantId, orgId, experimentId, (row) => {
    if (exp.promotionRunId !== undefined || row.promotionRunId !== undefined) assertPromotionRun(row, ctx.runId);
    state.outcome = 'existing';
    const done = row.epochs.find(same);
    if (done) { sameStage(row, done, input); return null; }
    if (row.status !== 'running') conflict('not_running', `Only a running experiment ramps (status: ${row.status}).`, { status: row.status });
    if (row.mode !== 'decide' || row.legacy === true || !row.plan) conflict('not_decide', 'Only a Decide experiment with a locked plan is promoted.');
    const launch = row.epochs.find((e) => e.reason === 'launch') ?? conflict('not_launched', 'The experiment has no launch epoch.');
    const control = row.arms[0]!.key;
    const previous = [...row.epochs].reverse().find((e) => e.reason === 'ramp');
    if (previous && previous.stage !== undefined && input.stage <= previous.stage) conflict('stage_out_of_order', `Stage ${input.stage} comes after stage ${previous.stage}.`);
    if (previous && (previous.weights[input.winner] ?? 0) > input.winnerPct) conflict('ramp_shrinks', 'A ramp never gives the winner less than the previous stage.');
    if (row.promotion && row.promotion.winner !== input.winner) conflict('winner_changed', 'A promotion ramps one winner.');
    // The holdout band is fixed for the whole promotion: a different size moves
    // the band edge, and units on the winner would cross back to control (D3).
    if (row.promotion && row.promotion.holdoutPct !== input.holdoutPct) conflict('holdout_changed', `The holdout stays at ${row.promotion.holdoutPct}% for the whole promotion.`);
    let layout: Array<{ key: string; weight: number }>;
    try {
      layout = rampLayout(row.arms.map((a) => ({ key: a.key, weight: launch.weights[a.key] ?? 0 })), input.winner, input.winnerPct, input.holdoutPct, control);
    } catch (err) {
      throw new OpenwopError('validation_error', err instanceof Error ? err.message : 'invalid ramp', 400, { reason: 'invalid_ramp' });
    }
    state.outcome = 'applied';
    const epoch: AllocationEpoch = {
      epoch: Math.max(...row.epochs.map((e) => e.epoch)) + 1, weights: totals(layout), layout, at: ctx.now, reason: 'ramp', stage: input.stage,
      ...(ctx.runId ? { decidedByRunId: ctx.runId } : {}),
    };
    return { ...row, epochs: [...row.epochs, epoch], promotion: { ...(row.promotion ?? {}), winner: input.winner, holdoutPct: input.holdoutPct }, updatedAt: ctx.now };
  });
  const result = next ?? exp;
  if (state.outcome === 'applied') await logDecision(result, 'ramp', ctx, { stage: input.stage, winner: input.winner, winnerPct: input.winnerPct, holdoutPct: input.holdoutPct });
  return { experiment: result, outcome: state.outcome };
}

/** A surface receipt owns the content commit. An acknowledgement can fail after
 * that commit, so retry the same receipt until it confirms the original baseline;
 * finalizedAt records completion only after that confirmation. */
export async function finalize(tenantId: string, orgId: string, experimentId: string, ctx: PromotionContext): Promise<{ experiment: Experiment; outcome: 'finalized' | 'existing'; pendingApproval: boolean }> {
  const exp = (await getExperimentRow(tenantId, orgId, experimentId)) ?? notFound();
  if (exp.promotionRunId !== undefined) assertPromotionRun(exp, ctx.runId);
  if (exp.promotion?.finalizedAt) return { experiment: exp, outcome: 'existing', pendingApproval: exp.promotion.pendingApproval === true };
  if (!exp.promotion) conflict('not_ramped', 'Ramp the winner before finalizing it.');
  const adapter = experimentSurface(exp.surface.kind);
  if (!adapter?.finalize || !adapter.restoreBaseline) conflict('surface_cannot_promote', `A ${exp.surface.kind} experiment has no recoverable promotion yet.`);
  const winner = exp.promotion.winner;
  const refuseStopped = async (row: Experiment): Promise<never> => {
    if (row.status === 'rolled_back') {
      await rollback(tenantId, orgId, experimentId, { ...ctx, reason: 'finalize_crossed_rollback' });
      conflict('promotion_rolled_back', 'The promotion was rolled back while publishing.');
    }
    // Stop/abandon may win after the surface committed but before its engine
    // acknowledgement. Reconcile the same closed receipt, including on a retry
    // after restart; never claim completion or leave the unacknowledged winner.
    if (row.promotion?.finalizeRequestedAt && !row.promotion.finalizedAt) {
      await adapter.restoreBaseline!(row, row.promotion.baselineRef ?? null, ctx.actor);
    }
    return conflict('not_running', `The promotion stopped while publishing (status: ${row.status}).`, { status: row.status });
  };
  if (exp.status !== 'running') return refuseStopped(exp);
  // Admission is revalidated in an authoritative row CAS BEFORE the surface
  // effect. This records intent only; a crash or throw never makes it complete.
  const admitted = await mutateExperimentRow(tenantId, orgId, experimentId, (row) => {
    if (exp.promotionRunId !== undefined || row.promotionRunId !== undefined) assertPromotionRun(row, ctx.runId);
    if (row.promotion?.winner !== winner) conflict('winner_changed', 'The promotion winner changed before publishing.');
    if (row.promotion.finalizedAt) return null;
    if (row.status !== 'running') conflict('not_running', 'The promotion stopped before publishing.');
    return { ...row, promotion: { ...row.promotion, finalizeRequestedAt: row.promotion.finalizeRequestedAt ?? ctx.now } };
  }) ?? notFound();
  if (admitted.promotion?.finalizedAt) return { experiment: admitted, outcome: 'existing', pendingApproval: admitted.promotion.pendingApproval === true };
  // Never infer "nothing shipped" from a throw, nor replace a durable baseline.
  const shipped = await adapter!.finalize!(admitted, winner, ctx.actor);
  const state = { applied: false };
  const next = await mutateExperimentRow(tenantId, orgId, experimentId, (row) => {
    state.applied = false;
    if (exp.promotionRunId !== undefined || row.promotionRunId !== undefined) assertPromotionRun(row, ctx.runId);
    if (row.promotion?.winner !== winner) conflict('winner_changed', 'The promotion winner changed while publishing.');
    if (row.status !== 'running' || row.promotion.finalizedAt) return null;
    state.applied = true;
    return { ...row, promotion: { ...row.promotion, baselineRef: shipped.baselineRef,
      pendingApproval: shipped.pendingApproval === true, finalizedAt: ctx.now }, updatedAt: ctx.now };
  });
  const result = next ?? (await getExperimentRow(tenantId, orgId, experimentId)) ?? notFound();
  if (result.status === 'rolled_back' || (result.status !== 'running' && !result.promotion?.finalizedAt)) return refuseStopped(result);
  if (state.applied) await logDecision(result, 'finalize', ctx, { winner, baselineRecorded: shipped.baselineRef !== null, pendingApproval: shipped.pendingApproval === true });
  return { experiment: result, outcome: state.applied ? 'finalized' : 'existing', pendingApproval: result.promotion?.pendingApproval === true };
}

/** Traffic returns to control first. A terminal status is not proof that the
 * content restored: retries continue the surface receipt until its ack is durable. */
export async function rollback(tenantId: string, orgId: string, experimentId: string, ctx: PromotionContext & { reason: string }): Promise<{ experiment: Experiment; outcome: 'rolled_back' | 'existing' }> {
  const exp = (await getExperimentRow(tenantId, orgId, experimentId)) ?? notFound();
  if (exp.promotionRunId !== undefined) assertPromotionRun(exp, ctx.runId);
  if (!exp.promotion) conflict('not_promoting', 'There is no promotion to roll back.');
  if (exp.status === 'rolled_back' && exp.promotion.contentRestoredAt) return { experiment: exp, outcome: 'existing' };
  const control = exp.arms[0]!.key;
  const next = await mutateExperimentRow(tenantId, orgId, experimentId, (row) => {
    if (exp.promotionRunId !== undefined || row.promotionRunId !== undefined) assertPromotionRun(row, ctx.runId);
    if (row.status === 'rolled_back') return null;
    if (!row.promotion || row.promotion.winner !== exp.promotion!.winner) conflict('winner_changed', 'The promotion changed before rollback.');
    return { ...row, status: 'rolled_back',
      epochs: [...row.epochs, { epoch: Math.max(...row.epochs.map((e) => e.epoch)) + 1, weights: { [control]: 100 }, layout: [{ key: control, weight: 100 }], at: ctx.now, reason: 'rollback', ...(ctx.runId ? { decidedByRunId: ctx.runId } : {}) }],
      promotion: { ...row.promotion, rolledBackAt: ctx.now }, stoppedAt: row.stoppedAt ?? ctx.now, updatedAt: ctx.now };
  });
  const pending = next ?? (await getExperimentRow(tenantId, orgId, experimentId)) ?? notFound();
  const adapter = experimentSurface(pending.surface.kind);
  if (!adapter?.restoreBaseline) conflict('surface_cannot_promote', 'The surface cannot confirm baseline restoration.');
  // The adapter owns the original baseline, including an in-flight finalize
  // whose acknowledgement never reached the engine. Null is not "skip restore".
  await adapter!.restoreBaseline!(pending, pending.promotion?.baselineRef ?? null, ctx.actor);
  const state = { completed: false };
  const completed = await mutateExperimentRow(tenantId, orgId, experimentId, (row) => {
    state.completed = false;
    if (exp.promotionRunId !== undefined || row.promotionRunId !== undefined) assertPromotionRun(row, ctx.runId);
    if (row.status !== 'rolled_back' || row.promotion?.winner !== exp.promotion!.winner) conflict('promotion_changed', 'The promotion changed while restoring its baseline.');
    if (row.promotion.contentRestoredAt) return null;
    state.completed = true;
    return { ...row, promotion: { ...row.promotion, contentRestoredAt: ctx.now }, updatedAt: ctx.now };
  });
  const result = completed ?? (await getExperimentRow(tenantId, orgId, experimentId)) ?? notFound();
  if (state.completed) await logDecision(result, 'rollback', ctx, { reason: ctx.reason, restoredBaseline: true });
  return { experiment: result, outcome: state.completed ? 'rolled_back' : 'existing' };
}
