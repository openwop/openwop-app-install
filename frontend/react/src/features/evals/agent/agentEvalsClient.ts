/**
 * Agent eval suites client (ADR 0889 P6). Two lanes, never a third:
 *   - the host-extension suite store + history + live progress under
 *     `/host/openwop-app/agent-evals/*` (non-normative), and
 *   - the normative run lane: `POST /runs {mode:"eval"}` (RFC 0081 §B) and
 *     `GET /runs/:id/eval-summary`, spoken at `OpenWOP-Version: 2.0`.
 *
 * Every `agentId` here is the REGISTRY agent id (`entry.agentRef.agentId`), the
 * id the backend resolves through `resolveAgentForTenant` — never the rosterId.
 * A failed call throws `AgentEvalsRequestError` carrying the HTTP status (for
 * `loadErrorMessage`), the validator's `details.field` (for inline errors), and
 * the machine-readable `details.reason` / `details.rule` + params that
 * `evalErrors.ts` maps to localized copy (the server's English prose is the
 * last resort, never the first).
 */
import { authedHeaders, config, fetchOpts } from '../../../client/config.js';

/* ── the RFC 0081 + RFC 0244 suite shape (mirrors host/evals/suiteStore.ts) ── */

export type EvalMode = 'golden' | 'rubric' | 'regression';
export type GoldenStrategy = 'exact' | 'contains' | 'json-match';
export type TrajectoryMatchMode = 'exact' | 'in-order' | 'any-order' | 'subset';
export type ArgsMatch = 'ignore' | 'exact' | 'subset';
export type PassRule = 'all' | 'any' | 'mean';

export interface TrajectoryCall { tool: string; args?: unknown; argsMatch?: ArgsMatch }
export interface TrajectoryExpectation { match: TrajectoryMatchMode; calls: TrajectoryCall[]; forbidden?: string[]; includeDelegates?: boolean }

export interface EvalTaskDef {
  taskId: string;
  input: unknown;
  expected: {
    kind: 'golden' | 'rubric' | 'trajectory';
    match?: { strategy: GoldenStrategy; value: unknown };
    rubric?: Array<{ criterion: string; weight: number }>;
    trajectory?: TrajectoryExpectation;
  };
  fixtures?: {
    toolResponses?: Array<{ tool: string; args?: unknown; argsMatch?: ArgsMatch; response?: unknown }>;
    memorySeed?: Array<Record<string, unknown>>;
    onMiss?: 'fail' | 'live';
  };
}

export interface AgentEvalSuite {
  suiteId: string;
  version: string;
  targetAgentId?: string;
  modes: EvalMode[];
  allowedModels?: string[];
  thresholds?: { passScore?: number; maxCostUsd?: number; maxP95LatencyMs?: number };
  trials?: { count?: number; k?: number; passRule?: PassRule };
  tasks: EvalTaskDef[];
}

export interface StoredSuite {
  ref: string;
  suite: AgentEvalSuite;
  /** Absent on a pack-shipped suite (it is not stored in the workspace). */
  createdAt?: string;
  updatedAt?: string;
  /** A version some run referenced — edits 409; save a new version instead. Always true for a pack suite. */
  locked: boolean;
  /** `pack` = shipped in the agent's pack (RFC 0081 §A `evalSuiteRef`): read-only (ADR 0889 D2). */
  source?: 'tenant' | 'pack';
  /** The shipping pack, `<name>@<version>`, for a pack suite. */
  pack?: string;
  /** Set when a subject-erasure request redacted this suite's task content (an exact-args fixture may then miss). */
  erasedAt?: string;
}

export interface EvalCapability {
  modes: string[];
  maxTasksPerSuite: number;
  maxCostUsdPerSuite: number;
  trajectory?: boolean;
  trials?: { maxTrials: number };
  fixtureMatching?: boolean;
  regressionVerdict?: boolean;
}

/* ── results ─────────────────────────────────────────────────────────────── */

export type RegressionVerdict = 'improved' | 'regressed' | 'unchanged' | 'inconclusive';
/** Why a regression is `inconclusive` with nothing paired (host-extension, ADR 0889 grade remediation). */
export type RegressionReason = 'baseline_unavailable' | 'judge_mismatch' | 'model_class_mismatch';

export interface TrajectoryResult {
  mode: TrajectoryMatchMode;
  matched: boolean;
  expectedCount: number;
  observedCount: number;
  matchedCount: number;
  forbiddenCount: number;
}

export interface TaskTrials { n: number; passedCount: number; meanScore: number; passAtK: number; passHatK: number }

export interface Efficiency { toolCallCount: number; modelCallCount: number; inputTokens: number; outputTokens: number }

