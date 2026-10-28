/**
 * ADR 0889 grade remediation (A1) — the eval runner meets the run-lifecycle
 * obligations of the executor it stands beside. Each `describe` is one finding:
 *
 *   EVAL-1 / M2  a right answer on the wrong PATH fails the trial (trajectory_mismatch,
 *                score kept) and the SUITE (constraint-adjusted gate).
 *   WF-EV-1      the run-duration ceiling: cap.breached{run-duration} then run_timeout.
 *   WF-EV-2      cancel stops the in-flight trial: no further tool/model call, no
 *                recorded trial, no eval.completed.
 *   WF-EV-4      resume decides from the LOG: exactly one run.started / eval.started /
 *                eval.completed across the three crash windows.
 *   WF-EV-7      a progress write is fenced on the lease, and merges, never drops.
 *   M9           a recorded trial is never dispatched again, with a lease that IS owned.
 *   B2 / WF-EV-3 the sweeper resumes an orphaned eval run in the eval runner, aged from
 *                its last recorded trial; a crash loop with no progress is abandoned.
 *   M5           `:pause` and `:resume` refuse an eval run (409, typed reason).
 *   M12          resume refuses on toggle-off, on a changed suite digest, on a deleted suite.
 *   EVAL-5       the cost ceiling holds INSIDE a trial (the judge call is refused).
 *   EVD-3 / AEV-2 / AEV-4  a regression that cannot be compared is `inconclusive`,
 *                with the host-internal reason; evaluatedModelClass is stamped.
 *   EVD-8 / M8   run.metadata.costUsd includes judge spend; maxCostUsd fails the suite.
 *   ADR 0482     eval spend (model + judge) reaches the tenant's spend-day counter, on
 *                completion and on failure (it never did on completion before).
 *   RFC 0244 §D  a fail-closed trial scores 0 even when its output was right.
 *   RFC 0246     `mean` tasks and the suite pass on the gating score; gatedScore /
 *                gatedAggregateScore are carried wherever a trajectory can gate.
 *   AEV-15       a mock run with an unscripted task never reaches a model.
 *   B3           an eval trial never writes the agent's real memory.
 *   m7 / m10     eval.* payloads carry no content; efficiency never fails a task.
 *   m8           a captured tool result is cut at MAX_RESULT_CHARS (16 000).
 *
 * (TST-BPA) Red when (each sabotage-witnessed, wave 65): the trajectory constraint is
 * dropped (EVAL-1); a fail-closed trial keeps its output score (RFC 0244 §D); the
 * unscripted-task check passes a partly scripted mock (AEV-15); `persistTrial` writes
 * without the lease, or replaces stored progress instead of merging (WF-EV-7); a
 * recorded trial is dispatched again (M9); the run-duration breach event is skipped
 * (WF-EV-1); gated scores ignore constraint labels (RFC 0246); the model-class or judge
 * comparison is skipped (AEV-4 / AEV-2); `:pause` stops refusing an eval run (M5); the
 * judge ceiling check is skipped (EVAL-5); an `eval.scored` payload carries the trial
 * detail (m7); a failed run skips the spend fold (ADR 0482); the capture cut is removed
 * (m8); resume skips its toggle or digest refusal (M12); the trial guard's signal stops
 * carrying the run's abort, or the lane loses the signal (WF-EV-2, below).
 *
 * DOUBLE GUARD (recorded, WF-EV-2 tool half): a tool call after cancel is refused twice,
 * by the lane's `guardWithSignal` (`host/liveDispatchLane.ts`) and, inside it, by the
 * fixture interceptor's own abort check (`fixtureInterceptor` in `agentEvalRun.ts`), so
 * dropping the interceptor check alone stays green (`adr0889-runner-units` witnesses it
 * alone). Both read ONE signal, the trial guard's `AbortSignal.any([runSignal, …])`;
 * cutting the run signal out of it reds this case, and so does removing the lane's
 * signal (the model half has only the lane guard). The M12 runs carry a scripted
 * mock for every task, so a resume that wrongly proceeds reaches the mock, never a real
 * provider.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { buildRunRecord } from '../src/host/runDispatch.js';
import { runAgentEval, AGENT_SUITE_KIND, type AgentEvalMeta, type TrialRecord } from '../src/host/evals/agentEvalRun.js';
import { resumeAgentEvalRun } from '../src/host/evals/resumeEvalRun.js';
import { getEventLog } from '../src/executor/eventLog.js';
import { evalWorkflowId, putEvalSuite, validateEvalSuite, type AgentEvalSuite } from '../src/host/evals/suiteStore.js';
import { suiteDigest } from '../src/host/evals/packSuites.js';
import { getInstanceId } from '../src/host/instanceId.js';
import { cancelRunAndCascade } from '../src/host/runCancel.js';
import { sweepOrphanedRuns } from '../src/host/runDispatchSweeper.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createAgentMemoryPort, agentMemoryScope } from '../src/host/agentMemoryAdapter.js';
import type { RunRecord } from '../src/types.js';
import { listRunBoundary, maybeCaptureExecuteTool, MAX_RESULT_CHARS, setCaptureSetting } from '../src/host/evals/toolBoundary.js';
import type { Storage } from '../src/storage/storage.js';
import type { TypedEvalJudge } from '../src/host/workflowEvalJudge.js';
import { getTodaySpendUsd } from '../src/host/workflowBudgets.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import type { AgentEvalContext } from '../src/host/evals/agentEvalRun.js';
import type { LiveDispatchDeps, AgentDispatchResult, ExecuteAgentTool } from '../src/host/agentDispatch.js';
import { ManagedProviderError } from '../src/providers/managedProvider.js';

let server: Server;
let base = '';
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
const TENANT = 'default';
const AGENT = 'eval.lifecycle-agent';
let storage: Storage;
let seq = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  storage = hostExtStorage();
  getAgentRegistry().register({
    agentId: AGENT, persona: 'Eval subject', modelClass: 'research', systemPrompt: 'Answer.',
    packName: 'test', packVersion: '0', toolAllowlist: [], confidence: { defaultThreshold: 0.1 },
  });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const GOLDEN = (taskId: string, extra: Record<string, unknown> = {}) => ({ taskId, input: { q: taskId }, expected: { kind: 'golden', match: { strategy: 'contains', value: 'ok' } }, ...extra });

function suiteOf(name: string, tasks: unknown[], extra: Record<string, unknown> = {}): AgentEvalSuite {
  return validateEvalSuite({ suiteId: `test.acme.evals.${name}`, version: '1.0.0', modes: ['golden'], tasks, ...extra });
}

const REC = (over: Partial<TrialRecord> = {}): TrialRecord => ({
  score: 1, passed: true, scoreLabel: 'pass', evaluatorType: 'deterministic', costUsd: 0, latencyMs: 1,
  efficiency: { toolCallCount: 0, modelCallCount: 0, inputTokens: 0, outputTokens: 0 },
  fixtureMissCount: 0, ...over,
});

async function evalRun(suite: AgentEvalSuite, meta: Partial<AgentEvalMeta> = {}, over: Partial<RunRecord> = {}): Promise<RunRecord> {
  const ref = `${suite.suiteId}@${suite.version}`;
  const run = buildRunRecord({ workflowId: evalWorkflowId(ref), tenantId: TENANT, inputs: {}, metadata: {}, configurable: {}, now: new Date().toISOString() });
  run.runId = `${run.runId}-${seq += 1}`;
  run.metadata = { mode: 'eval', eval: { kind: AGENT_SUITE_KIND, suiteRef: ref, suiteSource: 'tenant', agentId: AGENT, rfc0244Wire: true, ...meta } };
  Object.assign(run, over);
  await storage.insertRun(run);
  return run;
}

/** The fake agent: runs `body` against the REAL lane deps (interceptor, guard, memory), then answers. */
type Dispatch = NonNullable<AgentEvalContext['dispatch']>;
const answer = (result: unknown, status: AgentDispatchResult['status'] = 'completed'): AgentDispatchResult =>
  ({ agentId: AGENT, persona: 'p', modelClass: 'research', status, toolSurface: [], confidence: 1, threshold: 0, events: [], result });
