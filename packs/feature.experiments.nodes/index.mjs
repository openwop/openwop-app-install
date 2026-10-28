/**
 * feature.experiments.nodes — ADR 0949 P2b nodes over `ctx.features.experiments`.
 * Calls the SAME service functions the REST routes call, behind the same org
 * floor. No launch node: launching is a human act until ADR 0942's autonomy
 * gate lands. `optimize-epoch` (ADR 0949 P4) only reallocates an experiment a
 * human launched. Pure-JS, Node-20 stdlib only.
 */
function ensureExperiments(ctx) {
  const s = ctx.features && ctx.features.experiments;
  if (!s || typeof s.get !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.features.experiments — the experiments feature must be composed (ADR 0949)'), { code: 'host_capability_missing', capability: 'host.experiments' });
  }
  return s;
}
const merged = (ctx) => ({ ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) });
const need = (i, keys, node) => {
  for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === '') throw Object.assign(new Error(`${node} requires \`${k}\``), { code: 'validation_error' });
};
const op = (name, method, keys) => async (ctx) => {
  const s = ensureExperiments(ctx); const i = merged(ctx);
  need(i, keys, name);
  return { status: 'success', outputs: await s[method](i) };
};

export const list = op('list', 'list', ['orgId']);
export const get = op('get', 'get', ['orgId', 'experimentId']);
export const results = op('results', 'results', ['orgId', 'experimentId']);
export const powerCalc = op('power-calc', 'powerCalc', ['orgId', 'baselineRate', 'mde', 'alpha', 'power']);
export const createDraft = op('create-draft', 'createDraft', ['orgId', 'name', 'surface', 'arms']);
export const updateDraft = op('update-draft', 'updateDraft', ['orgId', 'experimentId']);
export const lockPlan = op('lock-plan', 'lockPlan', ['orgId', 'experimentId']);
export const stop = op('stop', 'stop', ['orgId', 'experimentId']);
export const split = op('split', 'assign', ['orgId', 'experimentId', 'unitKey']);
export const optimizeEpoch = op('optimize-epoch', 'optimizeEpoch', ['orgId', 'experimentId']);
export const checkGates = op('check-gates', 'checkGates', ['orgId', 'experimentId']);

// ── ADR 0950 P2 — the `experiments.promote` chain ─────────────────────────────
const fail = (code, message, details) => ({ status: 'failure', retryable: false, error: { code, message, ...(details ? { details } : {}) } });
const typedFailure = (err) => (err && err.details && err.details.reason ? fail(err.details.reason, err.message, err.details) : null);

/** Every gate must pass, or the run ends `gate_failed` naming them (D2: never an
 *  approval with a "looks good" summary). Outputs the winner for stage 1. */
export async function requireGates(ctx) {
  const s = ensureExperiments(ctx); const i = merged(ctx);
  need(i, ['orgId', 'experimentId'], 'require-gates');
  const report = await s.checkGates({ orgId: i.orgId, experimentId: i.experimentId });
  if (!report.allPass) {
    const failed = report.gates.filter((g) => g.status !== 'pass').map((g) => g.id);
    return fail('gate_failed', `Promotion gates not met: ${failed.join(', ')}.`, { gates: failed, snapshot: report.snapshot });
  }
  return { status: 'success', outputs: { ...report } };
}

function isRejection(res) {
  return !!res && typeof res === 'object' && (res.action === 'reject' || res.decision === 'reject' || res.decision === 'rejected');
}
const APPROVER_CONFIG_KEYS = ['approverRefs', 'approverRoleRefs', 'approverGroupRefs', 'approversList', 'requiredApprovals', 'rejectionPolicy', 'overrideScopes'];

/** D4 — the `experiment.promote` policy gate. The host decides from the run's
 *  frozen ADR 0942 stamp (never from config); this node only acts on the
 *  verdict, exactly as `feature.campaign-orchestration.nodes.autonomy-gate`
 *  does, so the approval it opens is the same inbox row with the same
 *  `data.autonomy` block (and the same self-approval refusal). */
