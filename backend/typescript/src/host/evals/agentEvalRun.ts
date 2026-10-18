/**
 * ADR 0889 D1/D3/D5 — the agent eval runner (RFC 0081 §B/§C + RFC 0244).
 *
 * An eval run is a REAL run created by `POST /runs {mode:"eval"}`. This module
 * executes it: for each task × trial it dispatches the target agent through the
 * ONE live-dispatch lane (`host/liveDispatchLane.ts`) with three substitutions:
 *   - memory   → an ephemeral per-trial port seeded from `fixtures.memorySeed`
 *                (an eval never writes the agent's real memory);
 *   - tools    → the fixture interceptor (RFC 0244 §D; a miss never reaches a
 *                live tool unless a TENANT suite says `onMiss:"live"`, A10);
 *   - model    → the run's pinned model, or the scripted `mock` (test seams).
 *
 * Every event goes through `getEventLog().append` (sequence, bus tick, closure).
 * Progress is persisted per trial in `run.metadata.eval.progress` (content-free),
 * so a crashed run resumes where it stopped (A1): a recorded trial is a recorded
 * fact — never re-run, never re-judged.
 *
 * This is a SANCTIONED SECOND EXECUTOR (an eval run has no workflow), so it must
 * mirror the run-lifecycle obligations `executeRun` meets (ADR 0889 grade
 * remediation, A1):
 *   - the advertised run-duration ceiling: `cap.breached {kind:'run-duration'}`
 *     then `run.failed {run_timeout}`, re-anchored per segment as the executor
 *     does (WF-EV-1);
 *   - the run's abort signal (`armRunAbort`): a cancel or a deadline stops the
 *     in-flight trial — no further model round, tool call or judge call (WF-EV-2);
 *   - the dispatch lease: renewed during a trial, and every progress write is
 *     fenced on it, so a reclaimed run is never overwritten by its old owner
 *     (WF-EV-7);
 *   - preamble and terminal events decided from the LOG, so a resume after a crash
 *     emits each of `run.started` / `eval.started` / `eval.completed` exactly once
 *     (WF-EV-4).
 */
import { createLogger } from '../../observability/logger.js';
import { getEventLog, RunLogClosedError } from '../../executor/eventLog.js';
import { meterJudge, trialUsageCost, UNPRICED_MOCK_MODEL } from './cost.js';
import { emitTerminalFailure, isRunDurationBreached, RUN_DISPATCH_LEASE_MS, RUN_DURATION_CEILING_MS } from '../../executor/executor.js';
import { armRunAbort, isDeadlineAbort, notifyRunTerminal } from '../../executor/runLifecycle.js';
import { runOption } from '../runOptions.js';
import { runUnderWorkerContract } from '../../storage/eventEraAdapter.js';
import { scrubSecretShaped } from '../redactSecrets.js';
import { isUntrustedMemoryRow } from '../memoryTrust.js';
import { resolveAgentForTenant } from '../agentVisibility.js';
import { readCompactionDecision } from '../../executor/compaction.js';
import { stampRunCostOnTerminal } from '../../observability/costEmitter.js';
import { foldWorkflowSpendOnTerminal } from '../workflowBudgets.js';
import { stripSecretsFromPersisted } from '../../byok/ephemeralRunSecrets.js';
import { getInstanceId } from '../instanceId.js';
import { runOwner } from '../runOwner.js';
import { runAgentDispatchLive, type AgentEvent, type AgentMemoryPort, type ExecuteAgentTool } from '../agentDispatch.js';
import { builtinAgentToolIds } from '../agentToolProvider.js';
import { agentEventToEmit } from '../agentRunnerNode.js';
import { buildLiveDispatchLane } from '../liveDispatchLane.js';
import { programMock } from '../../providers/dispatchMock.js';
import type { Storage } from '../../storage/storage.js';
import type { RunRecord } from '../../types.js';
import type { TypedEvalJudge } from '../workflowEvalJudge.js';
import { gradeOutput } from './outputGrade.js';
import { gradeTrajectory, observedFor, callMatches, type ObservedCall, type TrajectoryResult } from './trajectory.js';
import { summarizeTrials, suiteTrialStats, taskPassed, type TaskTrials } from './trialStats.js';
import { rfc0246FieldsAvailable } from './evalCapability.js';
import { countTrialEfficiency, meanEfficiency, type Efficiency } from './efficiency.js';
import { pairedRegressionVerdict, type RegressionResult } from './regressionVerdict.js';
import { MAX_COST_USD_PER_SUITE, type AgentEvalSuite, type EvalTaskDef } from './suiteStore.js';
import { SCRIPTED_AGENT_ID } from './fixtureSuites.js';

const log = createLogger('host.evals.agentEvalRun');

/* ── the run's eval metadata (A3: the reserved `metadata.eval` key + a kind) ── */

export const AGENT_SUITE_KIND = 'agent-suite';

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
  /** Host-internal reason (judge detail, error code). Shown on the host's own UI,
   *  NEVER put on an `eval.*` event or the summary. */
  detail?: string;
  /** Host-internal: the judge graded a truncated excerpt (AEV-9). */
  judgeInputTruncated?: boolean;
  /** Host-internal: the metered judge share of `costUsd` (no `provider.usage` carries it). */
  judgeCostUsd?: number;
  /** Host-internal: who judged this trial's rubric (AEV-2). A regression against a
   *  baseline judged by a different model measures the judge, not the agent. */
  judge?: JudgeIdentity;
}

export interface JudgeIdentity {
  provider: string;
  model?: string;
}

/** Why a requested regression verdict is `inconclusive` for a reason the
 *  statistics cannot show (host-internal, never on the wire). */
export type RegressionReason = 'baseline_unavailable' | 'model_class_mismatch' | 'judge_mismatch';

export interface AgentEvalMeta {
  kind: typeof AGENT_SUITE_KIND;
  suiteRef: string;
  /** Where the suite came from — a pack/conformance suite never gets live tools (A10). */
  suiteSource: 'tenant' | 'fixture' | 'pack';
  /** A pack suite's provenance (`<packName>@<packVersion>`) and content digest:
   *  its content is fixed by the pack, not a lock, so resume compares the digest. */
  suitePack?: string;
  suiteDigest?: string;
  agentId: string;
  baselineRunId?: string;
  /** Model pin (`configurable.ai`) or the scripted mock (`configurable.mockProvider`). */
  model?: { provider?: string; model?: string; credentialRef?: string };
  mock?: { rounds: Record<string, unknown[]> };
  /** RFC 0244 fields go on the wire only once the vendored v2 schemas carry them (D7). */
  rfc0244Wire: boolean;
  progress?: Record<string, Record<string, TrialRecord>>;
  /** When a trial was last recorded. The sweeper ages an orphaned eval run from
   *  here, not from `createdAt`, so a long run that is still progressing resumes
   *  and a crash loop that is not is abandoned (WF-EV-3). */
  lastProgressAt?: string;
  /** Host-internal reason a requested regression is `inconclusive` (EVD-3, AEV-2/4). */
  regressionReason?: RegressionReason;
}