function agent(body: (deps: LiveDispatchDeps) => Promise<unknown> = async () => 'ok', status: 'completed' | 'failed' = 'completed') {
  let calls = 0;
  const dispatch: Dispatch = async (_req, deps) => {
    calls += 1;
    return answer(await body(deps), status);
  };
  return { dispatch, calls: () => calls };
}
/** The lane's real tool executor (the fixture interceptor + run guard). */
const tool = (deps: LiveDispatchDeps, name: string) => deps.executeTool!({ name, input: {} });

async function events(runId: string): Promise<Array<{ type: string; payload?: unknown; sequence: number }>> {
  return [...await getEventLog().list(runId, { limit: 1000 })];
}
const count = async (runId: string, type: string) => (await events(runId)).filter((e) => e.type === type).length;
const fresh = async (runId: string) => (await storage.getRun(runId))!;
const metaOf = (r: RunRecord) => (r.metadata?.eval ?? {}) as AgentEvalMeta;

async function owned(run: RunRecord, owner = getInstanceId()): Promise<void> {
  await storage.setRunDispatchLease(run.runId, owner, Date.now() + 600_000);
}

/* ── EVAL-1 ───────────────────────────────────────────────────────────────── */

describe('EVAL-1 / M2 — a right answer on the wrong path fails the trial and the suite', () => {
  it('trajectory_mismatch keeps the output score but the suite does not pass', async () => {
    const suite = suiteOf('eval1', [GOLDEN('t', {
      expected: { kind: 'golden', match: { strategy: 'contains', value: 'ok' }, trajectory: { match: 'in-order', calls: [{ tool: 'crm:lookup' }] } },
      fixtures: { toolResponses: [{ tool: 'web:search', response: { hits: 0 } }], onMiss: 'fail' },
    })]);
    const run = await evalRun(suite);
    const a = agent(async (deps) => { await tool(deps, 'web:search'); return 'ok'; });
    const summary = await runAgentEval({ storage, run, suite, dispatch: a.dispatch });
    expect(summary).toMatchObject({ aggregateScore: 1, passed: false, passedCount: 0 });
    expect(metaOf(await fresh(run.runId)).progress?.t?.['0']).toMatchObject({ score: 1, passed: false, scoreLabel: 'trajectory_mismatch' });
  });

  it('m10 — the same path matched passes, however many tool calls it took', async () => {
    const suite = suiteOf('eval1ok', [GOLDEN('t', {
      expected: { kind: 'golden', match: { strategy: 'contains', value: 'ok' }, trajectory: { match: 'in-order', calls: [{ tool: 'crm:lookup' }] } },
      fixtures: { toolResponses: Array.from({ length: 6 }, () => ({ tool: 'crm:lookup', response: { ok: true } })), onMiss: 'fail' },
    })]);
    const run = await evalRun(suite);
    const a = agent(async (deps) => {
      for (let i = 0; i < 6; i += 1) await tool(deps, 'crm:lookup');
      return 'ok';
    });
    const summary = await runAgentEval({ storage, run, suite, dispatch: a.dispatch });
    expect(summary?.passed).toBe(true);
    expect(summary?.tasks[0]).toMatchObject({ passed: true, fixtureMissCount: 0 });
  });
});

