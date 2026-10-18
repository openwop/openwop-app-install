/**
 * ADR 0889 WF-EV-11 — `feature.evals.nodes.run-suite` and the
 * `agents.eval-regression-gate` chain.
 *
 * Why this exists: the regression gate lived only in the CLI's exit code, so no
 * workflow in the app could act on a `regressed` verdict. These cases pin the two
 * properties that make the in-app gate honest:
 *   1. the node never reports a pass it did not read — a refused start, a failed
 *      eval run and a timed-out wait are typed failures, and a regression clears
 *      `ok` even when the suite passed;
 *   2. the spend stops with the workflow — a timeout or an abort cancels the
 *      child eval run.
 * Then the real chain, through the real executor and the real `ctx.features.evals`
 * surface, against the conformance scripted agent (deterministic, no model): a
 * passing suite ends at `cleared`; a failing one suspends at the review gate.
 * Sabotage-witnessed: with `ok: passed` (ignoring `regressed`) the regression case
 * goes red; with the timeout's `cancelQuietly` removed the timeout case goes red;
 * with `startSuiteRun` back on plain `createAgentEvalRun` the re-dispatch case goes
 * red (a second eval run, a second bill).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { getChain, expandChain, findUnfilledExpansionParams } from '../src/host/workflowChainPackLoader.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { SCRIPTED_AGENT_ID } from '../src/host/evals/fixtureSuites.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { bareRunId } from './support/bareRunId.js';
import { getSetCookies } from './headerCookies.js';
// The REAL node implementation, as the pack loader imports it.
import { runSuite } from '../../../packs/feature.evals.nodes/index.mjs';

type RunView = { runId: string; status: string; summary: Record<string, unknown> | null; error: { code: string; message: string } | null };

function fakeEvals(views: RunView[], opts: { startError?: Error } = {}) {
  const cancelled: string[] = [];
  let i = 0;
  return {
    cancelled,
    surface: {
      startSuiteRun: vi.fn(async () => { if (opts.startError) throw opts.startError; return { runId: 'ev-1', status: 'pending' }; }),
      getRun: vi.fn(async () => views[Math.min(i++, views.length - 1)]!),
      cancelRun: vi.fn(async ({ runId }: { runId: string }) => { cancelled.push(runId); return { runId, outcome: 'cancelled' }; }),
    },
  };
}
const ctxFor = (surface: unknown, inputs: Record<string, unknown> = {}, signal?: AbortSignal) =>
  ({ features: { evals: surface }, inputs: { suiteRef: 's@1', agentId: 'a', pollIntervalMs: 20, ...inputs }, config: {}, ...(signal ? { signal } : {}) });
const done = (summary: Record<string, unknown>): RunView => ({ runId: 'ev-1', status: 'completed', summary, error: null });
const running: RunView = { runId: 'ev-1', status: 'running', summary: null, error: null };

describe('run-suite node (fake surface)', () => {
  it('waits for the run and outputs the scorecard with ok = passed and not regressed', async () => {
    const f = fakeEvals([running, done({ passed: true, aggregateScore: 1, passedCount: 2, taskCount: 2 })]);
    const out = await runSuite(ctxFor(f.surface));
    expect(out).toEqual({ status: 'success', outputs: { evalRunId: 'ev-1', status: 'completed', passed: true, regressed: false, ok: true, aggregateScore: 1, passedCount: 2, taskCount: 2, verdict: null } });
    expect(f.surface.startSuiteRun).toHaveBeenCalledWith({ suiteRef: 's@1', agentId: 'a', baselineRunId: undefined });
  });

  it('a regression clears ok even when the suite passed', async () => {
    const f = fakeEvals([done({ passed: true, aggregateScore: 0.8, passedCount: 4, taskCount: 5, regression: { verdict: 'regressed', scoreDelta: -0.2 } })]);
    const out = await runSuite(ctxFor(f.surface, { baselineRunId: 'ev-0' }));
    expect(out.outputs).toMatchObject({ passed: true, regressed: true, ok: false, verdict: 'regressed' });
  });

  it('a refused start is a typed failure carrying the refusal reason', async () => {
    const refusal = Object.assign(new Error('Agent evals are not enabled for this workspace.'), { code: 'forbidden', details: { reason: 'feature_disabled' } });
    const f = fakeEvals([], { startError: refusal });
    expect(await runSuite(ctxFor(f.surface))).toMatchObject({ status: 'failed', error: { code: 'feature_disabled' } });
  });

  it('an eval run that ends failed is a failure, never a pass', async () => {
    const f = fakeEvals([{ runId: 'ev-1', status: 'failed', summary: null, error: { code: 'eval_cost_ceiling_exceeded', message: 'over budget' } }]);
    expect(await runSuite(ctxFor(f.surface))).toMatchObject({ status: 'failed', error: { code: 'eval_cost_ceiling_exceeded' } });
  });

  it('a wait that runs out cancels the eval run and fails typed', async () => {
    const f = fakeEvals([running]);
    const out = await runSuite(ctxFor(f.surface, { timeoutMs: 1000, pollIntervalMs: 200 }));
    expect(out).toMatchObject({ status: 'failed', error: { code: 'eval_wait_timeout' } });
    expect(f.cancelled).toEqual(['ev-1']);
  });

  it('an aborted workflow run cancels the eval run and rethrows the abort', async () => {
    const f = fakeEvals([running]);
    const ac = new AbortController();
    const p = runSuite(ctxFor(f.surface, { pollIntervalMs: 5000 }, ac.signal));
    await vi.waitFor(() => expect(f.surface.getRun).toHaveBeenCalled());
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.cancelled).toEqual(['ev-1']);
  });

  it('a host without the surface fails with host_capability_missing', async () => {
    await expect(runSuite({ features: {}, inputs: {} })).rejects.toMatchObject({ code: 'host_capability_missing' });
  });
});

/* ── the real chain, real executor, real surface ─────────────────────────── */

