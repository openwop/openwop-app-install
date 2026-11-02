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
 * divergence injections reds the replay case. (w73 probes fx67-*.)
 *
 * The concurrent case FORCES the interleave (wave 73, TST-DRX): two `Promise.all`
 * runs otherwise execute one after the other, so a node-keyed lookup could not be
 * told from a run-keyed one. A one-shot hold parks the first `dispatchMock` call
 * until the second run has programmed its script, and the case asserts both
 * arrivals happened; the hold's bounded fallback REJECTS (the case then fails),
 * it never sleeps. The refusal case parks a sentinel module under the fixture's
 * typeId and asserts the auth posture leaves the sentinel in place (positive
 * control: the allowed posture replaces it), so it does not depend on whether
 * the executor block's `createApp` registered the node first. (A spy on
 * `register` cannot work: `getNodeRegistry()` returns a new wrapper per call.)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import {
  CALLAI_ECHO_ATTEMPTS_TYPE_ID, callAiEchoAttemptsNode, callAiFixtureEnabled, registerCallAiFixtureNode, resetCallAiFixtureRegistrationForTests,
} from '../src/bootstrap/conformanceCallAiFixture.js';
import * as mockModule from '../src/providers/dispatchMock.js';
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
    // Observe the registration itself, independent of block order: the global
    // registry has no unregister, and getNodeRegistry() hands out a fresh wrapper
    // per call (a spy on one never sees the product's call). So park a SENTINEL
    // module under the fixture's typeId and check whether the real node replaced it.
    const sentinel = { ...callAiEchoAttemptsNode };
    getNodeRegistry().register(sentinel);
    try {
      setEnv({ NODE_ENV: 'production', OPENWOP_DEPLOY_POSTURE: 'auth', OPENWOP_CONFORMANCE_CALLAI_FIXTURE: 'true' });
      expect(callAiFixtureEnabled()).toBe(false);
      resetCallAiFixtureRegistrationForTests();
      registerCallAiFixtureNode();
      expect(getNodeRegistry().get(CALLAI_ECHO_ATTEMPTS_TYPE_ID)).toBe(sentinel);
      // Positive control: the same observation sees the registration once the posture allows it.
      setEnv({ NODE_ENV: 'production', OPENWOP_DEPLOY_POSTURE: 'cookie-per-visitor', OPENWOP_CONFORMANCE_CALLAI_FIXTURE: 'true' });
      resetCallAiFixtureRegistrationForTests();
      registerCallAiFixtureNode();
      expect(getNodeRegistry().get(CALLAI_ECHO_ATTEMPTS_TYPE_ID)).toBe(callAiEchoAttemptsNode);
    } finally {
      // Leave the real module registered (what a boot with the opt-in does), never the sentinel.
      getNodeRegistry().register(callAiEchoAttemptsNode);
      resetCallAiFixtureRegistrationForTests();
    }
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
  const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
  const field = (v: unknown, key: string): unknown => (isRecord(v) ? v[key] : undefined);
  const savedBootEnv = { dsn: process.env.OPENWOP_STORAGE_DSN, cookies: process.env.OPENWOP_AUTH_DISABLE_COOKIES };

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    resetCallAiFixtureRegistrationForTests();
    const { createApp } = await import('../src/index.js');
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  }, 120_000);
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    if (savedBootEnv.dsn === undefined) delete process.env.OPENWOP_STORAGE_DSN; else process.env.OPENWOP_STORAGE_DSN = savedBootEnv.dsn;
    if (savedBootEnv.cookies === undefined) delete process.env.OPENWOP_AUTH_DISABLE_COOKIES; else process.env.OPENWOP_AUTH_DISABLE_COOKIES = savedBootEnv.cookies;
  });

  async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
    const text = await res.text();
    const body: unknown = text ? JSON.parse(text) : {};
    return { status: res.status, body };
  }
  function runIdOf(res: { status: number; body: unknown }): string {
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = field(res.body, 'runId');
    if (typeof id !== 'string') throw new Error(`no runId: ${JSON.stringify(res.body)}`);
    return id;
  }
  /** Poll a run until terminal. A timeout THROWS; it never returns a non-terminal status. */
  async function waitTerminal(runId: string, ms = 30_000): Promise<string> {
    const end = Date.now() + ms;
    let status: unknown;
    for (;;) {
      status = field((await api(`/runs/${runId}`)).body, 'status');
      if (typeof status === 'string' && ['completed', 'failed', 'cancelled'].includes(status)) return status;
      if (Date.now() > end) throw new Error(`waitTerminal: run ${runId} still ${String(status)} after ${ms} ms`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const attemptsOf = async (runId: string): Promise<Json | undefined> => {
    const res = await api(`/runs/${runId}/events/poll?fromSeq=-1&limit=1000`);
    const list = field(res.body, 'events');
    if (!Array.isArray(list)) throw new Error(`no events list: ${JSON.stringify(res.body)}`);
    const evs: Ev[] = list.filter(isRecord).map((e) => ({
      type: typeof e.type === 'string' ? e.type : '',
      ...(typeof e.nodeId === 'string' ? { nodeId: e.nodeId } : {}),
      ...(isRecord(e.payload) ? { payload: e.payload } : {}),
    }));
    const attempts = field(evs.find((e) => e.type === 'node.completed' && e.nodeId === 'callai-echo')?.payload?.['outputs'], 'attempts');
    return isRecord(attempts) ? attempts : undefined;
  };
  const start = (script: Json[]) => api('/runs', { method: 'POST', body: JSON.stringify({
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
    // Force the window: the FIRST fixture request is parked until the SECOND run
    // has programmed its script, so both scripts are live when either is read.
    const realProgram = mockModule.programMockForRun;
    const realDispatch = mockModule.dispatchMock;
    let programmed = 0;
    let releaseHeld: () => void = () => undefined;
    const secondProgrammed = new Promise<void>((res) => { releaseHeld = res; });
    let held = false;
    let holdTimedOut = false;
    const program = vi.spyOn(mockModule, 'programMockForRun').mockImplementation((runId, nodeId, prog) => {
      realProgram(runId, nodeId, prog);
      if (nodeId === 'callai-echo' && ++programmed === 2) releaseHeld();
    });
    const dispatch = vi.spyOn(mockModule, 'dispatchMock').mockImplementation(async (req) => {
      if (!held && req.nodeId === 'callai-echo') {
        held = true;
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            secondProgrammed,
            new Promise<never>((_, rej) => { timer = setTimeout(() => { holdTimedOut = true; rej(new Error('hold: the second run never programmed its script')); }, 10_000); }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      return realDispatch(req);
    });
    try {
      const [one, two] = await Promise.all([
        start([{ kind: 'valid', outputTokens: 5 }]),
        start([{ kind: 'invalid-json', outputTokens: 10 }, { kind: 'invalid-json', outputTokens: 10 }, { kind: 'valid', outputTokens: 20 }]),
      ]);
      const oneId = runIdOf(one);
      const twoId = runIdOf(two);
      expect(await waitTerminal(oneId)).toBe('completed');
      expect(await waitTerminal(twoId)).toBe('completed');
      // The window really opened: one request was held while BOTH scripts were programmed.
      expect(held).toBe(true);
      expect(holdTimedOut).toBe(false);
      expect(programmed).toBe(2);
      expect(await attemptsOf(oneId)).toMatchObject({ count: 1, outputTokens: 5 });
      expect(await attemptsOf(twoId)).toMatchObject({ count: 3, outputTokens: 40 });
    } finally {
      program.mockRestore();
      dispatch.mockRestore();
    }
  });

  it('a replay fork reads the recorded invocation: no request reaches the mock, same attempts', async () => {
    const srcId = runIdOf(await start([{ kind: 'invalid-json', outputTokens: 10 }, { kind: 'valid', outputTokens: 20 }]));
    expect(await waitTerminal(srcId)).toBe('completed');
    expect(receivedMaxTokens('callai-echo', bareRunId(srcId))).toHaveLength(2);
    const forkId = runIdOf(await api(`/runs/${srcId}:fork`, { method: 'POST', body: JSON.stringify({ mode: 'replay', fromSeq: 0 }) }));
    expect(await waitTerminal(forkId)).toBe('completed');
    // A re-dispatch would have served the run's script again and recorded both
    // requests here; the recorded invocation sends none.
    expect(receivedMaxTokens('callai-echo', bareRunId(forkId))).toEqual([]);
    expect(await attemptsOf(srcId)).toMatchObject({ count: 2, outputTokens: 30 });
    expect(await attemptsOf(forkId)).toEqual(await attemptsOf(srcId));
  });
});