/* ── RFC 0246 ─────────────────────────────────────────────────────────────── */

describe('RFC 0246 — a trajectory-failed trial cannot carry a task or the suite to a pass', () => {
  const PATH = { match: 'in-order', calls: [{ tool: 'crm:lookup' }], forbidden: ['web:search'] };
  const FIX = { toolResponses: Array.from({ length: 4 }, (_, i) => ({ tool: i % 2 ? 'web:search' : 'crm:lookup', response: { ok: true } })), onMiss: 'fail' };
  const call = tool;

  it('§B mean: every trial right but forbidden ⇒ meanScore 1, gatedScore 0, task and suite fail', async () => {
    const suite = suiteOf('g246mean', [GOLDEN('t', { expected: { kind: 'golden', match: { strategy: 'contains', value: 'ok' }, trajectory: PATH }, fixtures: FIX })],
      { thresholds: { passScore: 0.6 }, trials: { count: 2, passRule: 'mean' } });
    const run = await evalRun(suite);
    const a = agent(async (deps) => { await call(deps, 'crm:lookup'); await call(deps, 'web:search'); return 'ok'; });
    const summary = await runAgentEval({ storage, run, suite, dispatch: a.dispatch });
    expect(summary?.tasks[0]).toMatchObject({ score: 1, gatedScore: 0, passed: false, trials: { meanScore: 1 } });
    expect(summary).toMatchObject({ aggregateScore: 1, gatedAggregateScore: 0, passed: false });
  });

  it('§B suite + §D: one task matched, one wrong path ⇒ gatedScores 1/0, gatedAggregateScore 0.5, suite fails', async () => {
    const suite = suiteOf('g246suite', [
      GOLDEN('good', { expected: { kind: 'golden', match: { strategy: 'contains', value: 'ok' }, trajectory: PATH }, fixtures: FIX }),
      GOLDEN('bad', { expected: { kind: 'golden', match: { strategy: 'contains', value: 'ok' }, trajectory: PATH }, fixtures: FIX }),
    ], { thresholds: { passScore: 0.6 } });
    const run = await evalRun(suite);
    let n = 0;
    const a = agent(async (deps) => { await call(deps, 'crm:lookup'); if ((n += 1) === 2) await call(deps, 'web:search'); return 'ok'; });
    const summary = await runAgentEval({ storage, run, suite, dispatch: a.dispatch });
    expect(summary?.tasks.map((x) => [x.taskId, x.score, x.gatedScore])).toEqual([['good', 1, 1], ['bad', 1, 0]]);
    expect(summary).toMatchObject({ aggregateScore: 1, gatedAggregateScore: 0.5, passed: false });
  });

  it('§D: a suite with no trajectory carries neither field', async () => {
    const suite = suiteOf('g246none', [GOLDEN('t')], { thresholds: { passScore: 0.6 } });
    const run = await evalRun(suite);
    const summary = await runAgentEval({ storage, run, suite, dispatch: agent().dispatch });
    expect(summary?.passed).toBe(true);
    expect(summary).not.toHaveProperty('gatedAggregateScore');
    expect(summary?.tasks[0]).not.toHaveProperty('gatedScore');
  });
});

/* ── WF-EV-1 ──────────────────────────────────────────────────────────────── */

describe('WF-EV-1 — the run-duration ceiling holds for an eval run', () => {
  it('a trial past the deadline ends cap.breached{run-duration} then run.failed{run_timeout}', async () => {
    const suite = suiteOf('deadline', [GOLDEN('t'), GOLDEN('u')]);
    const run = await evalRun(suite, {}, { configurable: { runTimeoutMs: 60 } });
    const a = agent(async () => { await new Promise((r) => setTimeout(r, 150)); return 'ok'; });
    expect(await runAgentEval({ storage, run, suite, dispatch: a.dispatch })).toBeNull();
    const evs = await events(run.runId);
    const types = evs.map((e) => e.type);
    const breach = evs.find((e) => e.type === 'cap.breached')!;
    expect(breach.payload).toMatchObject({ kind: 'run-duration', limit: 60 });
    expect((breach.payload as { observed: number }).observed).toBeGreaterThan(60);
    expect(types.indexOf('cap.breached')).toBeLessThan(types.indexOf('run.failed'));
    expect((await fresh(run.runId)).error?.code).toMatch(/run_timeout$/);
    expect(a.calls()).toBe(1);
    expect(types).not.toContain('eval.scored');
  });
});