/** The instant the sweeper ages an orphaned eval run from (WF-EV-3). */
export function evalProgressAnchor(run: Pick<RunRecord, 'metadata' | 'createdAt'>): string {
  const at = ((run.metadata ?? {}).eval as AgentEvalMeta | undefined)?.lastProgressAt;
  return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : run.createdAt;
}

/** `agent-eval-suite.schema.json#allowedModels` / `eval-summary#evaluatedModelClass` (RFC 0002). */
const EVALUATED_MODEL_CLASSES = new Set(['reasoning', 'writing', 'coding', 'research', 'classification', 'general']);

export function isAgentEvalRun(run: Pick<RunRecord, 'metadata'>): boolean {
  const e = (run.metadata ?? {}).eval as { kind?: unknown } | undefined;
  return !!e && e.kind === AGENT_SUITE_KIND;
}

/* ── the summary (RFC 0081 §C + RFC 0244) ─────────────────────────────────── */

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
  /** RFC 0246 §D: the task gating score; always present on a trajectory task. */
  gatedScore?: number;
}

export interface EvalSummary {
  suiteId: string;
  suiteVersion: string;
  evaluatedModelClass?: string;
  aggregateScore: number;
  passed: boolean;
  taskCount: number;
  passedCount: number;
  totalCostUsd?: number;
  /** RFC 0246 §D: the gating aggregate; present whenever any task has `expected.trajectory`. */
  gatedAggregateScore?: number;
  tasks: EvalSummaryTask[];
  trialStats?: ReturnType<typeof suiteTrialStats>;
  regression?: { baselineRunId: string; scoreDelta: number; verdict?: string; method?: string; alpha?: number; pairedTaskCount?: number };
}

/* ── ephemeral memory (RFC 0244 §B isolation) ─────────────────────────────── */

/**
 * A seed is held to the same rules as a real memory write (`agent-eval-suite`
 * `memorySeed`: "SR-1-redacted on the host side exactly like any memory write"):
 * secret-shaped tokens are scrubbed, and a seed tagged untrusted (or carrying the
 * legacy auto-extracted prefix) is served `untrusted`, so dispatch fences it exactly
 * as production would. A seed copied from production memory is not promoted to
 * trusted by being put in a suite.
 */
export function ephemeralMemory(seed: ReadonlyArray<Record<string, unknown>> | undefined): AgentMemoryPort {
  const rows: Array<{ scope: string | null; content: string; contentTrust: 'trusted' | 'untrusted' }> = (seed ?? []).map((m) => {
    const content = scrubSecretShaped(typeof m.content === 'string' ? m.content : JSON.stringify(m.value ?? m));
    const tags = Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === 'string') : [];
    return {
      scope: typeof m.scope === 'string' ? m.scope : null,
      content,
      contentTrust: isUntrustedMemoryRow(tags, content) ? 'untrusted' : 'trusted',
    };
  });
  return {
    // A seeded entry with no scope is visible to every scope the agent reads.
    read: async (scope) => rows.filter((r) => r.scope === null || r.scope === scope).map((r) => ({ content: r.content, contentTrust: r.contentTrust })),
    write: async (scope, entry) => {
      const content = scrubSecretShaped(entry.content);
      rows.push({ scope, content, contentTrust: isUntrustedMemoryRow(entry.tags ?? [], content) ? 'untrusted' : 'trusted' });
    },
  };
}

/* ── the fixture interceptor (RFC 0244 §D) ────────────────────────────────── */

export interface FixtureInterceptor {
  wrap: (inner: ExecuteAgentTool) => ExecuteAgentTool;
  observed: ObservedCall[];
  misses: () => number;
}

export function fixtureInterceptor(task: EvalTaskDef, opts: { allowLive: boolean; agentId: string; signal?: AbortSignal }): FixtureInterceptor {
  const entries = (task.fixtures?.toolResponses ?? []).map((r) => ({ ...r, consumed: false }));
  // A10 + the RFC SHOULD: absent `onMiss` ⇒ fail; `live` only for a tenant suite.
  const onMiss = task.fixtures?.onMiss === 'live' && opts.allowLive ? 'live' : 'fail';
  const observed: ObservedCall[] = [];
  let misses = 0;
  return {
    observed,
    misses: () => misses,
    wrap: (inner) => async (call) => {
      // WF-EV-2 — a cancelled or timed-out run never starts another tool call,
      // and above all never reaches a live one.
      if (opts.signal?.aborted) throw opts.signal.reason;
      observed.push({ tool: call.name, input: call.input, agentId: opts.agentId });
      const hit = entries.find((e) => !e.consumed && callMatches({ tool: e.tool, args: e.args, argsMatch: e.argsMatch }, { tool: call.name, input: call.input }));
      if (hit) {
        hit.consumed = true;
        const response = hit.response;
        return { content: typeof response === 'string' ? response : JSON.stringify(response ?? null) };
      }
      misses += 1;
      if (onMiss === 'live') return inner(call);
      return { content: `fixture_miss: no fixture response for ${call.name} with these arguments`, isError: true, errorCode: 'fixture_miss' };
    },
  };
}

/* ── run context ──────────────────────────────────────────────────────────── */

export interface AgentEvalContext {
  storage: Storage;
  run: RunRecord;
  suite: AgentEvalSuite;
  judge?: TypedEvalJudge;
  policyResolver?: Parameters<typeof buildLiveDispatchLane>[0]['policyResolver'];
  /** Test seam: replace the dispatch (unit tests drive the grader without a lane). */
  dispatch?: typeof runAgentDispatchLive;
}

function evalMeta(run: RunRecord): AgentEvalMeta {
  return (run.metadata ?? {}).eval as AgentEvalMeta;
}

async function emit(runId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await getEventLog().append({ runId, type, payload });
}

/** A trial plus whether its spend could be priced (never persisted). */
type TrialOutcome = TrialRecord & { unpriced?: boolean };

/* ── stopping ─────────────────────────────────────────────────────────────── */

type StopReason = 'cancelled' | 'lease_lost' | 'cost_ceiling' | 'cost_unpriced' | 'deadline' | 'mock_unscripted';

class EvalStop extends Error {
  constructor(readonly reason: StopReason) { super(reason); }
}

