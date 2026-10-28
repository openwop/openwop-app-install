/**
 * ADR 0949 P2a — Decide mode, the service. One experiment model across surfaces
 * (`host/experiments/`); each surface's own rules ride its adapter. Every read
 * and write is scoped to (tenant, org); a row in another org is the same `null`
 * as a missing one (ADR 0921 D3).
 *
 * Lifecycle: draft → (plan locked) → running → stopped | abandoned. After the
 * plan is locked no plan field, arm or weight changes (409 `plan_locked`); the
 * verbs left are launch, stop and abandon. Writes are compare-and-swap.
 */
import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import { experimentSurface } from '../../host/experiments/adapters.js';
import { lockPlan as buildLockedPlan, parsePlanInput, type DecideResult } from '../../host/experiments/decide.js';
import { deleteExperimentRollup } from '../../host/experiments/rollup.js';
import { deleteExperimentRow, getExperimentRow, insertExperimentRowIfAbsent, listExperimentRows, mutateExperimentRow } from '../../host/experiments/store.js';
import type { Arm, Experiment, ExperimentStatus, PlanInput } from '../../host/experiments/types.js';
import { thompsonWeights } from '../../host/experiments/stats.js';
import { observeExperiment, verdictFromCells } from '../../host/experiments/observe.js';
import { hashString } from '../../host/variantAssignment.js';
import { epochAt } from '../../host/experiments/runFreeze.js';
import { countFirstExposures, deleteFirstExposures, FIRST_EXPOSURE_CAP } from '../../host/experiments/sticky.js';

export const MAX = { arms: 8, name: 120, hypothesis: 1000, armKey: 40, ref: 200 } as const;

const nowIso = (): string => new Date().toISOString();
const bad = (field: string, message: string, extra: Record<string, unknown> = {}): never => {
  throw new OpenwopError('validation_error', message, 400, { field, ...extra });
};
const conflict = (reason: string, message: string, extra: Record<string, unknown> = {}): never => {
  throw new OpenwopError('conflict', message, 409, { reason, ...extra });
};
const notFound = (): never => { throw new OpenwopError('not_found', 'Experiment not found.', 404, {}); };

const ARM_KEYS = new Set(['key', 'ref', 'weight']);

/** Closed-world arms: 2..8, unique keys, integer weights 1..100 summing to 100. */
export function parseArms(raw: unknown): Arm[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX.arms) bad('arms', `An experiment needs 2–${MAX.arms} arms.`);
  const arms = (raw as unknown[]).map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) bad('arms', `Arm ${i + 1} must be an object.`);
    const o = item as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!ARM_KEYS.has(k)) bad('arms', `Unknown arm field \`${k}\`.`);
    const key = typeof o.key === 'string' ? cleanString(o.key, MAX.armKey) : '';
    if (!key) bad('arms', 'Every arm needs a key.');
    const weight = o.weight;
    if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 1 || weight > 100) bad('arms', 'Arm weight must be an integer 1..100.');
    if (o.ref !== null && o.ref !== undefined && typeof o.ref !== 'string') bad('arms', 'Arm ref must be a string or null.');
    const ref = typeof o.ref === 'string' && o.ref.trim() ? o.ref.trim().slice(0, MAX.ref) : null;
    return { key, ref, weight: weight as number };
  });
  if (new Set(arms.map((a) => a.key)).size !== arms.length) bad('arms', 'Arm keys must be unique.');
  if (arms.reduce((s, a) => s + a.weight, 0) !== 100) bad('arms', 'Arm weights must sum to exactly 100.');
  return arms;
}

function adapterFor(kind: string) {
  const a = experimentSurface(kind);
  if (!a) bad('surface.kind', `Experiments cannot run on \`${kind}\`.`, { reason: 'unsupported_surface' });
  return a!;
}