/* ── WF-EV-2 ──────────────────────────────────────────────────────────────── */

describe('WF-EV-2 — cancel stops the in-flight trial', () => {
  it('after cancel no further tool or model call starts, and no trial is recorded', async () => {
    const suite = suiteOf('cancel', [GOLDEN('t', { fixtures: { toolResponses: [{ tool: 'email:send', response: { sent: true } }], onMiss: 'fail' } }), GOLDEN('u')]);
    const run = await evalRun(suite);
    const after: string[] = [];
    const a = agent(async (deps) => {
      const exec = (c: Parameters<ExecuteAgentTool>[0]) => deps.executeTool!(c);
      await exec({ name: 'email:send', input: {} });
      expect(await cancelRunAndCascade(storage, await fresh(run.runId), 'user cancelled')).toBe('cancelled');
      // Refused BY THE RUN'S ABORT (its reason), not by some unrelated failure.
      await exec({ name: 'email:send', input: {} }).catch((e: Error) => after.push(`tool: ${e.message}`));
      await deps.callAIWithTools!({ provider: 'mock', model: 'mock', messages: [{ role: 'user', content: 'x' }], tools: [] }).catch((e: Error) => after.push(`model: ${e.message}`));
      return 'ok';
    });
    expect(await runAgentEval({ storage, run, suite, dispatch: a.dispatch })).toBeNull();
    expect(after).toEqual(['tool: run reached terminal', 'model: run reached terminal']);
    expect(a.calls()).toBe(1);
    const r = await fresh(run.runId);
    expect(r.status).toBe('cancelled');
    expect(metaOf(r).progress ?? {}).toEqual({});
    expect(await count(run.runId, 'eval.scored')).toBe(0);
    expect(await count(run.runId, 'eval.completed')).toBe(0);
  });
});

/* ── WF-EV-4 ──────────────────────────────────────────────────────────────── */

describe('WF-EV-4 — resume decides from the log, so each lifecycle event appears exactly once', () => {
  it('window A: run.started logged but the row still pending', async () => {
    const suite = suiteOf('wina', [GOLDEN('t')]);
    const run = await evalRun(suite);
    await owned(run);
    await getEventLog().append({ runId: run.runId, type: 'run.started', payload: { workflowId: run.workflowId } });
    await runAgentEval({ storage, run, suite, dispatch: agent().dispatch }, { resume: true });
    expect(await count(run.runId, 'run.started')).toBe(1);
    expect(await count(run.runId, 'eval.started')).toBe(1);
    expect((await fresh(run.runId)).status).toBe('completed');
  });

  it('window B: the row is running but eval.started never landed', async () => {
    const suite = suiteOf('winb', [GOLDEN('t')]);
    const run = await evalRun(suite, {}, { status: 'running' });
    await owned(run);
    await getEventLog().append({ runId: run.runId, type: 'run.started', payload: { workflowId: run.workflowId } });
    await runAgentEval({ storage, run, suite, dispatch: agent().dispatch }, { resume: true });
    expect(await count(run.runId, 'eval.started')).toBe(1);
    expect(await count(run.runId, 'run.started')).toBe(1);
  });

  it('window C: eval.completed logged before the crash is not emitted twice', async () => {
    const suite = suiteOf('winc', [GOLDEN('t')]);
    const run = await evalRun(suite, { progress: { t: { '0': REC() } } }, { status: 'running' });
    await owned(run);
    for (const type of ['run.started', 'eval.started']) await getEventLog().append({ runId: run.runId, type, payload: {} });
    await getEventLog().append({ runId: run.runId, type: 'eval.scored', payload: { taskId: 't', score: 1, passed: true } });
    await getEventLog().append({ runId: run.runId, type: 'eval.completed', payload: { aggregateScore: 1, passed: true, taskCount: 1, passedCount: 1 } });
    const a = agent();
    await runAgentEval({ storage, run, suite, dispatch: a.dispatch }, { resume: true });
    expect(await count(run.runId, 'eval.completed')).toBe(1);
    expect(await count(run.runId, 'eval.scored')).toBe(1);
    expect(await count(run.runId, 'run.completed')).toBe(1);
    expect(a.calls()).toBe(0);
  });
});

/* ── WF-EV-7 / M9 ─────────────────────────────────────────────────────────── */