/** Why `signal` fired, as a stop: a deadline, a trial-level stop (cost, lease), or a cancel/terminal. */
function stopFor(signal: AbortSignal): EvalStop {
  if (isDeadlineAbort(signal)) return new EvalStop('deadline');
  if (signal.reason instanceof EvalStop) return signal.reason;
  return new EvalStop('cancelled');
}

/** Map anything a trial threw while its signal was aborted to the stop that caused it. */
function asStop(err: unknown, signal: AbortSignal): unknown {
  if (err instanceof EvalStop) return err;
  return signal.aborted ? stopFor(signal) : err;
}

/** Per-trial budget and abort, shared by the model lane and the judge. */
interface TrialGuard {
  /** Run abort ∪ this trial's own stop (cost ceiling, lease loss). */
  signal: AbortSignal;
  /** Stop this trial (and only this trial) with a typed reason. */
  stop: (reason: StopReason) => void;
  /** Spend recorded before this trial started. */
  spentBeforeUsd: number;
}

function trialGuard(runSignal: AbortSignal, spentBeforeUsd: number): TrialGuard & { dispose: () => void; renewEvery: (fn: () => Promise<boolean>) => void } {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    signal: AbortSignal.any([runSignal, ctl.signal]),
    stop: (reason) => { if (!ctl.signal.aborted) ctl.abort(new EvalStop(reason)); },
    spentBeforeUsd,
    // WF-EV-7 — a long trial renews the lease while it runs (the executor's
    // heartbeat), so the sweeper never reclaims a live run mid-trial. A failed
    // renewal means another instance owns the run: stop, write nothing.
    renewEvery(fn) {
      // A timer tick has no request context: it enters the worker contract (ADR 0650).
      timer = setInterval(() => runUnderWorkerContract(() => {
        void fn().then((ok) => { if (!ok && !ctl.signal.aborted) ctl.abort(new EvalStop('lease_lost')); }, () => undefined);
      }), Math.max(1_000, Math.floor(RUN_DISPATCH_LEASE_MS / 4)));
      timer.unref?.();
    },
    dispose: () => { if (timer) clearInterval(timer); },
  };
}

/** The judge as a trial uses it: metered, and refused once the next call could cross the ceiling (EVAL-5). */
function trialJudge(ctx: AgentEvalContext, meter: { usd: number }, guard: TrialGuard, modelSpendUsd: () => number): TypedEvalJudge | undefined {
  if (!ctx.judge) return undefined;
  return meterJudge(ctx.judge, meter, (estimate) => {
    if (guard.signal.aborted) throw stopFor(guard.signal);
    if (guard.spentBeforeUsd + modelSpendUsd() + meter.usd + estimate > MAX_COST_USD_PER_SUITE) {
      guard.stop('cost_ceiling');
      throw new EvalStop('cost_ceiling');
    }
  });
}

/** The provider/models that judged a trial, from the verdicts' typed identity (AEV-2). */
function judgeIdentityOf(judge: TypedEvalJudge, sink: { identity?: JudgeIdentity }): TypedEvalJudge {
  return async (input) => {
    const v = await judge(input);
    const id = (v as { judge?: JudgeIdentity }).judge;
    if (id && typeof id.provider === 'string') sink.identity = id;
    return v;
  };
}

/* ── one trial ─────────────────────────────────────────────────────────────── */

/**
 * `fixtures.md` §eval-suites — the scripted conformance agent. It makes exactly
 * the calls in `task.input.script`, in order, each through THIS host's eval tool
 * boundary (the §D interceptor when the task has `toolResponses`, else the host
 * answers with the call's own arguments), emits `agent.tool-called` with
 * `inputs`, then decides with `input.output`. No model, no live tool.
 */
async function runScriptedTrial(ctx: AgentEvalContext, task: EvalTaskDef, trialIndex: number, guard: TrialGuard): Promise<TrialOutcome> {
  const { run, suite } = ctx;
  const agentId = SCRIPTED_AGENT_ID;
  const invocationId = `${run.runId}:${task.taskId}:${trialIndex}`;
  const input = (task.input ?? {}) as { script?: Array<{ tool?: unknown; arguments?: unknown }>; output?: unknown };
  const script = Array.isArray(input.script) ? input.script : [];
  const interceptor = fixtureInterceptor(task, { allowLive: false, agentId, signal: guard.signal });
  const hasFixtures = (task.fixtures?.toolResponses ?? []).length > 0;
  const echo: ExecuteAgentTool = async (call) => ({ content: JSON.stringify(call.input ?? {}) });
  const boundary = hasFixtures ? interceptor.wrap(echo) : async (call: { name: string; input: Record<string, unknown> }) => {
    interceptor.observed.push({ tool: call.name, input: call.input, agentId });
    return echo(call);
  };
  const events: Array<{ type: string; payload?: unknown }> = [];
  const push = async (type: string, payload: Record<string, unknown>): Promise<void> => { events.push({ type, payload }); await emit(run.runId, type, payload); };
  await emit(run.runId, 'agent.invocation.started', { invocationId, agentId, source: 'run-api' });
  const started = Date.now();
  for (let i = 0; i < script.length; i += 1) {
    if (guard.signal.aborted) throw stopFor(guard.signal);
    const step = script[i]!;
    const toolName = typeof step.tool === 'string' ? step.tool : '';
    const inputs = (step.arguments && typeof step.arguments === 'object' && !Array.isArray(step.arguments) ? step.arguments : {}) as Record<string, unknown>;
    const callId = `${invocationId}:${i}`;
    await push('agent.toolCalled', { agentId, toolName, callId, inputs });
    const t0 = Date.now();
    const out = await boundary({ name: toolName, input: inputs });
    await push('agent.toolReturned', {
      agentId, toolName, callId, durationMs: Date.now() - t0,
      ...(out.isError ? { status: 'error', error: { code: out.errorCode ?? 'tool_error', message: 'fixture miss' } } : { status: 'ok' }),
    });
  }
  const output = typeof input.output === 'string' ? input.output : JSON.stringify(input.output ?? '');
  await push('agent.decided', { agentId, decision: { output }, confidence: 1 });
  await emit(run.runId, 'agent.invocation.completed', { invocationId, agentId, outcome: 'completed' });
  const latencyMs = Date.now() - started;

  const trajectory = task.expected.trajectory
    ? gradeTrajectory(task.expected.trajectory, observedFor(interceptor.observed, agentId, task.expected.trajectory.includeDelegates))
    : undefined;
  let score: number; let passed: boolean; let scoreLabel: string; let evaluatorType = 'deterministic';
  const judgeMeter = { usd: 0 };
  const judged: { identity?: JudgeIdentity } = {};
  const judge = trialJudge(ctx, judgeMeter, guard, () => 0);
  const out = await gradeOutput(output, task.expected, { ...(judge ? { judge: judgeIdentityOf(judge, judged) } : {}), passScore: suite.thresholds?.passScore ?? 1, subject: 'agent', signal: guard.signal });
  if (out === null) {
    score = trajectory?.matched ? 1 : 0; passed = !!trajectory?.matched; scoreLabel = passed ? 'pass' : 'fail';
  } else {
    score = out.score; passed = out.passed; scoreLabel = out.scoreLabel; evaluatorType = out.evaluatorType;
    if (trajectory && !trajectory.matched) { passed = false; if (scoreLabel === 'pass') scoreLabel = 'trajectory_mismatch'; }
  }
  const fixtureMissCount = interceptor.misses();
  if (fixtureMissCount > 0) { passed = false; score = 0; scoreLabel = 'fixture_miss'; }
  return {
    score, passed, scoreLabel, evaluatorType, costUsd: judgeMeter.usd, latencyMs,
    ...(judgeMeter.usd > 0 ? { judgeCostUsd: judgeMeter.usd } : {}),
    ...(trajectory ? { trajectory } : {}),
    efficiency: countTrialEfficiency(events),
    fixtureMissCount,
    ...(out?.judgeInputTruncated ? { judgeInputTruncated: true } : {}),
    ...(judged.identity ? { judge: judged.identity } : {}),
  };
}