const CREATE_KEYS = new Set(['name', 'hypothesis', 'surface', 'arms', 'mode', 'optimize']);
const OPTIMIZE_KEYS = new Set(['rewardMetric', 'floorPct', 'epochMinutes']);

/** ADR 0949 P4 — closed-world Optimize config. The floor keeps every arm at or
 *  above `floorPct`% (1..100/arms; default 5), and an epoch is at least an hour. */
export function parseOptimize(raw: unknown, armCount: number): NonNullable<Experiment['optimize']> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('optimize', 'optimize must be an object.');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!OPTIMIZE_KEYS.has(k)) bad('optimize', `Unknown optimize field \`${k}\`.`);
  const rm = o.rewardMetric as { kind?: unknown; name?: unknown } | undefined;
  if (!rm || rm.kind !== 'conversion' || typeof rm.name !== 'string' || !rm.name.trim()) bad('optimize.rewardMetric', 'The reward is a conversion with a name.');
  const floorPct = o.floorPct === undefined ? 5 : o.floorPct;
  const maxFloor = Math.floor(100 / armCount);
  if (typeof floorPct !== 'number' || !Number.isInteger(floorPct) || floorPct < 1 || floorPct > maxFloor) bad('optimize.floorPct', `floorPct is a whole percent from 1 to ${maxFloor}.`);
  const epochMinutes = o.epochMinutes ?? 1440;
  if (typeof epochMinutes !== 'number' || !Number.isInteger(epochMinutes) || epochMinutes < 60 || epochMinutes > 10080) bad('optimize.epochMinutes', 'epochMinutes is a whole number from 60 to 10080.');
  return { rewardMetric: { kind: 'conversion', name: String(rm!.name).trim() }, floorPct: floorPct as number, epochMinutes: epochMinutes as number };
}

export async function createDraft(tenantId: string, orgId: string, actor: string, raw: unknown): Promise<Experiment> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('body', 'Body must be an object.');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!CREATE_KEYS.has(k)) bad(k, `Unknown field \`${k}\`.`);
  const name = typeof o.name === 'string' ? cleanString(o.name, MAX.name) : '';
  if (!name) bad('name', 'An experiment needs a name.');
  const hypothesis = typeof o.hypothesis === 'string' ? cleanString(o.hypothesis, MAX.hypothesis) : '';
  const surface = o.surface as { kind?: unknown; ref?: unknown } | undefined;
  if (!surface || typeof surface.kind !== 'string' || typeof surface.ref !== 'string' || !surface.ref.trim()) bad('surface', 'surface needs a kind and a ref.');
  const kind = String(surface!.kind);
  const ref = String(surface!.ref).trim();
  const arms = parseArms(o.arms);
  const mode = o.mode === undefined ? 'decide' : o.mode;
  if (mode !== 'decide' && mode !== 'optimize') bad('mode', 'mode is decide or optimize.');
  const optimize = mode === 'optimize' ? parseOptimize(o.optimize ?? {}, arms.length) : undefined;
  if (mode === 'decide' && o.optimize !== undefined) bad('optimize', 'Only an Optimize experiment takes an optimize config.');
  const adapter = adapterFor(kind);
  await adapter.validateTarget(tenantId, orgId, ref, arms);
  const ts = nowIso();
  const exp: Experiment = {
    experimentId: `exp:${randomUUID()}`, tenantId, orgId, name, hypothesis,
    surface: { kind, ref }, unit: adapter.unit ?? 'visitor', design: { type: arms.length > 2 ? 'abn' : 'ab' },
    arms, mode: mode as Experiment['mode'], status: 'draft', salt: `exp-salt:${randomUUID()}`, epochs: [],
    ...(optimize ? { optimize } : {}),
    createdBy: actor, createdAt: ts, updatedAt: ts,
  };
  await insertExperimentRowIfAbsent(exp);
  return exp;
}

export async function getExperiment(tenantId: string, orgId: string, experimentId: string): Promise<Experiment | null> {
  return getExperimentRow(tenantId, orgId, experimentId);
}