describe('WF-EV-7 / M9 — progress writes are fenced on the lease', () => {
  it('M9: with the lease OWNED, a recorded trial is skipped and only the missing one runs', async () => {
    const suite = suiteOf('m9', [GOLDEN('t'), GOLDEN('u')]);
    const run = await evalRun(suite, { progress: { t: { '0': REC() } } }, { status: 'running' });
    await owned(run);
    const a = agent();
    const summary = await runAgentEval({ storage, run, suite, dispatch: a.dispatch }, { resume: true });
    expect(a.calls()).toBe(1);
    expect(summary?.passedCount).toBe(2);
  });

  it('another instance owns the run: nothing is dispatched, written or terminated', async () => {
    const suite = suiteOf('fenced', [GOLDEN('t')]);
    const run = await evalRun(suite, {}, { status: 'running' });
    await owned(run, 'some-other-instance');
    const a = agent();
    expect(await runAgentEval({ storage, run, suite, dispatch: a.dispatch }, { resume: true })).toBeNull();
    expect(a.calls()).toBe(0);
    const r = await fresh(run.runId);
    expect(r.status).toBe('running');
    expect(metaOf(r).progress).toBeUndefined();
    expect(await count(run.runId, 'run.failed')).toBe(0);
  });

  it('the lease lost DURING a trial: the finished trial is not written, the run is not terminated', async () => {
    const suite = suiteOf('midlease', [GOLDEN('t')]);
    const run = await evalRun(suite, {}, { status: 'running' });
    await owned(run);
    const a = agent(async () => { await owned(run, 'the-resumer'); return 'ok'; });
    expect(await runAgentEval({ storage, run, suite, dispatch: a.dispatch }, { resume: true })).toBeNull();
    expect(a.calls()).toBe(1);
    const r = await fresh(run.runId);
    expect(metaOf(r).progress).toBeUndefined();
    expect(r.status).toBe('running');
    expect(await count(run.runId, 'eval.scored')).toBe(0);
  });

  it('a progress write merges with what another writer recorded; it never drops a trial', async () => {
    const suite = suiteOf('merge', [GOLDEN('t'), GOLDEN('u')]);
    const run = await evalRun(suite, {}, { status: 'running' });
    await owned(run);
    const a = agent(async () => {
      // A concurrent writer records `u` while this instance runs `t`.
      await storage.mergeRunMetadata(run.runId, { eval: { ...metaOf(await fresh(run.runId)), progress: { u: { '0': REC({ detail: 'recorded elsewhere' }) } } } });
      return 'ok';
    });
    await runAgentEval({ storage, run, suite, dispatch: a.dispatch }, { resume: true });
    const p = metaOf(await fresh(run.runId)).progress!;
    expect(p.u?.['0']?.detail).toBe('recorded elsewhere');
    expect(p.t?.['0']).toBeTruthy();
    expect(a.calls()).toBe(1);
  });
});

/* ── B2 / WF-EV-3 ─────────────────────────────────────────────────────────── */

describe('B2 / WF-EV-3 — the sweeper resumes an orphaned eval run in the eval runner', () => {
  const twoHoursAgo = () => new Date(Date.now() - 2 * 3_600_000).toISOString();

  async function orphan(name: string, lastProgressAt: string): Promise<RunRecord> {
    const suite = suiteOf(name, [GOLDEN('t'), GOLDEN('u')]);
    await putEvalSuite(TENANT, suite, 'user:owner');
    const run = await evalRun(suite, {
      progress: { t: { '0': REC() } },
      lastProgressAt,
      mock: { rounds: { t: [{ content: 'ok' }], u: [{ content: 'ok' }] } },
    }, { status: 'running', createdAt: twoHoursAgo() });
    await storage.setRunDispatchLease(run.runId, 'crashed-instance', Date.now() - 1_000);
    return run;
  }

  async function settle(runId: string): Promise<RunRecord> {
    for (let i = 0; i < 200; i += 1) {
      const r = await fresh(runId);
      if (['completed', 'failed', 'cancelled'].includes(r.status)) return r;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`run ${runId} never settled`);
  }

  it('a run that recorded a trial recently resumes (not abandoned), runs only the missing trial', async () => {
    const run = await orphan('sweep', new Date().toISOString());
    await sweepOrphanedRuns({ storage, hostSuite: createHostAdapterSuite({ storage }) }, getInstanceId(), Date.now());
    const r = await settle(run.runId);
    expect(r.status).toBe('completed');
    expect(await count(run.runId, 'agent.invocation.started')).toBe(1);
    expect(await count(run.runId, 'eval.scored')).toBe(2);
  });

  it('a crash loop with no recorded progress for an hour is abandoned by the same ceiling', async () => {
    const run = await orphan('sweepstale', twoHoursAgo());
    await sweepOrphanedRuns({ storage, hostSuite: createHostAdapterSuite({ storage }) }, getInstanceId(), Date.now());
    const r = await settle(run.runId);
    expect(r.error?.code).toMatch(/dispatch_abandoned$/);
    expect(await count(run.runId, 'agent.invocation.started')).toBe(0);
  });
});

/* ── M12 ──────────────────────────────────────────────────────────────────── */

