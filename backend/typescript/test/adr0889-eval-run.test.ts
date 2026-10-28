/**
 * ADR 0889 P4 — the agent eval run, end to end through HTTP (RFC 0081 §B/§C +
 * RFC 0244). A real app, a real `POST /runs {mode:"eval"}`, the real live-dispatch
 * lane driven by the scripted `tool-calls` mock (no provider key), a real event
 * log and the normative `GET /runs/{id}/eval-summary`.
 *
 * Tracker TST-BHG-3. Red when (sabotage-witnessed, wave 62): the fork route stops
 * refusing an eval run; a locked suite version can be overwritten; an unadvertised
 * `trials.count` is accepted; a missing `evalSuiteRef` is accepted; or a fixture miss
 * on the live-dispatch lane (`agentEvalRun.ts`, the `failClosed` check) stops failing
 * the task. Each case seeds its own suite (no case depends on another's run).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { resetRfc0244WireCache } from '../src/host/evals/evalCapability.js';

let server: Server; let base = '';
const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };
const V2 = { ...AUTH, 'OpenWOP-Version': '2' };
const AGENT = 'eval.test-agent';
const TOOL = 'openwop:schema.lookup';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  getAgentRegistry().register({
    agentId: AGENT, persona: 'Eval subject', modelClass: 'research', systemPrompt: 'Answer.',
    packName: 'test', packVersion: '0', toolAllowlist: [TOOL], confidence: { defaultThreshold: 0.1 },
  });
});
afterAll(async () => {
  resetRfc0244WireCache();
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => resetRfc0244WireCache());

interface Reply { status: number; json: Record<string, unknown>; text: string }
async function send(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Reply> {
  const res = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted below */ }
  return { status: res.status, json, text };
}

async function putSuite(suite: Record<string, unknown>): Promise<void> {
  const r = await send('PUT', `/host/openwop-app/agent-evals/suites/${suite.suiteId}@${suite.version}`, V2, suite);
  expect(r.status, r.text.slice(0, 300)).toBe(200);
}

async function waitTerminal(runId: string): Promise<string> {
  return vi.waitFor(async () => {
    const r = await send('GET', `/runs/${runId}`, V2);
    const status = String((r.json as { status?: string }).status ?? '');
    expect(['completed', 'failed', 'cancelled']).toContain(status);
    return status;
  }, { timeout: 10_000, interval: 25 });
}

/** A one-task golden suite of this case's own, PUT fresh (no shared state across cases). */
async function goldenSuite(suiteId: string): Promise<string> {
  await putSuite({
    suiteId, version: '1.0.0', modes: ['golden'], thresholds: { passScore: 1 },
    tasks: [{
      taskId: 'lookup', input: { q: 'hi' },
      expected: { kind: 'golden', match: { strategy: 'contains', value: 'done' } },
      fixtures: { toolResponses: [{ tool: TOOL, response: { ok: true } }] },
    }],
  });
  return `${suiteId}@1.0.0`;
}

/** Run a golden suite to a terminal status; returns the run id. */
async function runGolden(ref: string): Promise<string> {
  const c = await send('POST', '/runs', V2, {
    mode: 'eval', evalSuiteRef: ref, agentId: AGENT,
    configurable: { mockProvider: { id: 'tool-calls', rounds: { lookup: rounds('all done', { kind: 'node' }) } } },
  });
  expect(c.status, c.text.slice(0, 300)).toBe(201);
  const runId = String(c.json['runId']);
  expect(await waitTerminal(runId)).toBe('completed');
  return runId;
}

async function events(runId: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  const r = await send('GET', `/runs/${runId}/events/poll?limit=500`, V2);
  return ((r.json as { events?: unknown[] }).events ?? []) as Array<{ type: string; payload: Record<string, unknown> }>;
}

const rounds = (output: string, args: Record<string, unknown>) => [
  { toolCalls: [{ name: TOOL, input: args }] },
  { content: output },
];