export async function listExperiments(tenantId: string, orgId: string, filter: { kind?: string; ref?: string; status?: string } = {}): Promise<Experiment[]> {
  const rows = await listExperimentRows(tenantId, orgId, filter.kind ? { kind: filter.kind, ...(filter.ref ? { ref: filter.ref } : {}) } : undefined);
  return rows.filter((e) => !filter.status || e.status === filter.status).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** ADR 0949 P3 — a guardrail must name a metric the surface counts. */
function assertGuardrailsSupported(kind: string, plan: PlanInput): void {
  const supported = new Set(adapterFor(kind).supportedMetrics ?? []);
  const missing = plan.guardrails.map((g) => g.metric.name).filter((m) => !supported.has(m));
  if (missing.length > 0) {
    throw new OpenwopError('validation_error', `This surface does not count ${missing.join(', ')}, so it cannot be a guardrail.`, 400, { field: 'guardrails', reason: 'unsupported_metric', metrics: missing, supported: [...supported] });
  }
}

/** A draft whose plan is not locked: the only state where arms and plan move. */
function assertEditable(e: Experiment): void {
  if (e.legacy === true) conflict('legacy_experiment', 'This experiment predates Experiments; change it where it was created.');
  if (e.plan) conflict('plan_locked', 'The plan is locked. Stop or abandon the experiment instead.', { planHash: e.plan.planHash });
  if (e.status !== 'draft') conflict('not_draft', `Only a draft can be edited (status: ${e.status}).`, { status: e.status });
}

const PATCH_KEYS = new Set(['name', 'hypothesis', 'arms', 'plan', 'optimize']);

/** Edit a draft: name, hypothesis, arms, and the unlocked plan (`planDraft`). */
export async function updateDraft(tenantId: string, orgId: string, experimentId: string, raw: unknown): Promise<Experiment> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('body', 'Body must be an object.');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!PATCH_KEYS.has(k)) bad(k, `Unknown field \`${k}\`.`);
  const current = await getExperimentRow(tenantId, orgId, experimentId);
  if (!current) notFound();
  assertEditable(current!);
  const arms = o.arms !== undefined ? parseArms(o.arms) : undefined;
  if (arms) await adapterFor(current!.surface.kind).validateTarget(tenantId, orgId, current!.surface.ref, arms);
  if (o.plan !== undefined && current!.mode === 'optimize') conflict('not_decide', 'An Optimize experiment has no plan: it never declares a winner.');
  if (o.optimize !== undefined && current!.mode !== 'optimize') bad('optimize', 'Only an Optimize experiment takes an optimize config.');
  const optimizePatch = o.optimize !== undefined ? parseOptimize(o.optimize, (arms ?? current!.arms).length) : undefined;
  const planDraft = o.plan !== undefined ? parsePlanInput(o.plan) : undefined;
  if (planDraft) assertGuardrailsSupported(current!.surface.kind, planDraft);
  const name = o.name !== undefined ? (typeof o.name === 'string' ? cleanString(o.name, MAX.name) : '') : undefined;
  if (name === '') bad('name', 'An experiment needs a name.');
  const hypothesis = o.hypothesis !== undefined ? (typeof o.hypothesis === 'string' ? cleanString(o.hypothesis, MAX.hypothesis) : '') : undefined;
  const next = await mutateExperimentRow(tenantId, orgId, experimentId, (cur) => {
    assertEditable(cur);
    return {
      ...cur,
      ...(name !== undefined ? { name } : {}),
      ...(hypothesis !== undefined ? { hypothesis } : {}),
      ...(arms ? { arms, design: { type: arms.length > 2 ? 'abn' as const : 'ab' as const } } : {}),
      ...(planDraft ? { planDraft } : {}),
      ...(optimizePatch ? { optimize: optimizePatch } : {}),
      updatedAt: nowIso(),
    };
  });
  return next ?? notFound();
}