describe('M12 — resume refuses honestly', () => {
  /** Every task is scripted, so a resume that should have refused reaches the mock only. */
  const SCRIPTED = { rounds: { t: [{ content: 'ok' }] } };
  it('toggle off ⇒ eval_feature_disabled, nothing dispatched', async () => {
    const suite = suiteOf('m12off', [GOLDEN('t')]);
    await putEvalSuite(TENANT, suite, 'user:owner');
    const run = await evalRun(suite, { mock: SCRIPTED }, { status: 'running' });
    const d = getToggleDefault('evals')!;
    await saveConfig({ ...d, status: 'off' }, 'test');
    try { await resumeAgentEvalRun(storage, run); } finally { await saveConfig(d, 'test'); }
    expect((await fresh(run.runId)).error?.code).toMatch(/eval_feature_disabled$/);
    expect(await count(run.runId, 'agent.invocation.started')).toBe(0);
  });

  it('a suite whose content changed since the run started ⇒ eval_suite_unavailable', async () => {
    const suite = suiteOf('m12digest', [GOLDEN('t')]);
    await putEvalSuite(TENANT, suite, 'user:owner');
    const run = await evalRun(suite, { mock: SCRIPTED, suiteDigest: suiteDigest(suiteOf('m12digest', [GOLDEN('t'), GOLDEN('u')])) }, { status: 'running' });
    await resumeAgentEvalRun(storage, run);
    expect((await fresh(run.runId)).error?.code).toMatch(/eval_suite_unavailable$/);
    expect(await count(run.runId, 'agent.invocation.started')).toBe(0);
  });

  it('a deleted suite ⇒ eval_suite_unavailable', async () => {
    const suite = suiteOf('m12gone', [GOLDEN('t')]);
    const run = await evalRun(suite, {}, { status: 'running' });
    await resumeAgentEvalRun(storage, run);
    expect((await fresh(run.runId)).error?.code).toMatch(/eval_suite_unavailable$/);
  });
});

/* ── EVAL-5 / EVD-8 / M8 ──────────────────────────────────────────────────── */

const RUBRIC = (taskId: string, criteria: string[]) => ({ taskId, input: { q: taskId }, expected: { kind: 'rubric', rubric: criteria.map((criterion) => ({ criterion, weight: 1 })) } });

function stubJudge(identity?: { provider: string; model?: string }): { judge: TypedEvalJudge; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    judge: (async () => { calls += 1; return { pass: true, detail: 'judge: ok', ...(identity ? { judge: identity } : {}) }; }) as TypedEvalJudge,
  };
}

describe('EVAL-5 — the ceiling holds inside a trial', () => {
  it('a judge call that could cross the ceiling is refused, and the run fails typed', async () => {
    const suite = suiteOf('ceiling', [GOLDEN('t'), RUBRIC('u', ['a', 'b'])]);
    const run = await evalRun(suite, { progress: { t: { '0': REC({ costUsd: 4.999 }) } } }, { status: 'running' });
    await owned(run);
    const j = stubJudge();
    expect(await runAgentEval({ storage, run, suite, judge: j.judge, dispatch: agent().dispatch }, { resume: true })).toBeNull();
    expect(j.calls()).toBe(0);
    expect((await fresh(run.runId)).error?.code).toMatch(/eval_cost_ceiling_exceeded$/);
  });
});

describe('EVD-8 / M8 — judge spend is run spend', () => {
  it('run.metadata.costUsd includes the metered judge, and maxCostUsd can fail the suite', async () => {
    const suite = suiteOf('judgecost', [RUBRIC('t', ['a'])], { thresholds: { passScore: 1, maxCostUsd: 0.000001 } });
    const run = await evalRun(suite);
    const j = stubJudge();
    const summary = await runAgentEval({ storage, run, suite, judge: j.judge, dispatch: agent().dispatch });
    expect(j.calls()).toBe(1);
    expect(summary!.totalCostUsd).toBeGreaterThan(0);
    expect(summary!.aggregateScore).toBe(1);
    expect(summary!.passed).toBe(false);
    expect((await fresh(run.runId)).metadata?.costUsd).toBeCloseTo(summary!.totalCostUsd!, 6);
  });
});

/* ── EVD-3 / AEV-2 / AEV-4 ────────────────────────────────────────────────── */