async function runTrial(ctx: AgentEvalContext, task: EvalTaskDef, trialIndex: number, guard: TrialGuard): Promise<TrialOutcome> {
  const { run, suite } = ctx;
  const meta = evalMeta(run);
  if (meta.agentId === SCRIPTED_AGENT_ID) return runScriptedTrial(ctx, task, trialIndex, guard);
  const tenantId = run.tenantId;
  const invocationId = `${run.runId}:${task.taskId}:${trialIndex}`;
  // Review L1 — the run id is part of the node id: `dispatchMock` programs are keyed by
  // node id, so two concurrent eval runs of one suite would otherwise consume each
  // other's scripted rounds on a test host.
  const nodeId = `eval:${run.runId}:${task.taskId}:${trialIndex}`;
  const usage: Array<{ type: string; payload?: unknown }> = [];
  const interceptor = fixtureInterceptor(task, { allowLive: meta.suiteSource === 'tenant', agentId: meta.agentId, signal: guard.signal });
  const rounds = meta.mock?.rounds[task.taskId];
  if (rounds) programMock(nodeId, rounds as never);
  // H2 — a pinned model id prices the mock's usage (the cost-ceiling test); unpinned, `mock` is unpriced-exempt.
  const modelOptions = rounds ? { provider: 'mock', model: meta.model?.model ?? UNPRICED_MOCK_MODEL } : meta.model?.provider ? { provider: meta.model.provider, ...(meta.model.model ? { model: meta.model.model } : {}) } : undefined;
  const judgeMeter = { usd: 0 };

  const lane = await buildLiveDispatchLane({
    tenantId,
    agentId: meta.agentId,
    // A7 — the firewall resource names the trial.
    dispatchRunId: invocationId,
    nodeId,
    ...(typeof run.metadata?.actingUserId === 'string' ? { actingUserId: run.metadata.actingUserId as string, userId: run.metadata.actingUserId as string } : {}),
    ...(typeof run.metadata?.personalTenant === 'string' ? { personalTenant: run.metadata.personalTenant as string } : {}),
    ...(ctx.policyResolver ? { policyResolver: ctx.policyResolver } : {}),
    emit: async (type, payload) => {
      usage.push({ type, payload });
      const ev = await getEventLog().append({ runId: run.runId, type, payload });
      // EVAL-5 — the ceiling holds INSIDE a trial: the round that crosses it is
      // the last one this trial gets. Unpriceable spend cannot be held to it at all.
      if (type === 'provider.usage') {
        const spend = trialUsageCost(usage);
        if (spend.unpriced) guard.stop('cost_unpriced');
        else if (guard.spentBeforeUsd + spend.usd + judgeMeter.usd >= MAX_COST_USD_PER_SUITE) guard.stop('cost_ceiling');
      }
      return { eventId: ev.eventId, sequence: ev.sequence };
    },
    memory: ephemeralMemory(task.fixtures?.memorySeed),
    wrapExecuteTool: interceptor.wrap,
    // A6 — the eval run's FROZEN decision, not a runless re-resolution.
    compaction: readCompactionDecision(run.metadata ?? {}),
    ...(modelOptions ? { modelOptions } : {}),
    ...(meta.model?.credentialRef ? { credentialRef: meta.model.credentialRef } : {}),
    // WF-EV-2 — cancel / deadline / this trial's own stop reach every model round and tool call.
    signal: guard.signal,
    // EVAL-12 — no borrowed recall: a trial must not read the owner's corpus or
    // write a consent-ledger audit row.
    borrowedRecall: false,
  });

  await emit(run.runId, 'agent.invocation.started', { invocationId, agentId: meta.agentId, source: 'run-api' });
  const started = Date.now();
  const dispatch = ctx.dispatch ?? runAgentDispatchLive;
  const result = await dispatch(
    {
      agentId: meta.agentId,
      tenantId,
      task: task.input,
      availableTools: [...builtinAgentToolIds()],
      ...(lane.compaction ? { compaction: lane.compaction } : {}),
    },
    lane.deps,
  );
  // The dispatch turns a thrown abort into a failed result; a stopped trial is
  // not a recorded trial, whatever the dispatch made of it.
  if (guard.signal.aborted) throw stopFor(guard.signal);
  const latencyMs = Date.now() - started;
  // RFC 0064 agent.* events onto the eval run, exactly as agentRunnerNode does.
  const agentEvents: Array<{ type: string; payload?: unknown }> = [];
  for (const ev of result.events as AgentEvent[]) {
    const [type, payload] = agentEventToEmit(ev);
    agentEvents.push({ type, payload });
    await emit(run.runId, type, payload);
  }
  const outcome = result.status === 'completed' ? 'completed' : result.status === 'escalated' ? 'escalated' : 'failed';
  await emit(run.runId, 'agent.invocation.completed', { invocationId, agentId: meta.agentId, outcome });

  // ── grade ──
  const passScore = suite.thresholds?.passScore ?? 1;
  const judged: { identity?: JudgeIdentity } = {};
  const judge = trialJudge(ctx, judgeMeter, guard, () => trialUsageCost(usage).usd);
  const trajectory = task.expected.trajectory
    ? gradeTrajectory(task.expected.trajectory, observedFor(interceptor.observed, meta.agentId, task.expected.trajectory.includeDelegates))
    : undefined;
  let score: number;
  let passed: boolean;
  let scoreLabel: string;
  let evaluatorType: string;
  let detail: string | undefined;
  let judgeInputTruncated = false;
  if (result.status === 'failed') {
    score = 0; passed = false; scoreLabel = 'agent_failed'; evaluatorType = 'deterministic';
    detail = result.error?.code;
  } else {
    const out = await gradeOutput(result.result, task.expected, { ...(judge ? { judge: judgeIdentityOf(judge, judged) } : {}), passScore, subject: 'agent', signal: guard.signal });
    if (out === null) {
      // kind:"trajectory" — scored on the path alone.
      score = trajectory?.matched ? 1 : 0; passed = !!trajectory?.matched;
      scoreLabel = passed ? 'pass' : 'fail'; evaluatorType = 'deterministic';
    } else {
      score = out.score; passed = out.passed; scoreLabel = out.scoreLabel; evaluatorType = out.evaluatorType; detail = out.detail;
      judgeInputTruncated = !!out.judgeInputTruncated;
      // RFC 0244 §A — a declared trajectory is a constraint on passing.
      if (trajectory && !trajectory.matched) { passed = false; if (scoreLabel === 'pass') scoreLabel = 'trajectory_mismatch'; }
    }
  }
  // RFC 0244 §D — a fail-closed miss fails the trial.
  const fixtureMissCount = interceptor.misses();
  const failClosed = !(task.fixtures?.onMiss === 'live' && meta.suiteSource === 'tenant');
  // RFC 0244 §D (as converged with MyndHyve 2026-10-14): a fail-closed trial
  // never ran against its fixtures, so its output is not evidence — score 0,
  // not the output score. Otherwise `passRule:"mean"` / the aggregate could pass
  // a suite whose every trial failed closed (the cassette trap §D closes).
  if (fixtureMissCount > 0 && failClosed) { passed = false; score = 0; scoreLabel = 'fixture_miss'; }

  const spend = trialUsageCost(usage);
  return {
    score, passed, scoreLabel, evaluatorType,
    costUsd: spend.usd + judgeMeter.usd, latencyMs,
    ...(judgeMeter.usd > 0 ? { judgeCostUsd: judgeMeter.usd } : {}),
    ...(spend.unpriced ? { unpriced: true } : {}),
    ...(trajectory ? { trajectory } : {}),
    efficiency: countTrialEfficiency([...agentEvents, ...usage]),
    fixtureMissCount,
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
    ...(judgeInputTruncated ? { judgeInputTruncated: true } : {}),
    ...(judged.identity ? { judge: judged.identity } : {}),
  };
}

