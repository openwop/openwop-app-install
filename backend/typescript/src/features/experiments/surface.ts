/**
 * Experiments workflow surface (ADR 0949 P2b) — `ctx.features.experiments`.
 * The same service functions the routes call, behind the same org floor: every
 * op takes `orgId` and checks it against the run's actor (or the member who
 * caused an actorless run) with `assertRunScopeOrg`, `workspace:read` for reads
 * and `workspace:write` for writes (ADR 0832 / ADR 0921 D3).
 *
 * What a run may do: read, author a DRAFT (with its unlocked plan), lock the
 * plan, and stop a running experiment (which only reduces exposure). It may NOT
 * launch: a launch changes what the public sees, and the policy that decides
 * when an agent may do that is ADR 0942's. Until that gate lands, launch is a
 * human act in the Experiments page ("agent proposes, human disposes", the
 * funnels/promotions precedent).
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { assertRunScopeOrg } from '../../host/accessControlService.js';
import { OpenwopError } from '../../types.js';
import { powerCalc } from '../../host/experiments/decide.js';
import type { Experiment } from '../../host/experiments/types.js';
import { createDraft, getExperiment, listExperiments, lockPlan, optimizeEpoch, results, stop, updateDraft } from './experimentsService.js';
import { stickyAssign } from '../../host/experiments/sticky.js';
import { checkPromotionAdmission, checkPromotionGates } from '../../host/experiments/promotion.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { assignAt, readExperimentsRunStamp } from '../../host/experiments/runFreeze.js';
import { applyRamp, assertPromotionRun, finalize, minStageMs, rollback, stagePct } from '../../host/experiments/promote.js';
import { observeExperiment } from '../../host/experiments/observe.js';
import { evaluateStageCheck } from '../../host/experiments/stageCheck.js';
import { MIN_SESSIONS_PER_VARIANT } from '../../host/variantAssignment.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { AUTONOMY_TOGGLE, decideGate } from '../../host/autonomyPolicy/index.js';
import { promotionRead } from '../../host/experiments/promotionRead.js';
import { PROMOTE_CHAIN_ID } from './promotionService.js';

/** The run's frozen assignment instant (ADR 0949 P3): its stamp when the run has
 *  one (a fork carries the source's), else now (a runless caller). */
async function assignmentInstant(scope: BundleScope): Promise<{ asOf: string; frozen: boolean }> {
  if (scope.runId) {
    const run = await hostExtStorage().getRun(scope.runId);
    const stamp = run && run.tenantId === scope.tenantId ? readExperimentsRunStamp(run.metadata) : null;
    if (stamp) return { asOf: stamp.asOf, frozen: true };
  }
  return { asOf: new Date().toISOString(), frozen: false };
}

/** The fields a run sees: no tenant, no salt (the salt is what makes assignment
 *  unpredictable to a client; nothing in a workflow needs it). */
function project(e: Experiment): Record<string, unknown> {
  const { tenantId: _t, salt: _s, ...rest } = e;
  return rest;
}

const required = (v: unknown, field: string): string => {
  const out = str(v);
  if (!out) throw new OpenwopError('validation_error', `\`${field}\` is required.`, 400, { field });
  return out;
};
/** Who a run-authored row is attributed to: the actor, else the causing member, else the agent. */
const authorOf = (scope: BundleScope): string => scope.actingUserId ?? scope.orgScopeSubject ?? 'agent';