describe('EVD-3 / AEV-2 / AEV-4 — a regression that cannot be compared says so', () => {
  it('a baseline with no summary ⇒ inconclusive over 0 pairs, reason baseline_unavailable', async () => {
    const suite = suiteOf('regnone', [GOLDEN('t')]);
    const baseline = await evalRun(suite, {}, { status: 'failed' });
    const run = await evalRun(suite, { baselineRunId: baseline.runId });
    const summary = await runAgentEval({ storage, run, suite, dispatch: agent().dispatch });
    expect(summary?.regression).toMatchObject({ baselineRunId: baseline.runId, verdict: 'inconclusive', pairedTaskCount: 0, scoreDelta: 0 });
    expect(metaOf(await fresh(run.runId)).regressionReason).toBe('baseline_unavailable');
  });

  it('the summary stamps the agent model class; a baseline of another class is inconclusive', async () => {
    const suite = suiteOf('regclass', [GOLDEN('t'), GOLDEN('u')]);
    const baseline = await evalRun(suite, {}, { status: 'completed' });
    await storage.mergeRunMetadata(baseline.runId, { evalSummary: { suiteId: suite.suiteId, suiteVersion: '1.0.0', evaluatedModelClass: 'writing', aggregateScore: 0, passed: false, taskCount: 2, passedCount: 0, tasks: [{ taskId: 't', score: 0, passed: false }, { taskId: 'u', score: 0, passed: false }] } });
    const run = await evalRun(suite, { baselineRunId: baseline.runId });
    const summary = await runAgentEval({ storage, run, suite, dispatch: agent().dispatch });
    expect(summary?.evaluatedModelClass).toBe('research');
    expect(summary?.regression?.verdict).toBe('inconclusive');
    expect(summary?.regression?.scoreDelta).toBe(1);
    expect(metaOf(await fresh(run.runId)).regressionReason).toBe('model_class_mismatch');
  });

  it('a baseline judged by another model is inconclusive (judge_mismatch); the judge is recorded per trial', async () => {
    const suite = suiteOf('regjudge', [RUBRIC('t', ['a']), RUBRIC('u', ['a']), RUBRIC('v', ['a']), RUBRIC('w', ['a']), RUBRIC('x', ['a']), RUBRIC('y', ['a'])]);
    const lowTrials = Object.fromEntries(['t', 'u', 'v', 'w', 'x', 'y'].map((id) => [id, { '0': REC({ score: 0, passed: false, judge: { provider: 'anthropic', model: 'old' } }) }]));
    const baseline = await evalRun(suite, { progress: lowTrials }, { status: 'completed' });
    await storage.mergeRunMetadata(baseline.runId, { evalSummary: { suiteId: suite.suiteId, suiteVersion: '1.0.0', evaluatedModelClass: 'research', aggregateScore: 0, passed: false, taskCount: 6, passedCount: 0, tasks: ['t', 'u', 'v', 'w', 'x', 'y'].map((taskId) => ({ taskId, score: 0, passed: false })) } });
    const run = await evalRun(suite, { baselineRunId: baseline.runId });
    const j = stubJudge({ provider: 'openai', model: 'new' });
    const summary = await runAgentEval({ storage, run, suite, judge: j.judge, dispatch: agent().dispatch });
    expect(summary?.regression?.verdict).toBe('inconclusive');
    expect(metaOf(await fresh(run.runId)).regressionReason).toBe('judge_mismatch');
    expect(metaOf(await fresh(run.runId)).progress?.t?.['0']?.judge).toEqual({ provider: 'openai', model: 'new' });
  });
});

/* ── AEV-15 / B3 / m7 ─────────────────────────────────────────────────────── */

describe('AEV-15 — a scripted run never falls through to a real model', () => {
  it('a mock run with an unscripted task fails typed before any dispatch', async () => {
    const suite = suiteOf('mockgap', [GOLDEN('t'), GOLDEN('u')]);
    const run = await evalRun(suite, { mock: { rounds: { t: [{ content: 'ok' }] } } });
    const a = agent();
    await runAgentEval({ storage, run, suite, dispatch: a.dispatch });
    expect(a.calls()).toBe(0);
    expect((await fresh(run.runId)).error?.code).toMatch(/eval_mock_unscripted$/);
  });
});

describe('B3 — an eval trial never writes the agent\'s real memory', () => {
  it('a write through the lane lands in the ephemeral store, not the durable one', async () => {
    const suite = suiteOf('memory', [GOLDEN('t', { fixtures: { memorySeed: [{ content: 'seeded fact' }] } })]);
    const run = await evalRun(suite);
    let seen: string[] = [];
    const a = agent(async (deps) => {
      const mem = deps.memory!;
      await mem.write(deps.memoryScope!, { content: 'written during the trial' });
      seen = (await mem.read(deps.memoryScope!)).map((r) => r.content);
      return 'ok';
    });
    await runAgentEval({ storage, run, suite, dispatch: a.dispatch });
    expect(seen).toEqual(['seeded fact', 'written during the trial']);
    const real = await createAgentMemoryPort(TENANT).read(agentMemoryScope(AGENT));
    expect(real.map((r) => r.content)).not.toContain('written during the trial');
  });
});

describe('m7 — eval.* event payloads carry no content', () => {
  it('no task output, criterion text or input appears on an eval.* event', async () => {
    const suite = suiteOf('contentfree', [RUBRIC('t', ['MUST-NOT-LEAK-CRITERION'])]);
    const run = await evalRun(suite);
    await runAgentEval({ storage, run, suite, judge: stubJudge().judge, dispatch: agent(async () => 'MUST-NOT-LEAK-OUTPUT').dispatch });
    const evalEvents = (await events(run.runId)).filter((e) => e.type.startsWith('eval.'));
    expect(evalEvents.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(evalEvents)).not.toMatch(/MUST-NOT-LEAK|judge: ok/);
  });
});

/* ── M5 ───────────────────────────────────────────────────────────────────── */

describe('M5 — an eval run cannot be paused or resumed', () => {
  it.each(['pause', 'resume'])(':%s answers 409 with a typed reason and leaves the run alone', async (verb) => {
    const suite = suiteOf(`m5${verb}`, [GOLDEN('t')]);
    const run = await evalRun(suite, {}, { status: 'running' });
    const res = await fetch(`${base}/runs/${encodeURIComponent(`${TENANT}/${run.runId}`)}:${verb}`, { method: 'POST', headers: V2, body: '{}' });
    const body = await res.json() as { error?: { details?: { reason?: string } }; details?: { reason?: string } };
    expect(res.status).toBe(409);
    expect(body.error?.details?.reason ?? body.details?.reason).toBe('eval_run_not_forkable');
    expect((await fresh(run.runId)).status).toBe('running');
  });
});