export interface Regression {
  baselineRunId: string;
  scoreDelta: number;
  verdict?: RegressionVerdict;
  method?: string;
  alpha?: number;
  pairedTaskCount?: number;
}

export interface EvalSummaryTask {
  taskId: string;
  score: number;
  passed: boolean;
  costUsd?: number;
  latencyMs?: number;
  trajectory?: TrajectoryResult;
  trials?: TaskTrials;
  efficiency?: Efficiency;
  fixtureMissCount?: number;
}

export interface EvalSummary {
  suiteId: string;
  suiteVersion: string;
  aggregateScore: number;
  passed: boolean;
  taskCount: number;
  passedCount: number;
  totalCostUsd?: number;
  tasks: EvalSummaryTask[];
  trialStats?: { k: number; passAtK: number; passHatK: number; scoreStderr?: number };
  regression?: Regression;
}

export interface TrialRecord {
  score: number;
  passed: boolean;
  scoreLabel: string;
  evaluatorType: string;
  costUsd: number;
  latencyMs: number;
  trajectory?: TrajectoryResult;
  efficiency: Efficiency;
  fixtureMissCount: number;
  /** Host-internal reason (judge detail, error code) — this host's own UI only. */
  detail?: string;
}

export interface RunError { code?: string; message?: string }

export interface EvalProgress {
  runId: string;
  status: string;
  suiteRef: string;
  agentId: string;
  progress: Record<string, Record<string, TrialRecord>>;
  summary: EvalSummary | null;
  error: RunError | null;
  /** Why an inconclusive regression paired nothing — served on this route only (null when not inconclusive). */
  regressionReason?: RegressionReason | null;
}

export interface EvalRunRow {
  runId: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  suiteRef: string;
  agentId: string;
  baselineRunId?: string;
  aggregateScore?: number;
  passed?: boolean;
  taskCount?: number;
  passedCount?: number;
  regression?: Regression;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'canceled', 'expired']);
export const isTerminalStatus = (status: string): boolean => TERMINAL.has(status);

/* ── transport ───────────────────────────────────────────────────────────── */

/** Scalar params a validator rule carries (`min`, `max`, `values`, …). */
export type RuleParams = Record<string, string | number | boolean | Array<string | number>>;

export class AgentEvalsRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** The validator's `details.field` (e.g. `tasks[0].expected.match`). */
  readonly field: string | undefined;
  /** Why a refusal happened (`suite_exists`, `locked`, `not_entitled`, `agent_mismatch`, …). */
  readonly reason: string | undefined;
  /** Which validation rule failed (`range`, `pattern`, `required`, …). */
  readonly rule: string | undefined;
  readonly params: RuleParams;
  constructor(message: string, status: number, code?: string, field?: string, extra: { reason?: string; rule?: string; params?: RuleParams } = {}) {
    super(message);
    this.name = 'AgentEvalsRequestError';
    this.status = status;
    this.code = code;
    this.field = field;
    this.reason = extra.reason;
    this.rule = extra.rule;
    this.params = extra.params ?? {};
  }
}

function scalarParams(src: unknown): RuleParams {
  const out: RuleParams = {};
  if (!src || typeof src !== 'object') return out;
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) out[k] = v as Array<string | number>;
  }
  return out;
}

async function requestError(res: Response): Promise<AgentEvalsRequestError> {
  let message = '';
  let code: string | undefined;
  let field: string | undefined;
  let reason: string | undefined;
  let rule: string | undefined;
  let params: RuleParams = {};
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown; details?: Record<string, unknown> };
    const d = body.details ?? {};
    if (typeof body.message === 'string') message = body.message;
    if (typeof body.error === 'string') code = body.error;
    if (typeof d.field === 'string') field = d.field;
    if (typeof d.reason === 'string') reason = d.reason;
    if (typeof d.rule === 'string') rule = d.rule;
    // Params ride either nested (`details.params`) or flat beside the rule.
    params = scalarParams(d.params ?? d);
  } catch { /* non-JSON body */ }
  // No server prose ⇒ an empty message; the UI then shows its localized class
  // (`loadErrorMessage`), never a developer string like "putEvalSuite returned 500".
  return new AgentEvalsRequestError(message, res.status, code, field, { ...(reason ? { reason } : {}), ...(rule ? { rule } : {}), params });
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw await requestError(res);
  return (await res.json()) as T;
}

const BASE = (): string => `${config.baseUrl}/host/openwop-app/agent-evals`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });
const V2 = { 'OpenWOP-Version': '2.0' };