/* ── the run ──────────────────────────────────────────────────────────────── */

async function assertStillOwned(storage: Storage, runId: string): Promise<void> {
  const fresh = await storage.getRun(runId);
  if (!fresh || fresh.status === 'cancelled' || fresh.status === 'completed' || fresh.status === 'failed') throw new EvalStop('cancelled');
  const ok = await storage.renewRunDispatchLeaseIfOwner(runId, getInstanceId(), Date.now() + RUN_DISPATCH_LEASE_MS);
  if (!ok) throw new EvalStop('lease_lost');
}

/** What the run's own log already holds (WF-EV-4): the decision a resume makes. */
interface LogFacts {
  runStarted: boolean;
  evalStarted: boolean;
  evalCompleted: boolean;
  /** `eval.scored` count per task. */
  scored: Map<string, number>;
}

async function readLogFacts(runId: string): Promise<LogFacts> {
  const facts: LogFacts = { runStarted: false, evalStarted: false, evalCompleted: false, scored: new Map() };
  // The cursor is EXCLUSIVE (`sequence > fromSeq`) and sequences start at 0. The
  // scan this replaces started at 0 and stepped to `last + 1`, so it skipped the
  // first event of the log and one event per page.
  let fromSeq = -1;
  for (;;) {
    const page = await getEventLog().list(runId, { fromSeq, limit: 500 });
    for (const e of page) {
      if (e.type === 'run.started') facts.runStarted = true;
      else if (e.type === 'eval.started') facts.evalStarted = true;
      else if (e.type === 'eval.completed') facts.evalCompleted = true;
      else if (e.type === 'eval.scored') {
        const taskId = (e.payload as { taskId?: unknown } | undefined)?.taskId;
        if (typeof taskId === 'string') facts.scored.set(taskId, (facts.scored.get(taskId) ?? 0) + 1);
      }
    }
    if (page.length < 500) break;
    fromSeq = page[page.length - 1]!.sequence;
  }
  return facts;
}

/**
 * WF-EV-7 — persist one recorded trial, fenced on the lease.
 *
 * Renewing first is the fence: a sweeper can only claim a run whose lease has
 * EXPIRED, so a write made right after a successful renew cannot overlap another
 * owner's. A failed renew means the run is somebody else's: write nothing. The
 * write then merges with the stored progress rather than replacing it, so even a
 * write that did race can only ADD recorded trials, never drop one.
 */
async function persistTrial(
  storage: Storage,
  runId: string,
  meta: AgentEvalMeta,
  progress: Record<string, Record<string, TrialRecord>>,
): Promise<void> {
  const owned = await storage.renewRunDispatchLeaseIfOwner(runId, getInstanceId(), Date.now() + RUN_DISPATCH_LEASE_MS);
  if (!owned) throw new EvalStop('lease_lost');
  const fresh = await storage.getRun(runId);
  const stored = ((fresh?.metadata ?? {}).eval ?? {}) as Partial<AgentEvalMeta>;
  for (const [taskId, trials] of Object.entries(stored.progress ?? {})) {
    // A trial recorded elsewhere is a recorded fact: it wins over this copy.
    progress[taskId] = { ...(progress[taskId] ?? {}), ...trials };
  }
  await storage.mergeRunMetadata(runId, { eval: { ...meta, ...stored, progress, lastProgressAt: new Date().toISOString() } });
}

/** The run-duration bound for this segment (RFC 0058; the executor's own rule). */
function segmentDeadline(run: RunRecord): { limitMs: number; startMs: number; deadlineAt: number } {
  const raw = runOption(run.configurable, 'runTimeoutMs');
  const requested = typeof raw === 'number' && raw > 0 ? raw : undefined;
  const limitMs = requested !== undefined ? Math.min(requested, RUN_DURATION_CEILING_MS) : RUN_DURATION_CEILING_MS;
  // Re-anchored per segment, exactly as `executeRun` does on re-entry. A deadline
  // persisted at first start would fail every resume on arrival: the sweeper only
  // reclaims a run once its lease (the ceiling + 120 s) has expired.
  const startMs = Date.now();
  return { limitMs, startMs, deadlineAt: startMs + limitMs };
}