/* ── m8 ───────────────────────────────────────────────────────────────────── */

describe('m8 — a captured tool result is size-capped', () => {
  it('a 40 000-char result is stored at MAX_RESULT_CHARS', async () => {
    await setCaptureSetting(TENANT, AGENT, true);
    const big = 'y'.repeat(40_000);
    const bigResult: ExecuteAgentTool = async () => ({ content: big });
    const exec = await maybeCaptureExecuteTool(bigResult, { tenantId: TENANT, runId: 'r-m8', agentId: AGENT });
    expect((await exec({ name: 'kb:read', input: {} })).content).toHaveLength(40_000);
    const rows = await listRunBoundary(TENANT, 'r-m8');
    expect(MAX_RESULT_CHARS).toBe(16_000);
    expect(rows[0]!.result).toHaveLength(MAX_RESULT_CHARS);
  });
});

/* ── ADR 0482 — eval spend is tenant spend ────────────────────────────────── */

describe('ADR 0482 — eval spend reaches the spend-day counter', () => {
  it('a completed eval run folds its whole recorded spend (judge included) exactly once', async () => {
    // A REAL priced model round (the scripted mock reporting a catalog model) so the
    // event stamp writes a figure first, and the judge share is raised on top of it.
    const suite = suiteOf('foldok', [RUBRIC('t', ['a', 'b'])]);
    const run = await evalRun(suite, { model: { model: 'claude-opus-5-5' }, mock: { rounds: { t: [{ content: 'ok', inputTokens: 100, outputTokens: 1000 }] } } });
    const summary = await runAgentEval({ storage, run, suite, judge: stubJudge().judge });
    const trial = metaOf(await fresh(run.runId)).progress!.t!['0']!;
    expect(trial.costUsd - (trial.judgeCostUsd ?? 0)).toBeGreaterThan(0);
    expect(trial.judgeCostUsd).toBeGreaterThan(0);
    expect((await fresh(run.runId)).metadata?.costUsd).toBeCloseTo(summary!.totalCostUsd!, 6);
    expect(await getTodaySpendUsd(TENANT, run.workflowId)).toBeCloseTo(summary!.totalCostUsd!, 6);
  });

  it('a failed eval run folds the judge spend of the trials it recorded', async () => {
    const suite = suiteOf('foldfail', [RUBRIC('t', ['a']), GOLDEN('u')]);
    const run = await evalRun(suite);
    let n = 0;
    const dispatch: Dispatch = async () => {
      n += 1;
      if (n > 1) throw new Error('provider exploded');
      return answer('ok');
    };
    expect(await runAgentEval({ storage, run, suite, judge: stubJudge().judge, dispatch })).toBeNull();
    const r = await fresh(run.runId);
    expect(r.error?.code).toMatch(/eval_run_failed$/);
    const judgeUsd = metaOf(r).progress!.t!['0']!.judgeCostUsd!;
    expect(judgeUsd).toBeGreaterThan(0);
    expect(r.metadata?.costUsd).toBeCloseTo(judgeUsd, 6);
    expect(await getTodaySpendUsd(TENANT, run.workflowId)).toBeCloseTo(judgeUsd, 6);
  });

  it('a tenant at its managed daily cap gets a typed failed eval run, never a silent success', async () => {
    // REL-1 (2026-10-19): the tenant-wide daily bound on eval spend is the managed
    // ladder (the spend-day counter is per workflow, and the eval lane is exempt from
    // its hard cap by ADR 0482 §5). A capped dispatch must end the run failed + typed.
    const suite = suiteOf('capped', [RUBRIC('t', ['a'])]);
    const run = await evalRun(suite);
    const dispatch: Dispatch = async () => {
      throw new ManagedProviderError('daily_limit_reached', 'Daily free-tier limit reached.');
    };
    expect(await runAgentEval({ storage, run, suite, judge: stubJudge().judge, dispatch })).toBeNull();
    const r = await fresh(run.runId);
    expect(r.status).toBe('failed');
    expect(r.error?.code).toMatch(/eval_run_failed$/);
    expect(r.error?.message).toContain('Daily free-tier limit reached');
    expect(r.metadata?.evalSummary).toBeUndefined();
  });
});

/* ── RFC 0244 §D — fail-closed score ─────────────────────────────────────── */

describe('RFC 0244 §D — a fail-closed trial scores 0', () => {
  it('a fixture miss zeroes the trial and task score even when the output matched', async () => {
    const suite = suiteOf('failclosed', [GOLDEN('t', { fixtures: { toolResponses: [], onMiss: 'fail' } })]);
    const run = await evalRun(suite);
    const a = agent(async (deps) => { await tool(deps, 'crm:lookup'); return 'ok'; });
    const summary = await runAgentEval({ storage, run, suite, dispatch: a.dispatch });
    expect(metaOf(await fresh(run.runId)).progress?.t?.['0']).toMatchObject({ score: 0, passed: false, scoreLabel: 'fixture_miss' });
    expect(summary).toMatchObject({ aggregateScore: 0, passed: false });
  });
});
