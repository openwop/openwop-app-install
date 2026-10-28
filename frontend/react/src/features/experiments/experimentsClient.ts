/**
 * Experiments feature client (ADR 0949 P2b). Wraps
 * /host/openwop-app/experiments/orgs/:orgId/*. 404s when the toggle is off.
 * The target pickers read pages and funnels through those features' own
 * clients (one page model, one funnel model).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import type { GateReport } from './GateChecklist.js';

const base = (orgId: string): string => `${config.baseUrl}/host/openwop-app/experiments/orgs/${encodeURIComponent(orgId)}`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/** A refused request: the server's message and its typed reason (`plan_locked`, …). */
export class ExperimentsRequestError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) { super(message); }
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = '';
    let reason: string | undefined;
    try {
      const body = (await res.json()) as { message?: string; details?: { reason?: string } };
      message = body?.message ?? '';
      reason = body?.details?.reason;
    } catch { /* not JSON */ }
    throw new ExperimentsRequestError(message || `Request failed (${res.status})`, res.status, reason);
  }
  return (await res.json()) as T;
}

export type SurfaceKind = 'cms.page' | 'funnel.step';
export type ExperimentStatus = 'proposed' | 'draft' | 'running' | 'stopped' | 'concluded' | 'promoting' | 'promoted' | 'rolled_back' | 'abandoned';
export interface Arm { key: string; ref: string | null; weight: number }
export interface PlanInput {
  primaryMetric: { kind: 'conversion'; name: string };
  guardrails: [];
  baselineRate: number; mde: number; alpha: number; power: number; fdrQ: number;
  minDays: number; maxDays: number;
}
export interface LockedPlan extends PlanInput { minSamplePerArm: number; lockedAt: string; planHash: string }
export interface Experiment {
  experimentId: string; orgId: string; name: string; hypothesis: string;
  surface: { kind: string; ref: string };
  arms: Arm[];
  mode: 'decide' | 'optimize';
  status: ExperimentStatus;
  plan?: LockedPlan;
  planDraft?: PlanInput;
  /** ADR 0949 P4 — an Optimize experiment's config. */
  optimize?: OptimizeConfig;
  stickinessCapped?: boolean;
  epochs: Array<{ epoch: number; weights: Record<string, number>; at: string; reason: string }>;
  /** A pre-engine CMS page or funnel step test: read-only here. */
  legacy?: true;
  createdAt: string; updatedAt: string; startedAt?: string; stoppedAt?: string;
}

export interface OptimizeConfig { rewardMetric: { kind: 'conversion'; name: string }; floorPct: number; epochMinutes: number }

/** ADR 0949 P4 — an Optimize result is a MODEL ESTIMATE, never a verdict. */
export interface OptimizeResults {
  experimentId: string; status: ExperimentStatus; mode: 'optimize';
  epoch: number; weights: Record<string, number>;
  arms: Array<{ key: string; units: number; conversions: number; rate: number; probabilityBest: number; expectedLoss: number }>;
  floorPct: number; stickinessCapped: boolean;
  coverage: { status: 'complete' | 'partial'; retainedSince: string | null };
  computedAt: string;
}

export type VerdictKind = 'insufficient_data' | 'running' | 'srm_halt' | 'winner' | 'no_difference' | 'guardrail_breach' | 'inconclusive_at_max';
export interface Verdict { kind: VerdictKind; arm?: string; metric?: string; reason?: 'no_plan' | 'not_launched' | 'abandoned' | 'no_units' | 'coverage' | 'min_days' | 'min_sample' }
export interface ArmInference { key: string; units: number; conversions: number; rate: number; delta?: number; confidenceSequence?: [number, number]; pValue?: number; qValue?: number }
export interface DecideResults {
  experimentId: string; status: ExperimentStatus; mode: 'decide'; planHash: string | null;
  verdict: Verdict;
  arms: ArmInference[];
  srm: { chiSquare: number; pValue: number; mismatch: boolean; alpha: number } | null;
  gates: { minDays: number; daysElapsed: number; minSamplePerArm: number; smallestArm: number; met: boolean };
  coverage: { status: 'complete' | 'partial'; retainedSince: string | null };
  computedAt: string;
}