/** Lock the plan (from the body, else the saved draft plan). Immutable after. */
export async function lockPlan(tenantId: string, orgId: string, experimentId: string, raw: unknown): Promise<Experiment> {
  const input = raw !== undefined && raw !== null ? parsePlanInput(raw) : undefined;
  const at = nowIso();
  const next = await mutateExperimentRow(tenantId, orgId, experimentId, (cur) => {
    if (cur.mode === 'optimize') conflict('not_decide', 'An Optimize experiment has no plan to lock.');
    assertEditable(cur);
    const plan = input ?? cur.planDraft;
    if (!plan) bad('plan', 'There is no plan to lock.', { reason: 'plan_missing' });
    assertGuardrailsSupported(cur.surface.kind, plan!);
    const locked = buildLockedPlan(plan!, cur.arms, at);
    const out: Experiment = { ...cur, plan: locked, updatedAt: at };
    delete out.planDraft;
    return out;
  });
  return next ?? notFound();
}

/** Launch a locked Decide experiment. Idempotent: a running one is returned as is. */
export async function launch(tenantId: string, orgId: string, experimentId: string, actor: string): Promise<Experiment> {
  const cur = await getExperimentRow(tenantId, orgId, experimentId);
  if (!cur) notFound();
  if (cur!.status === 'running') return cur!;
  if (cur!.legacy === true) conflict('legacy_experiment', 'This experiment predates Experiments; start it where it was created.');
  if (cur!.status !== 'draft') conflict('not_draft', `Only a draft can be launched (status: ${cur!.status}).`, { status: cur!.status });
  if (cur!.mode === 'decide' && !cur!.plan) conflict('plan_required', 'Lock a plan before launching a Decide experiment.');
  if (cur!.mode === 'optimize' && !cur!.optimize) conflict('optimize_required', 'An Optimize experiment needs its optimize config before launch.');
  // ADR 0942 (campaign autonomy policy) adds its launch gate here once it lands;
  // until then the surface's own start checks are the gate (the adapter).
  const started = await adapterFor(cur!.surface.kind).launch(cur!, actor);
  const next = await mutateExperimentRow(tenantId, orgId, experimentId, (row) => (row.status !== 'running' || row.epochs.length > 0 ? null : {
    ...row, epochs: [{ epoch: 0, weights: Object.fromEntries(row.arms.map((a) => [a.key, a.weight])), at: row.startedAt ?? started.startedAt ?? nowIso(), reason: 'launch' }],
  }));
  return next ?? notFound();
}

export async function stop(tenantId: string, orgId: string, experimentId: string, actor: string): Promise<Experiment> {
  const cur = await getExperimentRow(tenantId, orgId, experimentId);
  if (!cur) notFound();
  if (cur!.legacy === true) conflict('legacy_experiment', 'This experiment predates Experiments; stop it where it was created.');
  if (cur!.status === 'stopped') return cur!;
  if (cur!.status !== 'running') conflict('not_running', `Only a running experiment can be stopped (status: ${cur!.status}).`, { status: cur!.status });
  return adapterFor(cur!.surface.kind).stop(cur!, actor);
}

const ABANDONABLE: ReadonlyArray<ExperimentStatus> = ['draft', 'running', 'stopped'];

export async function abandon(tenantId: string, orgId: string, experimentId: string, actor: string): Promise<Experiment> {
  let cur = await getExperimentRow(tenantId, orgId, experimentId);
  if (!cur) notFound();
  if (cur!.legacy === true) conflict('legacy_experiment', 'This experiment predates Experiments; change it where it was created.');
  if (cur!.status === 'abandoned') return cur!;
  if (!ABANDONABLE.includes(cur!.status)) conflict('not_abandonable', `An experiment in status ${cur!.status} cannot be abandoned.`, { status: cur!.status });
  if (cur!.status === 'running') cur = await adapterFor(cur!.surface.kind).stop(cur!, actor);
  const at = nowIso();
  const next = await mutateExperimentRow(tenantId, orgId, experimentId, (row) => ({ ...row, status: 'abandoned', updatedAt: at, ...(row.stoppedAt ? {} : { stoppedAt: at }) }));
  return next ?? notFound();
}