/** Execute (or resume) an eval run. Never throws: every failure is a typed `run.failed`. */
export async function runAgentEval(ctx: AgentEvalContext, opts: { resume?: boolean } = {}): Promise<EvalSummary | null> {
  const { storage, run, suite } = ctx;
  const meta = evalMeta(run);
  const runId = run.runId;
  const trialCount = suite.trials?.count ?? 1;
  const k = suite.trials?.k ?? trialCount;
  const passRule = suite.trials?.passRule ?? 'all';
  const progress: Record<string, Record<string, TrialRecord>> = { ...(meta.progress ?? {}) };
  const deadline = segmentDeadline(run);
  // WF-EV-2 — the run's signal: fires on cancel (any terminal) and at the deadline.
  const runSignal = armRunAbort(runId, deadline.deadlineAt);
  try {
    if (!opts.resume) await storage.setRunDispatchLease(runId, getInstanceId(), Date.now() + RUN_DISPATCH_LEASE_MS);
    const facts = await readLogFacts(runId);
    if (!facts.runStarted) {
      // Same projection the executor echoes (`host/runOwner.ts`), so log and snapshot agree.
      const ownerEcho = runOwner(run);
      await emit(runId, 'run.started', { workflowId: run.workflowId, ...(ownerEcho ? { owner: ownerEcho } : {}) });
    }
    if (!facts.runStarted || run.status === 'pending') await storage.updateRun(runId, { status: 'running' });
    if (!facts.evalStarted) {
      await emit(runId, 'eval.started', {
        suiteId: suite.suiteId,
        suiteVersion: suite.version,
        taskCount: suite.tasks.length,
        modes: suite.modes,
        ...(meta.baselineRunId ? { baselineRunId: meta.baselineRunId } : {}),
        ...(meta.rfc0244Wire && trialCount > 1 ? { trialCount } : {}),
      });
    }
    // A scripted mock with no rounds for a task would send that task to the agent's
    // REAL default model: a "scripted" run spending real money, non-deterministically.
    if (meta.mock && meta.agentId !== SCRIPTED_AGENT_ID && suite.tasks.some((t) => !meta.mock!.rounds[t.taskId])) {
      throw new EvalStop('mock_unscripted');
    }
    let spentUsd = Object.values(progress).flatMap((t) => Object.values(t)).reduce((s, t) => s + t.costUsd, 0);
    const scoredEvent = (taskId: string, trial: number, rec: TrialRecord) => emit(runId, 'eval.scored', {
      taskId,
      score: rec.score,
      passed: rec.passed,
      costUsd: rec.costUsd,
      latencyMs: rec.latencyMs,
      ...(meta.rfc0244Wire ? { trialIndex: trial, scoreLabel: rec.scoreLabel, evaluatorType: rec.evaluatorType } : {}),
    });
    // Review M1 — a crash between persisting a trial and emitting its `eval.scored`
    // leaves a recorded trial with no event. Re-emit exactly those, never re-run them.
    await reemitMissingScored(progress, facts.scored, scoredEvent);
    for (const task of suite.tasks) {
      for (let trial = 0; trial < trialCount; trial += 1) {
        if (progress[task.taskId]?.[String(trial)]) continue; // A1 — a recorded trial is a recorded fact
        if (runSignal.aborted) throw stopFor(runSignal);
        if (isRunDurationBreached(Date.now(), deadline.deadlineAt)) throw new EvalStop('deadline');
        await assertStillOwned(storage, runId);
        if (spentUsd >= MAX_COST_USD_PER_SUITE) throw new EvalStop('cost_ceiling');
        const guard = trialGuard(runSignal, spentUsd);
        guard.renewEvery(() => storage.renewRunDispatchLeaseIfOwner(runId, getInstanceId(), Date.now() + RUN_DISPATCH_LEASE_MS));
        let outcome: TrialOutcome;
        try {
          outcome = await runTrial(ctx, task, trial, guard);
        } catch (err) {
          throw asStop(err, guard.signal);
        } finally {
          guard.dispose();
        }
        const { unpriced, ...rec } = outcome;
        // Review H2 — spend that cannot be priced cannot be held to the ceiling.
        if (unpriced) throw new EvalStop('cost_unpriced');
        spentUsd += rec.costUsd;
        // Review M1 — persist FIRST: the recorded trial is what resume trusts.
        progress[task.taskId] = { ...(progress[task.taskId] ?? {}), [String(trial)]: rec };
        await persistTrial(storage, runId, meta, progress);
        await scoredEvent(task.taskId, trial, rec);
      }
    }
    const { summary, regressionReason } = await buildSummary(ctx, progress, { trialCount, k, passRule });
    if (!facts.evalCompleted) {
      await emit(runId, 'eval.completed', {
        aggregateScore: summary.aggregateScore,
        passed: summary.passed,
        taskCount: summary.taskCount,
        passedCount: summary.passedCount,
        ...(summary.regression ? { regressionVsBaseline: clamp(summary.regression.scoreDelta, -1, 1) } : {}),
      });
    }
    let evalPatch: Record<string, unknown> = {};
    if (regressionReason) {
      const stored = ((await storage.getRun(runId))?.metadata?.eval ?? {}) as Partial<AgentEvalMeta>;
      evalPatch = { eval: { ...meta, ...stored, regressionReason } };
    }
    await storage.mergeRunMetadata(runId, { evalSummary: summary, ...evalPatch });
    await emit(runId, 'run.completed', { outputs: stripSecretsFromPersisted(summary as unknown as Record<string, unknown>) as Record<string, unknown> });
    await storage.updateRun(runId, { status: 'completed', completedAt: new Date().toISOString() });
    await settleEvalCost(storage, runId, { completedTotalUsd: summary.totalCostUsd ?? 0 });
    log.info('agent_eval_terminal', { runId, status: 'completed', passed: summary.passed });
    notifyRunTerminal(runId, 'completed');
    return summary;
  } catch (err) {
    const stop = asStop(err, runSignal);
    if (stop instanceof RunLogClosedError || (stop instanceof EvalStop && stop.reason === 'cancelled')) {
      log.info('agent_eval_stopped_run_closed', { runId });
      return null;
    }
    if (stop instanceof EvalStop && stop.reason === 'lease_lost') {
      // ADR 0585 P0b — the run is somebody else's: write nothing.
      log.warn('agent_eval_lease_lost', { runId });
      return null;
    }
    try {
      if (stop instanceof EvalStop && stop.reason === 'deadline') {
        await breachRunDuration(storage, runId, deadline);
      } else {
        const error = stop instanceof EvalStop ? stopError(stop.reason) : { code: 'eval_run_failed', message: stop instanceof Error ? stop.message.slice(0, 300) : 'eval run failed' };
        log.error('agent_eval_failed', { runId, code: error.code });
        await emitTerminalFailure({ storage, runId, error });
      }
      await settleEvalCost(storage, runId, { failedJudgeUsd: recordedJudgeUsd(progress) });
      notifyRunTerminal(runId, 'failed');
    } catch (e2) {
      if (!(e2 instanceof RunLogClosedError)) log.error('agent_eval_terminal_emit_failed', { runId });
    }
    return null;
  }
}