export async function listExperiments(orgId: string): Promise<Experiment[]> {
  const res = await fetch(`${base(orgId)}/experiments`, { headers: authedHeaders(), ...fetchOpts() });
  return (await parse<{ experiments: Experiment[] }>(res)).experiments;
}

export async function getExperiment(orgId: string, experimentId: string): Promise<Experiment> {
  const res = await fetch(`${base(orgId)}/experiments/${encodeURIComponent(experimentId)}`, { headers: authedHeaders(), ...fetchOpts() });
  return (await parse<{ experiment: Experiment }>(res)).experiment;
}

export async function createExperiment(orgId: string, body: { name: string; hypothesis?: string; surface: { kind: SurfaceKind; ref: string }; arms: Arm[]; mode?: 'decide' | 'optimize'; optimize?: OptimizeConfig }): Promise<Experiment> {
  const res = await fetch(`${base(orgId)}/experiments`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body), ...fetchOpts() });
  return (await parse<{ experiment: Experiment }>(res)).experiment;
}

export async function updateExperiment(orgId: string, experimentId: string, patch: { name?: string; hypothesis?: string; arms?: Arm[]; plan?: PlanInput; optimize?: OptimizeConfig }): Promise<Experiment> {
  const res = await fetch(`${base(orgId)}/experiments/${encodeURIComponent(experimentId)}`, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch), ...fetchOpts() });
  return (await parse<{ experiment: Experiment }>(res)).experiment;
}

export async function deleteExperiment(orgId: string, experimentId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/experiments/${encodeURIComponent(experimentId)}`, { method: 'DELETE', headers: authedHeaders(), ...fetchOpts() });
  await parse<{ ok: true }>(res);
}

export async function lockPlan(orgId: string, experimentId: string, plan?: PlanInput): Promise<Experiment> {
  const res = await fetch(`${base(orgId)}/experiments/${encodeURIComponent(experimentId)}/lock`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(plan ? { plan } : {}), ...fetchOpts() });
  return (await parse<{ experiment: Experiment }>(res)).experiment;
}

export async function transition(orgId: string, experimentId: string, verb: 'launch' | 'stop' | 'abandon'): Promise<Experiment> {
  const res = await fetch(`${base(orgId)}/experiments/${encodeURIComponent(experimentId)}/${verb}`, { method: 'POST', headers: jsonHeaders(), body: '{}', ...fetchOpts() });
  return (await parse<{ experiment: Experiment }>(res)).experiment;
}

export async function getResults(orgId: string, experimentId: string): Promise<DecideResults | OptimizeResults> {
  const res = await fetch(`${base(orgId)}/experiments/${encodeURIComponent(experimentId)}/results`, { headers: authedHeaders(), ...fetchOpts() });
  return parse<DecideResults | OptimizeResults>(res);
}

/** ADR 0949 P4 — reallocate an Optimize experiment now. `too_soon` is an answer. */
export async function reallocate(orgId: string, experimentId: string): Promise<{ outcome: 'appended' | 'existing' | 'too_soon'; epoch: number }> {
  const res = await fetch(`${base(orgId)}/experiments/${encodeURIComponent(experimentId)}/epoch`, { method: 'POST', headers: jsonHeaders(), body: '{}', ...fetchOpts() });
  return parse<{ outcome: 'appended' | 'existing' | 'too_soon'; epoch: number }>(res);
}

/** ADR 0950 P0 — the promotion gate checklist (read-only). */
export async function getGates(orgId: string, experimentId: string): Promise<GateReport> {
  const res = await fetch(`${base(orgId)}/experiments/${encodeURIComponent(experimentId)}/gates`, { headers: authedHeaders(), ...fetchOpts() });
  return parse<GateReport>(res);
}

export async function powerCalc(orgId: string, q: { baselineRate: number; mde: number; alpha: number; power: number }): Promise<number> {
  const params = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${base(orgId)}/power?${params.toString()}`, { headers: authedHeaders(), ...fetchOpts() });
  return (await parse<{ samplePerArm: number }>(res)).samplePerArm;
}