export async function policyGate(ctx) {
  const cfg = ctx.config ?? {};
  const forged = APPROVER_CONFIG_KEYS.filter((k) => cfg[k] !== undefined);
  if (forged.length > 0) return fail('autonomy_config_approvers_refused', `Approvers come from the policy, never from node config (refused: ${forged.join(', ')}).`);
  const s = ensureExperiments(ctx); const i = merged(ctx);
  need(i, ['orgId'], 'policy-gate');
  const verdict = await s.policyResolve({ orgId: i.orgId });
  if (verdict.mode === 'blocked') return fail('autonomy_blocked', `The autonomy policy blocks promotion (${verdict.reason}; rule ${verdict.ruleId}).`);
  if (verdict.mode === 'lane_unavailable') return fail('autonomy_lane_unavailable', `${verdict.actionClass} is decided by its own approval queue.`);
  if (verdict.mode === 'proceed') return { status: 'success', outputs: { decision: verdict.outcome, ruleId: verdict.ruleId, layer: verdict.layer, policyHash: verdict.policyHash } };
  const data = verdict.mode === 'approve' ? verdict.interruptData : {};
  const resolution = await ctx.suspend({ kind: 'approval', key: 'promote-gate', prompt: String(cfg.prompt || 'Approve promoting the winning variant (staged ramp with a holdout).'), actions: ['approve', 'reject'], ...data });
  if (isRejection(resolution)) return fail('autonomy_rejected', 'The approver rejected the promotion.');
  return { status: 'success', outputs: { decision: 'approved', ...(verdict.mode === 'approve' ? { ruleId: verdict.interruptData.autonomy.ruleId, policyHash: verdict.interruptData.autonomy.policyHash } : { legacy: true }), resolution: resolution ?? null } };
}

/** A typed refusal from the host (gate_failed, winner_changed, stage_too_soon,
 *  not_the_promotion_run, …) ends the run with that code, never a crash. */
const guarded = (fn) => async (ctx) => {
  try { return await fn(ctx); } catch (err) { const t = typedFailure(err); if (t) return t; throw err; }
};

export const applyRamp = guarded(async (ctx) => {
  const s = ensureExperiments(ctx); const i = merged(ctx);
  need(i, ['orgId', 'experimentId', 'stage'], 'apply-ramp');
  return { status: 'success', outputs: await s.applyRamp({ orgId: i.orgId, experimentId: i.experimentId, stage: i.stage, winner: i.winner, holdoutPct: i.holdoutPct }) };
});

/** Judge the stage: `breach` (route to rollback), `pass`, or `underpowered`
 *  (the run stops with the experiment held at this stage; a new promotion run resumes it). */
const stageCheckNode = (kind) => guarded(async (ctx) => {
  const s = ensureExperiments(ctx); const i = merged(ctx);
  need(i, ['orgId', 'experimentId'], kind);
  const r = await s.stageCheck({ orgId: i.orgId, experimentId: i.experimentId, kind });
  if (r.outcome === 'underpowered') return fail('stage_underpowered', 'Not enough units since this stage began; the experiment stays at this stage.', { value: r.value, snapshot: r.snapshot });
  return { status: 'success', outputs: r };
});
export const recheck = stageCheckNode('recheck');
export const monitor = stageCheckNode('monitor');

export const finalizePromotion = guarded(async (ctx) => {
  const s = ensureExperiments(ctx); const i = merged(ctx);
  need(i, ['orgId', 'experimentId'], 'finalize');
  return { status: 'success', outputs: await s.finalize({ orgId: i.orgId, experimentId: i.experimentId }) };
});

export const rollbackPromotion = guarded(async (ctx) => {
  const s = ensureExperiments(ctx); const i = merged(ctx);
  need(i, ['orgId', 'experimentId'], 'rollback');
  return { status: 'success', outputs: await s.rollback({ orgId: i.orgId, experimentId: i.experimentId, reason: i.reason }) };
});

export const nodes = {
  'feature.experiments.nodes.list': list,
  'feature.experiments.nodes.get': get,
  'feature.experiments.nodes.results': results,
  'feature.experiments.nodes.power-calc': powerCalc,
  'feature.experiments.nodes.create-draft': createDraft,
  'feature.experiments.nodes.update-draft': updateDraft,
  'feature.experiments.nodes.lock-plan': lockPlan,
  'feature.experiments.nodes.stop': stop,
  'feature.experiments.nodes.split': split,
  'feature.experiments.nodes.optimize-epoch': optimizeEpoch,
  'feature.experiments.nodes.check-gates': checkGates,
  'feature.experiments.nodes.require-gates': requireGates,
  'feature.experiments.nodes.policy-gate': policyGate,
  'feature.experiments.nodes.apply-ramp': applyRamp,
  'feature.experiments.nodes.recheck': recheck,
  'feature.experiments.nodes.monitor': monitor,
  'feature.experiments.nodes.finalize': finalizePromotion,
  'feature.experiments.nodes.rollback': rollbackPromotion,
};
export default nodes;