describe('ADR 0889 — mode:"eval" end to end', () => {
  it('advertises agents.evalSuite from the one builder', async () => {
    const doc = await send('GET', '/.well-known/openwop', {});
    const agents = (doc.json['capabilities'] as Record<string, unknown> | undefined)?.['agents'] as Record<string, unknown> | undefined;
    const evalSuite = (agents ?? (doc.json['agents'] as Record<string, unknown>))?.['evalSuite'] as Record<string, unknown>;
    expect(evalSuite).toBeTruthy();
    expect(evalSuite['modes']).toEqual(['golden', 'rubric', 'regression']);
  });

  it('a golden suite runs, emits the content-free bracket in order, and serves its summary', async () => {
    await putSuite({
      suiteId: 'test.acme.evals.golden', version: '1.0.0', modes: ['golden'], thresholds: { passScore: 1 },
      tasks: [{
        taskId: 'lookup', input: { q: 'hi' },
        expected: { kind: 'golden', match: { strategy: 'contains', value: 'done' } },
        fixtures: { toolResponses: [{ tool: TOOL, response: { ok: true } }] },
      }],
    });
    const c = await send('POST', '/runs', V2, {
      mode: 'eval', evalSuiteRef: 'test.acme.evals.golden@1.0.0', agentId: AGENT,
      configurable: { mockProvider: { id: 'tool-calls', rounds: { lookup: rounds('all done', { kind: 'node' }) } } },
    });
    expect(c.status, c.text.slice(0, 300)).toBe(201);
    const runId = String(c.json['runId']);
    expect(await waitTerminal(runId)).toBe('completed');

    const types = (await events(runId)).map((e) => e.type);
    const order = ['run.started', 'eval.started', 'agent.invocation.started', 'agent.invocation.completed', 'eval.scored', 'eval.completed', 'run.completed'];
    // v2 spells the last segment with a hyphen (`agent.invocation-started`); v1 with a dot.
    const v2Name = (t: string): string => { const i = t.lastIndexOf('.'); return `${t.slice(0, i)}-${t.slice(i + 1)}`; };
    const at = order.map((t) => types.findIndex((x) => x === t || x === v2Name(t)));
    for (const i of at) expect(i, types.join(',')).toBeGreaterThanOrEqual(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);

    const s = await send('GET', `/runs/${runId}/eval-summary`, V2);
    expect(s.status, s.text.slice(0, 300)).toBe(200);
    expect(s.json).toMatchObject({ suiteId: 'test.acme.evals.golden', passed: true, taskCount: 1, passedCount: 1 });
    // eval-summary-no-content-leak — no output, no tool names, no prose.
    expect(s.text).not.toMatch(/all done|schema\.lookup|"kind":"node"/);
  });

  it('refuses an RFC 0244 feature this host does not advertise, naming the field', async () => {
    resetRfc0244WireCache(false);
    await putSuite({
      suiteId: 'test.acme.evals.trials', version: '1.0.0', modes: ['golden'], trials: { count: 3 },
      tasks: [{ taskId: 't', input: {}, expected: { kind: 'golden', match: { strategy: 'contains', value: 'x' } } }],
    });
    const r = await send('POST', '/runs', V2, { mode: 'eval', evalSuiteRef: 'test.acme.evals.trials@1.0.0', agentId: AGENT });
    expect(r.status, r.text.slice(0, 300)).toBe(400);
    expect((r.json['details'] as Record<string, unknown>)['field']).toBe('trials.count');
  });

  it('with the RFC 0244 wire: trials, trajectory, fail-closed fixture miss', async () => {
    resetRfc0244WireCache(true);
    await putSuite({
      suiteId: 'test.acme.evals.traj', version: '1.0.0', modes: ['golden'], thresholds: { passScore: 1 },
      trials: { count: 3, k: 2, passRule: 'all' },
      tasks: [
        {
          taskId: 'served', input: {},
          expected: {
            kind: 'golden', match: { strategy: 'contains', value: 'done' },
            trajectory: { match: 'in-order', calls: [{ tool: TOOL, args: { kind: 'node' }, argsMatch: 'subset' }] },
          },
          fixtures: { onMiss: 'fail', toolResponses: [{ tool: TOOL, args: { kind: 'node' }, argsMatch: 'subset', response: { ok: 1 } }] },
        },
        {
          taskId: 'missed', input: {},
          expected: { kind: 'golden', match: { strategy: 'contains', value: 'done' } },
          fixtures: { onMiss: 'fail', toolResponses: [{ tool: TOOL, args: { kind: 'artifact-type' }, argsMatch: 'exact', response: {} }] },
        },
      ],
    });
    const c = await send('POST', '/runs', V2, {
      mode: 'eval', evalSuiteRef: 'test.acme.evals.traj@1.0.0', agentId: AGENT,
      configurable: { mockProvider: { id: 'tool-calls', rounds: {
        served: rounds('done', { kind: 'node' }),
        missed: rounds('done', { kind: 'node' }),
      } } },
    });
    expect(c.status, c.text.slice(0, 300)).toBe(201);
    const runId = String(c.json['runId']);
    expect(await waitTerminal(runId)).toBe('completed');

    const scored = (await events(runId)).filter((e) => e.type === 'eval.scored');
    expect(scored, JSON.stringify(scored[0])).toHaveLength(6);
    expect(scored.filter((e) => e.payload['taskId'] === 'served').map((e) => e.payload['trialIndex']), JSON.stringify(scored[0])).toEqual([0, 1, 2]);

    const s = (await send('GET', `/runs/${runId}/eval-summary`, V2)).json as Record<string, unknown>;
    const tasks = s['tasks'] as Array<Record<string, unknown>>;
    const served = tasks.find((t) => t['taskId'] === 'served')!;
    const missed = tasks.find((t) => t['taskId'] === 'missed')!;
    expect(served).toMatchObject({ passed: true, fixtureMissCount: 0, trials: { n: 3, passedCount: 3, passAtK: 1, passHatK: 1 } });
    expect(served['trajectory']).toMatchObject({ mode: 'in-order', matched: true, matchedCount: 1, forbiddenCount: 0 });
    expect(missed).toMatchObject({ passed: false, fixtureMissCount: 3 });
    expect(s['trialStats']).toMatchObject({ k: 2 });
    expect(s['passed']).toBe(false);
  });

  it('refuses missing fields, unknown suites and the scripted mock on a production posture', async () => {
    const ref = await goldenSuite('test.acme.evals.refusals');
    const noRef = await send('POST', '/runs', V2, { mode: 'eval', agentId: AGENT });
    expect(noRef.status).toBe(400);
    expect((noRef.json['details'] as Record<string, unknown>)['field']).toBe('evalSuiteRef');
    const unknown = await send('POST', '/runs', V2, { mode: 'eval', evalSuiteRef: 'test.acme.evals.nope@1.0.0', agentId: AGENT });
    expect(unknown.status).toBe(404);
    const noAgent = await send('POST', '/runs', V2, { mode: 'eval', evalSuiteRef: ref, agentId: 'not.an.agent' });
    expect(noAgent.status).toBe(404);
    // Production posture: the scripted mock is a test-host affordance only.
    const saved = process.env.OPENWOP_MOCK_PROVIDER_ENABLED;
    process.env.OPENWOP_MOCK_PROVIDER_ENABLED = 'false';
    try {
      const mocked = await send('POST', '/runs', V2, {
        mode: 'eval', evalSuiteRef: ref, agentId: AGENT,
        configurable: { mockProvider: { id: 'tool-calls', rounds: { lookup: rounds('all done', { kind: 'node' }) } } },
      });
      expect(mocked.status, mocked.text.slice(0, 300)).toBe(403);
      expect((mocked.json['details'] as Record<string, unknown>)['field']).toBe('configurable.mockProvider');
    } finally {
      if (saved === undefined) delete process.env.OPENWOP_MOCK_PROVIDER_ENABLED; else process.env.OPENWOP_MOCK_PROVIDER_ENABLED = saved;
    }
  });

  it('A2 — an eval run cannot be forked; A5 — a non-eval run has no eval-summary', async () => {
    const runId = await runGolden(await goldenSuite('test.acme.evals.fork'));
    const fork = await send('POST', `/runs/${runId}:fork`, V2, { mode: 'replay', fromSeq: 0 });
    expect(fork.status, fork.text.slice(0, 200)).toBe(409);
    expect((fork.json['details'] as Record<string, unknown>)['reason']).toBe('eval_run_not_forkable');

    const ordinary = await send('POST', '/runs', V2, { workflowId: 'conformance-noop', inputs: {} });
    expect(ordinary.status).toBe(201);
    const s = await send('GET', `/runs/${String(ordinary.json['runId'])}/eval-summary`, V2);
    expect(s.status).toBe(404);
  });

  it('a referenced suite version is immutable', async () => {
    // Positive control: before any run references it, the version can be re-PUT.
    const ref = await goldenSuite('test.acme.evals.locked');
    await goldenSuite('test.acme.evals.locked');
    await runGolden(ref);
    const r = await send('PUT', '/host/openwop-app/agent-evals/suites/test.acme.evals.locked@1.0.0', V2, {
      suiteId: 'test.acme.evals.locked', version: '1.0.0', modes: ['golden'],
      tasks: [{ taskId: 'lookup', input: {}, expected: { kind: 'golden', match: { strategy: 'exact', value: 'changed' } } }],
    });
    expect(r.status, r.text.slice(0, 300)).toBe(409);
    expect((r.json['details'] as Record<string, unknown>)['reason']).toBe('suite_locked');
  });
});