// Every method destructures exactly the keys it reads, so the pack↔surface
// parity scan (ADR 0624 D2) can check what each node sends.
export function buildExperimentsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  // ADR 0942's toggle contract: the policy applies only with Campaign Studio
  // orchestration AND its autonomy sub-toggle ON; otherwise `legacy`.
  const autonomyOn = async (): Promise<boolean> =>
    Boolean((await resolveOne('campaign-orchestration', { tenantId }).catch(() => null))?.enabled)
    && Boolean((await resolveOne(AUTONOMY_TOGGLE, { tenantId }).catch(() => null))?.enabled);
  const read = async (orgIdArg: unknown): Promise<string> => { const o = required(orgIdArg, 'orgId'); await assertRunScopeOrg(scope, o, 'workspace:read'); return o; };
  const write = async (orgIdArg: unknown): Promise<string> => { const o = required(orgIdArg, 'orgId'); await assertRunScopeOrg(scope, o, 'workspace:write'); return o; };
  return {
    list: async ({ orgId, kind, ref, status }) => {
      const o = await read(orgId);
      return { experiments: (await listExperiments(tenantId, o, { kind: str(kind) || undefined, ref: str(ref) || undefined, status: str(status) || undefined })).map(project) };
    },
    get: async ({ orgId, experimentId }) => {
      const o = await read(orgId);
      const e = await getExperiment(tenantId, o, required(experimentId, 'experimentId'));
      return { experiment: e ? project(e) : null };
    },
    results: async ({ orgId, experimentId }) => {
      const o = await read(orgId);
      return { ...(await results(tenantId, o, required(experimentId, 'experimentId'))) };
    },
    // ADR 0950 P0 — the promotion gates; the output carries the full snapshot
    // (planHash, cellsHash, computedAt, every gate value), so a replay shows it.
    checkGates: async ({ orgId, experimentId }) => {
      const o = await read(orgId);
      const e = await getExperiment(tenantId, o, required(experimentId, 'experimentId'));
      if (!e) throw new OpenwopError('not_found', 'Experiment not found.', 404, {});
      return promotionRead(scope, e, PROMOTE_CHAIN_ID, 'gates', async () => {
        const bare = scope.runId?.slice(scope.runId.lastIndexOf('/') + 1);
        if (e.promotion && bare && bare === e.promotionRunId) {
          const admission = await checkPromotionAdmission(e, new Date().toISOString());
          return { experimentId: e.experimentId, allPass: true, winner: admission.winner, phase: 'resume',
            gates: [{ id: 'current-stage', status: 'pass', value: { stage: admission.resumedFromStage, epoch: admission.epoch } }],
            snapshot: { planHash: admission.planHash, cellsHash: admission.cellsHash, computedAt: admission.checkedAt } };
        }
        return { ...(await checkPromotionGates(e, new Date().toISOString())) };
      });
    },
    powerCalc: async ({ orgId, baselineRate, mde, alpha, power }) => {
      await read(orgId);
      return { samplePerArm: powerCalc({ baselineRate, mde, alpha, power }) };
    },
    createDraft: async ({ orgId, name, hypothesis, surface, arms, plan, mode, optimize }) => {
      const o = await write(orgId);
      const e = await createDraft(tenantId, o, authorOf(scope), {
        name, surface, arms, ...(hypothesis !== undefined ? { hypothesis } : {}), ...(mode !== undefined ? { mode } : {}), ...(optimize !== undefined ? { optimize } : {}),
      });
      const withPlan = plan !== undefined ? await updateDraft(tenantId, o, e.experimentId, { plan }) : e;
      return { experiment: project(withPlan), proposed: true };
    },
    updateDraft: async ({ orgId, experimentId, name, hypothesis, arms, plan }) => {
      const o = await write(orgId);
      const patch: Record<string, unknown> = {};
      if (name !== undefined) patch.name = name;
      if (hypothesis !== undefined) patch.hypothesis = hypothesis;
      if (arms !== undefined) patch.arms = arms;
      if (plan !== undefined) patch.plan = plan;
      return { experiment: project(await updateDraft(tenantId, o, required(experimentId, 'experimentId'), patch)) };
    },
    lockPlan: async ({ orgId, experimentId, plan }) => {
      const o = await write(orgId);
      return { experiment: project(await lockPlan(tenantId, o, required(experimentId, 'experimentId'), plan)) };
    },
    // ADR 0949 P3 — a run-based unit's arm (a contact, an email recipient):
    // deterministic, at the run's frozen instant, so replay and :fork agree.
    assign: async ({ orgId, experimentId, unitKey }) => {
      const o = await read(orgId);
      const e = await getExperiment(tenantId, o, required(experimentId, 'experimentId'));
      if (!e) throw new OpenwopError('not_found', 'Experiment not found.', 404, {});
      const at = await assignmentInstant(scope);
      // Optimize: the unit's recorded first exposure wins (its weights move).
      const a = e.mode === 'optimize' ? await stickyAssign(e, required(unitKey, 'unitKey'), at.asOf) : assignAt(e, required(unitKey, 'unitKey'), at.asOf);
      return a
        ? { assigned: true, arm: a.arm.key, ref: a.arm.ref, control: a.arm.key === e.arms[0]?.key, epoch: a.epoch, asOf: at.asOf, frozen: at.frozen }
        : { assigned: false, reason: e.status === 'running' ? 'no_arm' : 'not_running_at_run_start', status: e.status, asOf: at.asOf, frozen: at.frozen };
    },
    // ADR 0949 P4 — the next Optimize epoch. Its number comes from the run's
    // frozen instant, so a replay or a fork finds it already appended.
    optimizeEpoch: async ({ orgId, experimentId }) => {
      const o = await write(orgId);
      const at = await assignmentInstant(scope);
      const r = await optimizeEpoch(tenantId, o, required(experimentId, 'experimentId'), { asOf: at.asOf, ...(scope.runId ? { runId: scope.runId } : {}) });
      const epoch = r.experiment.epochs.find((e) => e.epoch === r.epoch);
      return { outcome: r.outcome, epoch: r.epoch, weights: epoch?.weights ?? null, asOf: at.asOf, frozen: at.frozen };
    },
    stop: async ({ orgId, experimentId }) => {
      const o = await write(orgId);
      return { experiment: project(await stop(tenantId, o, required(experimentId, 'experimentId'), authorOf(scope))) };
    },

    // ── ADR 0950 P2 — the `experiments.promote` chain's steps ──────────────────
    // Every write refuses any run but the experiment's claimed promotion run
    // (`assertPromotionRun`), so a hand-launched copy of the chain changes nothing.

    /** D4 — the `experiment.promote` policy for THIS run, decided host-side by the
     *  ADR 0942 resolver from the run's frozen stamp. A run that is not bound to
     *  a campaign is `legacy` (one approval, the `core.approvalGate` posture). */
    policyResolve: async ({ orgId }) => {
      await read(orgId);
      const run = scope.runId ? await hostExtStorage().getRun(scope.runId) : null;
      if (!run || run.tenantId !== tenantId) return { mode: 'legacy' };
      return { ...decideGate({ run, actionClass: 'experiment.promote', facts: {}, toggleOn: await autonomyOn() }) };
    },
    /** D3 — stage 1, 2 or 3 at 50, 90 and 100 − holdout. Stage 1 re-checks every
     *  gate first (the approval may have taken days) and must name the same
     *  winner; later stages ramp the recorded winner. Idempotent per stage. */
    applyRamp: async ({ orgId, experimentId, stage, winner, holdoutPct }) => {
      const o = await write(orgId);
      const e = await getExperiment(tenantId, o, required(experimentId, 'experimentId'));
      if (!e) throw new OpenwopError('not_found', 'Experiment not found.', 404, {});
      assertPromotionRun(e, scope.runId);
      const n = Number(stage);
      const holdout = e.promotion?.holdoutPct ?? Number(holdoutPct);
      const now = new Date().toISOString();
      let target = e.promotion?.winner ?? str(winner);
      let gates: Record<string, unknown> | null = null;
      if (n === 1 && !e.epochs.some((x) => x.reason === 'ramp' && x.stage === 1)) {
        const report = await checkPromotionGates(e, now);
        gates = { allPass: report.allPass, winner: report.winner, snapshot: report.snapshot, failed: report.gates.filter((g) => g.status !== 'pass').map((g) => g.id) };
        if (!report.allPass) throw new OpenwopError('conflict', `A gate no longer passes: ${(gates.failed as string[]).join(', ')}.`, 409, { reason: 'gate_failed', gates: gates.failed });
        if (target && report.winner !== target) throw new OpenwopError('conflict', 'The winner changed since the gates were checked.', 409, { reason: 'winner_changed' });
        target = report.winner ?? '';
      }
      if (!target) throw new OpenwopError('validation_error', 'No winner to ramp.', 400, { field: 'winner' });
      const r = await applyRamp(tenantId, o, e.experimentId, { stage: n, winner: target, winnerPct: stagePct(n, holdout), holdoutPct: holdout }, { actor: authorOf(scope), ...(scope.runId ? { runId: scope.runId } : {}), now });
      const epoch = r.experiment.epochs.find((x) => x.reason === 'ramp' && x.stage === n);
      return { outcome: r.outcome, stage: n, winner: target, winnerPct: stagePct(n, holdout), holdoutPct: holdout, epoch: epoch?.epoch ?? null, weights: epoch?.weights ?? null, ...(gates ? { gates } : {}) };
    },
    /** D3/D5 — judge the latest stage on its own units: `recheck` (SRM at the
     *  stage's weights + guardrails) or `monitor` (also the primary vs the
     *  holdout). The output carries the snapshot. Refused before the 24 h floor. */
    stageCheck: async ({ orgId, experimentId, kind }) => {
      const o = await read(orgId);
      const e = await getExperiment(tenantId, o, required(experimentId, 'experimentId'));
      if (!e) throw new OpenwopError('not_found', 'Experiment not found.', 404, {});
      return promotionRead(scope, e, PROMOTE_CHAIN_ID, kind === 'monitor' ? 'monitor' : 'recheck', async () => {
        const epoch = [...e.epochs].reverse().find((x) => x.reason === 'ramp');
        if (!epoch) throw new OpenwopError('conflict', 'No stage has been applied yet.', 409, { reason: 'not_ramped' });
        const now = new Date().toISOString();
        if (Date.parse(now) - Date.parse(epoch.at) < minStageMs()) {
          throw new OpenwopError('conflict', 'A stage is judged no sooner than 24 hours after it applied.', 409, { reason: 'stage_too_soon', since: epoch.at });
        }
        const { cells, coverage } = await observeExperiment(e, now, { firstExposedSince: epoch.at });
        const minUnits = Math.ceil((e.plan?.minSamplePerArm ?? MIN_SESSIONS_PER_VARIANT) / 4);
        return { ...evaluateStageCheck({ experiment: e, cells, coverage, epoch, now, kind: kind === 'monitor' ? 'monitor' : 'recheck', minUnitsPerArm: minUnits }) };
      });
    },
    finalize: async ({ orgId, experimentId }) => {
      const o = await write(orgId);
      const e = await getExperiment(tenantId, o, required(experimentId, 'experimentId'));
      if (!e) throw new OpenwopError('not_found', 'Experiment not found.', 404, {});
      assertPromotionRun(e, scope.runId);
      const r = await finalize(tenantId, o, e.experimentId, { actor: authorOf(scope), ...(scope.runId ? { runId: scope.runId } : {}), now: new Date().toISOString() });
      return { outcome: r.outcome, pendingApproval: r.pendingApproval, baselineRecorded: r.experiment.promotion?.baselineRef != null };
    },
    /** Never policy-gated (D4): it moves toward the recorded baseline. */
    rollback: async ({ orgId, experimentId, reason }) => {
      const o = await write(orgId);
      const e = await getExperiment(tenantId, o, required(experimentId, 'experimentId'));
      if (!e) throw new OpenwopError('not_found', 'Experiment not found.', 404, {});
      assertPromotionRun(e, scope.runId);
      const r = await rollback(tenantId, o, e.experimentId, { actor: authorOf(scope), ...(scope.runId ? { runId: scope.runId } : {}), now: new Date().toISOString(), reason: str(reason) || 'breach' });
      return { outcome: r.outcome, status: r.experiment.status };
    },
  };
}
