/**
 * ADR 0967 — the RFC 0248 fixture node on its own operator opt-in, with the two
 * fixes that make it safe on a production host.
 *
 * 1. The switch. `conformance.callai.echo-attempts` registers under the
 *    conformance posture OR `OPENWOP_CONFORMANCE_CALLAI_FIXTURE=true`, and the
 *    opt-in is ignored in the `auth` posture. Production's cut (165c) found the
 *    node withheld because it sat inside `registerConformanceNodes()`.
 * 2. Run-scoped scripts. The fixture's node id is `callai-echo` in every run, in
 *    every tenant; a script keyed by node id alone let two concurrent runs read
 *    each other's replies.
 * 3. Replay. A run-scoped script is the run's own input, not a divergence
 *    injection, so a replay fork reads the recorded invocation and sends no
 *    request to the mock.
 *
 * Sabotage: ignoring the auth posture reds the refusal case; dropping `runId`
 * from the lookup reds both keying cases; counting run-scoped programs as
 * divergence injections reds the replay case.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import {
  CALLAI_ECHO_ATTEMPTS_TYPE_ID, callAiFixtureEnabled, registerCallAiFixtureNode, resetCallAiFixtureRegistrationForTests,
} from '../src/bootstrap/conformanceCallAiFixture.js';
import { dispatchMock, programMockForRun, receivedMaxTokens, RUN_SCOPED_PROGRAM_CAP, hasPendingDivergenceProgram, hasPendingMockProgram, programMock, resetMockPrograms } from '../src/providers/dispatchMock.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { bareRunId } from './support/bareRunId.js';

const ENV_KEYS = ['OPENWOP_CONFORMANCE_CALLAI_FIXTURE', 'OPENWOP_ENABLE_CONFORMANCE_NODES', 'OPENWOP_DEPLOY_POSTURE', 'NODE_ENV'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const k of ENV_KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
}
const restoreEnv = (): void => setEnv(saved as Partial<Record<(typeof ENV_KEYS)[number], string>>);

describe('ADR 0967 — the switch', () => {
  afterEach(restoreEnv);

  it('production without the opt-in leaves the node off', () => {
    setEnv({ NODE_ENV: 'production', OPENWOP_DEPLOY_POSTURE: 'cookie-per-visitor' });
    expect(callAiFixtureEnabled()).toBe(false);
  });

  it('the opt-in turns it on in production, without the conformance posture', () => {
    setEnv({ NODE_ENV: 'production', OPENWOP_DEPLOY_POSTURE: 'cookie-per-visitor', OPENWOP_CONFORMANCE_CALLAI_FIXTURE: 'true' });
    expect(callAiFixtureEnabled()).toBe(true);
  });

  it('the auth posture refuses the opt-in, and the node is not registered', () => {
    setEnv({ NODE_ENV: 'production', OPENWOP_DEPLOY_POSTURE: 'auth', OPENWOP_CONFORMANCE_CALLAI_FIXTURE: 'true' });
    expect(callAiFixtureEnabled()).toBe(false);
    resetCallAiFixtureRegistrationForTests();
    registerCallAiFixtureNode();
    expect(getNodeRegistry().isResolvable(CALLAI_ECHO_ATTEMPTS_TYPE_ID)).toBe(false);
  });
});

describe('ADR 0967 — a fixture script is scoped to its run', () => {
  afterEach(() => resetMockPrograms());

  it('two runs scripting the same node id each read their own script', async () => {
    programMockForRun('run-a', 'callai-echo', [{ content: 'A', stopReason: 'end_turn', outputTokens: 11 }]);
    programMockForRun('run-b', 'callai-echo', [{ content: 'B', stopReason: 'end_turn', outputTokens: 22 }]);
    const req = { provider: 'mock' as const, apiKey: '', model: 'mock-mini', messages: [{ role: 'user' as const, content: 'x' }] };
    const a = await dispatchMock({ ...req, nodeId: 'callai-echo', runId: 'run-a' });
    const b = await dispatchMock({ ...req, nodeId: 'callai-echo', runId: 'run-b' });
    expect([a.completion, a.usage?.outputTokens]).toEqual(['A', 11]);
    expect([b.completion, b.usage?.outputTokens]).toEqual(['B', 22]);
  });

  it('a run-scoped script is not a divergence injection; a node-keyed one still is', () => {
    programMockForRun('run-a', 'n1', [{ content: 'A' }]);
    expect(hasPendingDivergenceProgram('n1', 'run-a')).toBe(false);
    programMock('n2', [{ content: 'staged' }]);
    expect(hasPendingDivergenceProgram('n2', 'run-a')).toBe(true);
  });

  it('the run-scoped store is bounded on a long-lived host', () => {
    for (let i = 0; i < RUN_SCOPED_PROGRAM_CAP + 10; i++) programMockForRun(`run-${i}`, 'callai-echo', [{ content: 'x' }]);
    // The ten oldest are gone; the newest CAP are still pending.
    expect(hasPendingMockProgram('callai-echo', 'run-9')).toBe(false);
    expect(hasPendingMockProgram('callai-echo', 'run-10')).toBe(true);
    expect(hasPendingMockProgram('callai-echo', `run-${RUN_SCOPED_PROGRAM_CAP + 9}`)).toBe(true);
  });
});

describe('ADR 0967 — through the real executor', () => {
  let server: http.Server;
  let BASE = '';
  const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };
  const SCHEMA = { type: 'object', required: ['line'], properties: { line: { type: 'string' } } };
  type Json = Record<string, unknown>;
  type Ev = { type: string; nodeId?: string; payload?: Json };

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    resetCallAiFixtureRegistrationForTests();
    const { createApp } = await import('../src/index.js');
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  }, 120_000);
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  async function api<T = Json>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  }
  async function waitTerminal(runId: string): Promise<string> {
    let status = '';
    for (let i = 0; i < 300; i++) {
      status = (await api<{ status: string }>(`/runs/${runId}`)).body.status;
      if (['completed', 'failed', 'cancelled'].includes(status)) return status;
      await new Promise((r) => setTimeout(r, 20));
    }
    return status;
  }
  const attemptsOf = async (runId: string): Promise<Json | undefined> => {
    const evs = (await api<{ events: Ev[] }>(`/runs/${runId}/events/poll?fromSeq=-1&limit=1000`)).body.events ?? [];
    return (evs.find((e) => e.type === 'node.completed' && e.nodeId === 'callai-echo')?.payload?.['outputs'] as { attempts?: Json } | undefined)?.attempts;
  };
  const start = (script: Json[]) => api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({
    workflowId: 'conformance-callai-attempt-accounting',
    inputs: { request: { prompt: 'conformance', responseSchema: SCHEMA, maxTokens: 256 }, script },
  }) });

  it('with conformance nodes OFF (the production gate) the fixture is still advertised once its node resolves', async () => {
    // The second gate the m2 lane found: `fixtureNeedsConformanceNodes` read
    // every `conformance.*` id as needing the conformance posture, so the opt-in
    // registered the node and the fixture stayed withheld.
    const prev = process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
    process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'false';
    try {
      const { listLoadedConformanceFixtures } = await import('../src/host/index.js');
      expect(getNodeRegistry().isResolvable(CALLAI_ECHO_ATTEMPTS_TYPE_ID)).toBe(true);
      expect(listLoadedConformanceFixtures()).toContain('conformance-callai-attempt-accounting');
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
      else process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = prev;
    }
  });

  it('two concurrent runs of the fixture each count their own script', async () => {
    const [one, two] = await Promise.all([
      start([{ kind: 'valid', outputTokens: 5 }]),
      start([{ kind: 'invalid-json', outputTokens: 10 }, { kind: 'invalid-json', outputTokens: 10 }, { kind: 'valid', outputTokens: 20 }]),
    ]);
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    expect(two.status, JSON.stringify(two.body)).toBe(201);
    expect(await waitTerminal(one.body.runId)).toBe('completed');
    expect(await waitTerminal(two.body.runId)).toBe('completed');
    expect(await attemptsOf(one.body.runId)).toMatchObject({ count: 1, outputTokens: 5 });
    expect(await attemptsOf(two.body.runId)).toMatchObject({ count: 3, outputTokens: 40 });
  });

  it('a replay fork reads the recorded invocation: no request reaches the mock, same attempts', async () => {
    const src = await start([{ kind: 'invalid-json', outputTokens: 10 }, { kind: 'valid', outputTokens: 20 }]);
    expect(await waitTerminal(src.body.runId)).toBe('completed');
    expect(receivedMaxTokens('callai-echo', bareRunId(src.body.runId))).toHaveLength(2);
    const f = await api<{ runId: string }>(`/runs/${src.body.runId}:fork`, { method: 'POST', body: JSON.stringify({ mode: 'replay', fromSeq: 0 }) });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    expect(await waitTerminal(f.body.runId)).toBe('completed');
    // A re-dispatch would have served the run's script again and recorded both
    // requests here; the recorded invocation sends none.
    expect(receivedMaxTokens('callai-echo', bareRunId(f.body.runId))).toEqual([]);
    expect(await attemptsOf(f.body.runId)).toEqual(await attemptsOf(src.body.runId));
  });
});