/** Delete a draft that never launched (nothing was served, nothing to keep). */
export async function deleteDraft(tenantId: string, orgId: string, experimentId: string): Promise<boolean> {
  const cur = await getExperimentRow(tenantId, orgId, experimentId);
  if (!cur) return false;
  if (cur.legacy === true) conflict('legacy_experiment', 'This experiment predates Experiments; delete it where it was created.');
  if (cur.status !== 'draft' || cur.startedAt) conflict('not_draft', 'Only a draft that never launched can be deleted; abandon it instead.', { status: cur.status });
  await deleteExperimentRow(tenantId, orgId, experimentId);
  await deleteExperimentRollup(tenantId, orgId, experimentId);
  await deleteFirstExposures(cur);
  return true;
}

export interface DecideResults extends DecideResult {
  experimentId: string;
  status: ExperimentStatus;
  mode: 'decide';
  planHash: string | null;
  coverage: { status: 'complete' | 'partial'; retainedSince: string | null };
  computedAt: string;
}

const observeTotals = observeExperiment;

const seedFor = (experimentId: string, epoch: number): number => hashString(`${experimentId}:${epoch}`);

export interface OptimizeEpochOutcome {
  experiment: Experiment;
  epoch: number;
  /** `appended`: this call wrote the epoch. `existing`: it was already there (a
   *  replay, a fork or a concurrent run). `too_soon`: the previous epoch is
   *  younger than `epochMinutes`, so nothing changed. */
  outcome: 'appended' | 'existing' | 'too_soon';
}

/**
 * ADR 0949 P4 — the next Optimize epoch. Its number comes from `asOf` (a run's
 * frozen start instant): N = the epoch in effect at asOf, plus one. A fork keeps
 * the source's asOf, recomputes the same N, finds it already appended and
 * returns it, so a fork never re-allocates. The weights are Thompson sampling
 * over the rollup with a seed of `experimentId:N`, floor respected. The new
 * epoch's `at` is the append instant, never earlier, so no run that began
 * before it is re-assigned on its own fork.
 */
export async function optimizeEpoch(tenantId: string, orgId: string, experimentId: string, opts: { asOf: string; runId?: string; now?: string }): Promise<OptimizeEpochOutcome> {
  const exp = await getExperimentRow(tenantId, orgId, experimentId);
  if (!exp) notFound();
  if (exp!.mode !== 'optimize' || !exp!.optimize) conflict('not_optimize', 'Only an Optimize experiment has epochs.');
  if (exp!.status !== 'running') conflict('not_running', `Only a running experiment reallocates (status: ${exp!.status}).`, { status: exp!.status });
  const current = epochAt(exp!, opts.asOf);
  if (!current) conflict('not_launched', 'The experiment has no launch epoch.');
  const n = current!.epoch + 1;
  if (exp!.epochs.some((e) => e.epoch === n)) return { experiment: exp!, epoch: n, outcome: 'existing' };
  const now = opts.now ?? nowIso();
  if (Date.parse(now) - Date.parse(current!.at) < exp!.optimize!.epochMinutes * 60_000) return { experiment: exp!, epoch: current!.epoch, outcome: 'too_soon' };
  const { totals } = await observeTotals(exp!, now);
  const decision = thompsonWeights(exp!.arms.map((a) => ({ key: a.key, successes: totals.get(a.key)?.sum ?? 0, trials: totals.get(a.key)?.n ?? 0 })), { floorPct: exp!.optimize!.floorPct, seed: seedFor(experimentId, n) });
  const capped = (await countFirstExposures(exp!)) >= FIRST_EXPOSURE_CAP;
  // Strictly after the deciding run's instant: an epoch stamped AT asOf would
  // fall inside that run's own window and re-number its fork.
  const at = new Date(Math.max(Date.parse(now), Date.parse(opts.asOf) + 1)).toISOString();
  let outcome: OptimizeEpochOutcome['outcome'] = 'existing';
  const next = await mutateExperimentRow(tenantId, orgId, experimentId, (row) => {
    if (row.epochs.some((e) => e.epoch === n) || row.status !== 'running') return null;
    outcome = 'appended';
    return {
      ...row, updatedAt: now, ...(capped ? { stickinessCapped: true } : {}),
      epochs: [...row.epochs, { epoch: n, weights: decision.weights, at, reason: 'optimize' as const, ...(opts.runId ? { decidedByRunId: opts.runId } : {}) }],
    };
  });
  return { experiment: next ?? exp!, epoch: n, outcome };
}