function stopError(reason: StopReason): { code: string; message: string } {
  switch (reason) {
    case 'cost_ceiling':
      return { code: 'eval_cost_ceiling_exceeded', message: `The eval run reached the host ceiling of $${MAX_COST_USD_PER_SUITE} and stopped.` };
    case 'cost_unpriced':
      return { code: 'eval_cost_unpriced', message: 'A trial used a model this host cannot price, so the eval run cannot be held to its cost ceiling. Pin a catalog model.' };
    case 'mock_unscripted':
      return { code: 'eval_mock_unscripted', message: 'configurable.mockProvider scripts no rounds for at least one task; an unscripted task would reach a real model.' };
    default:
      return { code: 'eval_run_failed', message: `eval run stopped (${reason})` };
  }
}

/**
 * WF-EV-1 — the advertised `limits.maxRunDurationMs` holds for eval runs too.
 * Same shape and order as the executor's breach: `cap.breached` first, with
 * `observed` STRICTLY greater than `limit`, then `run.failed {run_timeout}`.
 */
async function breachRunDuration(storage: Storage, runId: string, d: { limitMs: number; startMs: number; deadlineAt: number }): Promise<void> {
  while (!isRunDurationBreached(Date.now(), d.deadlineAt)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  const observed = Date.now() - d.startMs;
  log.warn('agent_eval_run_timeout', { runId, limitMs: d.limitMs, observedMs: observed });
  await getEventLog().append({ runId, type: 'cap.breached', payload: { kind: 'run-duration', limit: d.limitMs, observed } });
  await emitTerminalFailure({
    storage,
    runId,
    error: { code: 'run_timeout', message: `Eval run exceeded effective runTimeoutMs=${d.limitMs}ms (elapsed ${observed}ms); the trials recorded so far are kept.` },
  });
}

/**
 * EVD-8 + ADR 0482 — the run's spend, stamped AND folded into the tenant's
 * spend-day counter ("ALL terminal spend counts … eval", `workflowBudgets.ts`).
 *
 * `stampRunCostOnTerminal` folds only `provider.usage` events (bounded at 5 000),
 * and the headless judge emits none, so it under-reports an eval run. Before this
 * the runner also DISCARDED the stamp's fold ticket on completion, so a completed
 * eval run's spend never reached the counter at all.
 *
 *   completed: stamp (ticket = what it wrote), then raise `costUsd` to the
 *     recorded total (model + metered judge, no event scan). The fold is the
 *     ticket plus the raise: exactly the WRITTEN figure, never a second count of
 *     a stamp an earlier writer (a raced cancel) already folded.
 *   failed:    `emitTerminalFailure` already stamped and folded the model spend
 *     from events; only the recorded JUDGE spend is missing, so it is added on
 *     top and folded.
 */
async function settleEvalCost(storage: Storage, runId: string, opts: { completedTotalUsd: number } | { failedJudgeUsd: number }): Promise<number> {
  let folded = 0;
  try {
    if ('completedTotalUsd' in opts) folded = await stampRunCostOnTerminal(storage, runId).catch(() => 0);
    const stamped = (await storage.getRun(runId))?.metadata?.costUsd;
    const current = typeof stamped === 'number' && Number.isFinite(stamped) ? stamped : 0;
    const target = 'completedTotalUsd' in opts ? opts.completedTotalUsd : current + opts.failedJudgeUsd;
    if (target > current) {
      await storage.mergeRunMetadata(runId, { costUsd: Number(target.toFixed(6)) });
      folded += target - current;
    }
  } catch (err) {
    log.warn('agent_eval_cost_stamp_failed', { runId, error: err instanceof Error ? err.message : String(err) });
  }
  if (folded > 0) await foldWorkflowSpendOnTerminal(storage, runId, Number(folded.toFixed(6)));
  return folded;
}

/** Judge spend across recorded trials (older records carry none: 0). */
function recordedJudgeUsd(progress: Record<string, Record<string, TrialRecord>>): number {
  return Object.values(progress).flatMap((t) => Object.values(t)).reduce((s, t) => s + (t.judgeCostUsd ?? 0), 0);
}

/** Review M1 — emit `eval.scored` for recorded trials the event log does not have. */
async function reemitMissingScored(
  progress: Record<string, Record<string, TrialRecord>>,
  seen: Map<string, number>,
  scoredEvent: (taskId: string, trial: number, rec: TrialRecord) => Promise<void>,
): Promise<void> {
  for (const [taskId, trials] of Object.entries(progress)) {
    const recorded = Object.keys(trials).map(Number).sort((a, b) => a - b);
    const emitted = seen.get(taskId) ?? 0;
    // Trials run in order, so the emitted ones are a prefix of the recorded ones.
    for (const trial of recorded.slice(emitted)) await scoredEvent(taskId, trial, trials[String(trial)]!);
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** A trial that failed a CONSTRAINT rather than its output criterion (RFC 0244 §A, §D). */
const CONSTRAINT_LABELS = new Set(['trajectory_mismatch', 'fixture_miss']);

/** The model class the run evaluated: the target agent manifest's `modelClass` (RFC 0002). */
async function evaluatedModelClassOf(run: RunRecord, agentId: string): Promise<string | undefined> {
  if (agentId === SCRIPTED_AGENT_ID) return undefined;
  try {
    const agent = await resolveAgentForTenant(agentId, run.tenantId);
    const cls = (agent as { modelClass?: unknown } | null)?.modelClass;
    return typeof cls === 'string' && EVALUATED_MODEL_CLASSES.has(cls) ? cls : undefined;
  } catch {
    return undefined;
  }
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** The distinct judge identities across a run's recorded trials. */
function judgesOf(progress: Record<string, Record<string, TrialRecord>> | undefined): Set<string> {
  const out = new Set<string>();
  for (const trials of Object.values(progress ?? {})) {
    for (const t of Object.values(trials)) if (t.judge) out.add(`${t.judge.provider}/${t.judge.model ?? ''}`);
  }
  return out;
}

async function buildSummary(
  ctx: AgentEvalContext,
  progress: Record<string, Record<string, TrialRecord>>,
  t: { trialCount: number; k: number; passRule: 'all' | 'any' | 'mean' },
): Promise<{ summary: EvalSummary; regressionReason?: RegressionReason }> {
  const { suite } = ctx;
  const meta = evalMeta(ctx.run);
  const passScore = suite.thresholds?.passScore;
  const tasks: EvalSummaryTask[] = [];
  const perTaskTrials: TaskTrials[] = [];
  let gateScoreSum = 0;
  let anyTrajectory = false;
  const gatedFields = meta.rfc0244Wire && rfc0246FieldsAvailable();
  for (const task of suite.tasks) {
    const recs = Array.from({ length: t.trialCount }, (_, i) => progress[task.taskId]?.[String(i)]).filter((r): r is TrialRecord => !!r);
    const trials = summarizeTrials(recs.map((r) => ({ score: r.score, passed: r.passed })), Math.min(t.k, recs.length || 1));
    perTaskTrials.push(trials);
    const last = recs[recs.length - 1];
    // EVAL-1 / RFC 0246 §A — the GATE score: a trial that failed a constraint
    // (its trajectory, or fail-closed on a fixture miss) contributes 0.
    const gatedScore = recs.length ? recs.reduce((s, r) => s + (CONSTRAINT_LABELS.has(r.scoreLabel) ? 0 : r.score), 0) / recs.length : 0;
    // RFC 0246 §B — under `mean` the task passes on its gating score.
    const passed = t.trialCount > 1 ? taskPassed(trials, t.passRule, passScore, gatedScore) : !!last?.passed;
    const misses = recs.reduce((s, r) => s + r.fixtureMissCount, 0);
    gateScoreSum += gatedScore;
    const hasTrajectory = task.expected.trajectory !== undefined;
    if (hasTrajectory) anyTrajectory = true;
    tasks.push({
      taskId: task.taskId,
      score: trials.meanScore,
      passed,
      costUsd: recs.reduce((s, r) => s + r.costUsd, 0),
      latencyMs: Math.round(recs.reduce((s, r) => s + r.latencyMs, 0) / (recs.length || 1)),
      ...(meta.rfc0244Wire && last?.trajectory ? { trajectory: last.trajectory } : {}),
      ...(meta.rfc0244Wire && t.trialCount > 1 ? { trials } : {}),
      ...(meta.rfc0244Wire ? { efficiency: meanEfficiency(recs.map((r) => r.efficiency)), fixtureMissCount: misses } : {}),
      // RFC 0246 §D — always on a trajectory task; elsewhere only when it differs.
      ...(gatedFields && (hasTrajectory || gatedScore !== trials.meanScore) ? { gatedScore } : {}),
    });
  }
  const taskCount = tasks.length;
  const passedCount = tasks.filter((x) => x.passed).length;
  const aggregateScore = taskCount ? tasks.reduce((s, x) => s + x.score, 0) / taskCount : 0;
  const totalCostUsd = tasks.reduce((s, x) => s + (x.costUsd ?? 0), 0);
  const latencies = tasks.map((x) => x.latencyMs ?? 0).sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(0.95 * latencies.length) - 1)] : 0;
  // EVAL-1 — the suite verdict gates on the constraint-adjusted aggregate. The
  // reported `aggregateScore` keeps the RFC 0244 §A rule (a trial's score is its
  // output score), but a suite whose answers were right and whose PATHS were all
  // wrong must not report `passed:true` — that `passed` drives promotion gates.
  const gateScore = taskCount ? gateScoreSum / taskCount : 0;
  let passed = gateScore >= (passScore ?? 1);
  if (suite.thresholds?.maxCostUsd !== undefined && totalCostUsd > suite.thresholds.maxCostUsd) passed = false;
  if (suite.thresholds?.maxP95LatencyMs !== undefined && p95 > suite.thresholds.maxP95LatencyMs) passed = false;
  const evaluatedModelClass = await evaluatedModelClassOf(ctx.run, meta.agentId);
  const summary: EvalSummary = {
    suiteId: suite.suiteId, suiteVersion: suite.version,
    ...(evaluatedModelClass ? { evaluatedModelClass } : {}),
    aggregateScore, passed, taskCount, passedCount, totalCostUsd,
    ...(gatedFields && anyTrajectory ? { gatedAggregateScore: gateScore } : {}),
    tasks,
    ...(meta.rfc0244Wire && t.trialCount > 1 ? { trialStats: suiteTrialStats(perTaskTrials, t.k) } : {}),
  };
  if (!meta.baselineRunId) return { summary };

  const base = await ctx.storage.getRun(meta.baselineRunId);
  const baseSummary = (base && base.tenantId === ctx.run.tenantId ? base.metadata?.evalSummary ?? null : null) as EvalSummary | null;
  let reason: RegressionReason | undefined;
  let r: RegressionResult;
  if (!baseSummary) {
    // EVD-3 — a requested comparison never silently vanishes: no baseline summary
    // (failed, cancelled, still running, retention-deleted) ⇒ nothing was paired.
    reason = 'baseline_unavailable';
    r = pairedRegressionVerdict([], tasks.map((x) => ({ taskId: x.taskId, meanScore: x.score })));
  } else {
    r = pairedRegressionVerdict(
      baseSummary.tasks.map((x) => ({ taskId: x.taskId, meanScore: x.score })),
      tasks.map((x) => ({ taskId: x.taskId, meanScore: x.score })),
    );
    const baseMeta = (base?.metadata?.eval ?? {}) as Partial<AgentEvalMeta>;
    const baseJudges = judgesOf(baseMeta.progress);
    const ourJudges = judgesOf(progress);
    // AEV-4 — scores from two model classes are not comparable.
    if (baseSummary.evaluatedModelClass && evaluatedModelClass && baseSummary.evaluatedModelClass !== evaluatedModelClass) {
      reason = 'model_class_mismatch';
    } else if (baseJudges.size > 0 && ourJudges.size > 0 && !sameSet(baseJudges, ourJudges)) {
      // AEV-2 — a different judge moves every rubric score: the verdict would measure the judge.
      reason = 'judge_mismatch';
    }
    if (reason) r = { ...r, verdict: 'inconclusive' };
  }
  if (!meta.rfc0244Wire && reason === 'baseline_unavailable') {
    // No verdict field on this wire: a bare `scoreDelta: 0` would read "no change". Omit it.
    return { summary, regressionReason: reason };
  }
  summary.regression = {
    baselineRunId: meta.baselineRunId,
    scoreDelta: r.scoreDelta,
    ...(meta.rfc0244Wire ? { verdict: r.verdict, method: r.method, alpha: r.alpha, pairedTaskCount: r.pairedTaskCount } : {}),
  };
  return { summary, ...(reason ? { regressionReason: reason } : {}) };
}