export async function getEvalCapability(): Promise<EvalCapability> {
  const res = await fetch(`${BASE()}/capability`, fetchOpts({ headers: authedHeaders() }));
  return asJson<EvalCapability>(res);
}

export async function listEvalSuites(agentId: string): Promise<StoredSuite[]> {
  const res = await fetch(`${BASE()}/suites?agentId=${encodeURIComponent(agentId)}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ items: StoredSuite[] }>(res)).items;
}

/**
 * `create: true` asks the server to refuse (409 `suite_exists`) rather than
 * overwrite a ref that already exists — every save that MEANS "a new suite or
 * version" sends it; only an edit that keeps its own ref upserts.
 */
export async function putEvalSuite(suite: AgentEvalSuite, opts: { create?: boolean } = {}): Promise<StoredSuite> {
  const ref = `${suite.suiteId}@${suite.version}`;
  const res = await fetch(`${BASE()}/suites/${encodeURIComponent(ref)}${opts.create ? '?create=true' : ''}`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(suite) }));
  return asJson<StoredSuite>(res);
}

export async function deleteEvalSuite(ref: string): Promise<void> {
  const res = await fetch(`${BASE()}/suites/${encodeURIComponent(ref)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw await requestError(res);
}

/** One page of this agent's eval history, newest first; pass `nextCursor` back for the next page. */
export async function listEvalRuns(agentId: string, cursor?: string): Promise<{ items: EvalRunRow[]; nextCursor?: string }> {
  const q = `agentId=${encodeURIComponent(agentId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const res = await fetch(`${BASE()}/runs?${q}`, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ items: EvalRunRow[]; nextCursor?: string }>(res);
  return { items: body.items, ...(typeof body.nextCursor === 'string' && body.nextCursor ? { nextCursor: body.nextCursor } : {}) };
}

export async function getEvalProgress(runId: string): Promise<EvalProgress> {
  const res = await fetch(`${BASE()}/runs/${encodeURIComponent(runId)}/progress`, fetchOpts({ headers: authedHeaders() }));
  return asJson<EvalProgress>(res);
}

/** The normative summary (RFC 0081 §C) — the fallback when progress carries none. */
export async function getEvalSummary(runId: string): Promise<EvalSummary> {
  const res = await fetch(`${config.baseUrl}/runs/${encodeURIComponent(runId)}/eval-summary`, fetchOpts({ headers: authedHeaders(V2) }));
  return asJson<EvalSummary>(res);
}

export interface ModelPin { provider: string; model: string }

/** `ai` is sent only when the user picked a model; absent ⇒ the agent's own model. */
export async function startEvalRun(input: { evalSuiteRef: string; agentId: string; baselineRunId?: string; ai?: ModelPin }): Promise<{ runId: string }> {
  const configurable = {
    ...(input.baselineRunId ? { baselineRunId: input.baselineRunId } : {}),
    ...(input.ai ? { ai: { provider: input.ai.provider, model: input.ai.model } } : {}),
  };
  const body = {
    mode: 'eval',
    evalSuiteRef: input.evalSuiteRef,
    agentId: input.agentId,
    ...(Object.keys(configurable).length ? { configurable } : {}),
  };
  const res = await fetch(`${config.baseUrl}/runs`, fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json', ...V2 }), body: JSON.stringify(body) }));
  return asJson<{ runId: string }>(res);
}

/* ── D9: tool-boundary capture + promote a captured run to a task ────────── */

export interface CapturedRun {
  runId: string;
  calls: number;
  lastAt: string;
  /** Which lane recorded it; absent on rows captured before EVUX-7. */
  lane?: 'chat' | 'run';
  /** The first captured call as `tool: {input}`, secret-stripped, ≤120 chars. */
  inputPreview?: string;
}
export interface CaptureState { agentId: string; enabled: boolean; runs: CapturedRun[] }

export async function getCapture(agentId: string): Promise<CaptureState> {
  const res = await fetch(`${BASE()}/capture/${encodeURIComponent(agentId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<CaptureState>(res);
}

export async function setCapture(agentId: string, enabled: boolean): Promise<{ agentId: string; enabled: boolean }> {
  const res = await fetch(`${BASE()}/capture/${encodeURIComponent(agentId)}`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ enabled }) }));
  return asJson<{ agentId: string; enabled: boolean }>(res);
}

/** Append a task built from a captured run to an UNLOCKED suite version (409 when locked). */
export async function promoteRunToSuite(ref: string, input: { fromRunId: string; taskId?: string; expectedContains?: string; overrideTargetAgent?: boolean }): Promise<StoredSuite> {
  const res = await fetch(`${BASE()}/suites/${encodeURIComponent(ref)}/tasks`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<StoredSuite>(res);
}