export interface OptimizeResults {
  experimentId: string; status: ExperimentStatus; mode: 'optimize';
  /** The allocation in effect now. */
  epoch: number; weights: Record<string, number>;
  /** A MODEL ESTIMATE (Thompson draws, seeded per epoch), never a test result:
   *  Optimize does not call a winner and cannot feed a promotion. */
  arms: Array<{ key: string; units: number; conversions: number; rate: number; probabilityBest: number; expectedLoss: number }>;
  floorPct: number;
  stickinessCapped: boolean;
  coverage: { status: 'complete' | 'partial'; retainedSince: string | null };
  computedAt: string;
}

async function optimizeResults(exp: Experiment, now: string): Promise<OptimizeResults> {
  const { totals, coverage, retainedSince } = await observeTotals(exp, now);
  const current = epochAt(exp, now);
  const epoch = current?.epoch ?? 0;
  const model = thompsonWeights(exp.arms.map((a) => ({ key: a.key, successes: totals.get(a.key)?.sum ?? 0, trials: totals.get(a.key)?.n ?? 0 })), { floorPct: exp.optimize?.floorPct ?? 5, seed: seedFor(exp.experimentId, epoch) });
  return {
    experimentId: exp.experimentId, status: exp.status, mode: 'optimize', epoch,
    weights: current?.weights ?? Object.fromEntries(exp.arms.map((a) => [a.key, a.weight])),
    arms: exp.arms.map((a) => {
      const t = totals.get(a.key) ?? { n: 0, sum: 0 };
      return { key: a.key, units: t.n, conversions: t.sum, rate: t.n > 0 ? t.sum / t.n : 0, probabilityBest: model.probabilityBest[a.key] ?? 0, expectedLoss: model.expectedLoss[a.key] ?? 0 };
    }),
    floorPct: exp.optimize?.floorPct ?? 5, stickinessCapped: exp.stickinessCapped === true,
    coverage: { status: coverage, retainedSince }, computedAt: now,
  };
}

/** Rebuild the rollup through the surface adapter and compute the result:
 *  a Decide verdict, or an Optimize model estimate (never a verdict). */
export async function results(tenantId: string, orgId: string, experimentId: string, now = nowIso()): Promise<DecideResults | OptimizeResults> {
  const exp = await getExperimentRow(tenantId, orgId, experimentId);
  if (!exp) notFound();
  if (exp!.legacy === true) conflict('legacy_experiment', 'This experiment predates Experiments; read its results where it was created.');
  if (exp!.mode === 'optimize') return optimizeResults(exp!, now);
  const { cells, coverage, retainedSince } = await observeTotals(exp!, now);
  const decided = verdictFromCells(exp!, cells, coverage, now);
  return {
    experimentId, status: exp!.status, mode: 'decide', planHash: exp!.plan?.planHash ?? null,
    ...decided,
    coverage: { status: coverage, retainedSince },
    computedAt: now,
  };
}