let server: Server; let base = '';
let cookie = '';
async function send(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'OpenWOP-Version': '2', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted by the caller */ }
  return { status: res.status, json, text };
}
const scriptedSuite = (suiteId: string, expectOutput: string) => ({
  suiteId, version: '1.0.0', targetAgentId: SCRIPTED_AGENT_ID, modes: ['golden'], thresholds: { passScore: 1 },
  tasks: [{ taskId: 't1', input: { script: [], output: 'all done' }, expected: { kind: 'golden', match: { strategy: 'contains', value: expectOutput } } }],
});

let tenantId = ''; let userId = '';

describe('agents.eval-regression-gate chain (real executor, ctx.features.evals)', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // A real signed-in owner: the node needs a person behind the run (workspace:write).
    tenantId = `org:evalgate-${Date.now()}`;
    const login = await send('POST', '/host/openwop-app/test/login', { email: `evalgate-${Date.now()}@acme.test`, tenantId });
    expect(login.status, login.text.slice(0, 200)).toBe(201);
    userId = String((login.json['user'] as { userId?: string } | undefined)?.userId ?? '');
  }, 120_000);
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  async function runGate(suiteId: string, expectOutput: string, extraInputs: Record<string, unknown> = {}): Promise<{ runId: string; status: string; events: Array<{ type: string; nodeId?: string; payload?: { outputs?: Record<string, unknown> } }> }> {
    const put = await send('PUT', `/host/openwop-app/agent-evals/suites/${suiteId}@1.0.0`, scriptedSuite(suiteId, expectOutput));
    expect(put.status, put.text.slice(0, 300)).toBe(200);
    const found = getChain('agents.eval-regression-gate');
    expect(found, 'the chain must be loaded at boot').toBeTruthy();
    const params = { suiteRef: `${suiteId}@1.0.0`, agentId: SCRIPTED_AGENT_ID };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);
    const created = await send('POST', '/runs', { workflowId: expanded.workflowId, inputs: { ...params, ...extraInputs } });
    expect(created.status, created.text.slice(0, 300)).toBe(201);
    const runId = String(created.json['runId']);
    const status = await vi.waitFor(async () => {
      const r = await send('GET', `/runs/${runId}`);
      expect(String(r.json['status'])).toMatch(/^(completed|failed|cancelled|waiting)/);
      return String(r.json['status']);
    }, { timeout: 15_000, interval: 50 });
    const debug = await send('GET', `/host/openwop-app/runs/${bareRunId(runId)}/debug-bundle`);
    return { runId, status, events: (debug.json['events'] ?? []) as never };
  }

  it('a param-less copy freezes no empty value: defaults name the shipped Agent Author suite (ADR 0504 ratchet)', () => {
    const found = getChain('agents.eval-regression-gate');
    const def = expandChain(found!.chain, {}) as unknown as WorkflowDefinition;
    expect(findUnfilledExpansionParams(def)).toEqual([]);
    const evalNode = def.nodes.find((n) => n.nodeId.endsWith('eval'));
    expect(evalNode?.inputs).toEqual({
      suiteRef: 'vendor.openwop-app.agent-author.evals.agent-author@1.0.0',
      agentId: 'vendor.openwop-app.agent-author.agents.agent-author',
    });
  });

  it('a baselineRunId run input reaches the eval node (an unknown baseline is a typed failure, never a pass)', async () => {
    const r = await runGate('test.evals.gate-baseline', 'all done', { baselineRunId: 'no-such-eval-run' });
    expect(r.status).toBe('failed');
    const failed = r.events.find((e) => e.type === 'node.failed' && (e.nodeId ?? '').endsWith('eval')) as { payload?: { error?: { code?: string; message?: string } } } | undefined;
    expect(failed?.payload?.error?.message ?? '', JSON.stringify(failed)).toMatch(/baseline/i);
  });

  it('a node re-dispatched in the same workflow run gets the SAME eval run back (createAgentEvalRunOnce, keyed run:node)', async () => {
    const put = await send('PUT', '/host/openwop-app/agent-evals/suites/test.evals.gate-once@1.0.0', scriptedSuite('test.evals.gate-once', 'all done'));
    expect(put.status, put.text.slice(0, 300)).toBe(200);
    expect(userId).not.toBe('');
    const features = (runId: string) => buildFeatureSurfaces({ tenantId, actingUserId: userId, runId });
    const ctx = (runId: string, nodeId: string) => ({ features: features(runId), runId, nodeId, config: {}, inputs: { suiteRef: 'test.evals.gate-once@1.0.0', agentId: SCRIPTED_AGENT_ID, pollIntervalMs: 20 } });
    const first = await runSuite(ctx('wf-once-1', 'eval'));
    const again = await runSuite(ctx('wf-once-1', 'eval'));
    expect(first.status, JSON.stringify(first)).toBe('success');
    expect(again.outputs?.['evalRunId']).toBe(first.outputs?.['evalRunId']);
    // Another node, or another workflow run, is a different execution: a new eval run.
    const otherNode = await runSuite(ctx('wf-once-1', 'eval-2'));
    const otherRun = await runSuite(ctx('wf-once-2', 'eval'));
    expect(new Set([first.outputs?.['evalRunId'], otherNode.outputs?.['evalRunId'], otherRun.outputs?.['evalRunId']]).size).toBe(3);
  });

  it('a passing suite ends at `cleared`', async () => {
    const r = await runGate('test.evals.gate-pass', 'all done');
    expect(r.status, JSON.stringify(r.events.filter((e) => e.type === 'node.failed'))).toBe('completed');
    const node = r.events.find((e) => e.type === 'node.completed' && (e.nodeId ?? '').endsWith('eval'));
    expect(node?.payload?.outputs).toMatchObject({ passed: true, ok: true });
    expect(r.events.some((e) => e.type === 'node.completed' && (e.nodeId ?? '').endsWith('cleared'))).toBe(true);
  });

  it('a failing suite suspends at the review gate', async () => {
    const r = await runGate('test.evals.gate-fail', 'something else');
    expect(r.status.startsWith('waiting'), `run should suspend at the review gate, was ${r.status}`).toBe(true);
    const node = r.events.find((e) => e.type === 'node.completed' && (e.nodeId ?? '').endsWith('eval'));
    expect(node?.payload?.outputs).toMatchObject({ passed: false, ok: false });
  });
});
