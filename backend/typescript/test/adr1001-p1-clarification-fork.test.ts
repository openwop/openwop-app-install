/**
 * ADR 1001 D3.5 — replay and fork of a run whose agent asked clarifications.
 *
 * Why it exists: a replay never re-decides (RFC 0223) and never asks a person
 * again, while an EDITED (branch) fork is a new decision point and must ask.
 * The agent node re-executes on any fork, and its two answers live in the
 * source's interrupt rows, so each case pins which rows the fork may read:
 *  1. replay from the start: both rounds are answered from the source by
 *     DERIVED rows (the fork's own `interrupt.resolved`), no card is left open,
 *     and the fork completes with the source's result;
 *  2. replay cut BETWEEN the rounds (right after round 1 resolved): round 1
 *     sits in the copied prefix and is served inline, round 2 is derived. The
 *     fork-start derivation used to take "the first resolution after the cut",
 *     which here is ROUND 2's, and the fork emitted `replay.diverged`;
 *  3. a branch fork asks the person again (an open card);
 *  4. a replay whose agent asks something the source never asked fails the
 *     node as `replay_diverged_at_clarification` instead of asking a person;
 *  5. a replay that reaches a question the source has not answered yet fails
 *     (`replay_source_unanswered`): it neither waits on a person nor lets the
 *     expiry sweep decide it.
 *
 * Zero LIVE model calls on such a replay (the BYOK invocation log, ADR 1002) is
 * pinned in `adr1001-byok-replay-zero-live-calls.test.ts`; here the mock
 * program is re-served, because the mock tools round is not log-recorded.
 *
 * Sabotage-witnessed (wave 81): deleting the post-cut derivation in the
 * executor's suspended branch reds 1 and 2 (the fork waits on an open card);
 * serving every parent resolution inline regardless of the cut reds 1 and 2;
 * dropping `durableRoundAtCut` reds 2's divergence check; treating a branch as
 * a replay in the executor's suspended branch reds 3's first leg, and in
 * `parentResolutionForKey` (the inline durable lookup) reds 3's second leg.
 * Recorded double guard for that second leg: over HTTP a branch fork cut after
 * round 1 never re-executes the node (ADR 0751 re-creates the source's card),
 * so the lookup's own `forkMode` check is read directly on the real records;
 * swapping the asked-in-source discriminator reds 4 or 5.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { __clearAgentIdentityCache } from '../src/host/agentIdentity.js';
import { programMock, resetMockPrograms } from '../src/providers/dispatchMock.js';
import { bareRunId } from './support/bareRunId.js';
import { ASK_USER_TOOL } from '../src/host/clarificationLift.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { parentResolutionForKey } from '../src/executor/forkReplayResolutions.js';
import type { RunRecord } from '../src/types.js';

let BASE = '';
let server: http.Server;
let n = 0;
const AGENT = 'probe.clarify.fork-aide';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  getAgentRegistry().register({
    agentId: AGENT, persona: 'Fork Aide', modelClass: 'chat', systemPrompt: 'You plan trips.',
    packName: 'test.clarify', packVersion: '0.0.1', toolAllowlist: [], confidence: { defaultThreshold: 0.1 },
  });
  __clearAgentIdentityCache();
  const d = getToggleDefault('agent-clarification');
  if (!d) throw new Error('agent-clarification toggle is not registered');
  await saveConfig({ ...d, status: 'on' }, 'test');
}, 120_000);
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

interface Ev { type: string; nodeId?: string; sequence: number; payload?: Record<string, unknown> }
function client() {
  let cookie = '';
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T };
  };
  return { get: <T = unknown>(p: string) => call<T>('GET', p), post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b) };
}
type Client = ReturnType<typeof client>;

const ask = (id: string, question: string): { toolCalls: Array<{ name: string; input: Record<string, unknown> }> } =>
  ({ toolCalls: [{ name: ASK_USER_TOOL, input: { questions: [{ id, question }] } }] });
const R1 = ask('dates', 'Which dates?');
const R2 = ask('budget', 'What budget?');

/** Bounded below the case timeout (15 s), so a stuck fork fails here, named. */
async function waitStatus(c: Client, runId: string, pred: (s: string) => boolean): Promise<string> {
  let s = '';
  await vi.waitFor(async () => {
    s = (await c.get<{ status?: string }>(`/runs/${encodeURIComponent(runId)}`)).body?.status ?? '';
    if (!pred(s)) throw new Error(`run ${runId} stuck at ${s}`);
  }, { timeout: 6_000, interval: 25 });
  return s;
}
const terminal = (s: string): boolean => ['completed', 'failed', 'cancelled'].includes(s);
const settled = (s: string): boolean => s.startsWith('waiting') || terminal(s);
const events = async (c: Client, runId: string): Promise<Ev[]> =>
  (await c.get<{ events: Ev[] }>(`/runs/${encodeURIComponent(runId)}/events/poll?fromSeq=0&limit=1000`)).body.events ?? [];
const openInterrupts = async (c: Client, runId: string): Promise<Array<{ data: Record<string, unknown> }>> =>
  (await c.get<{ interrupts: Array<{ data: Record<string, unknown> }> }>(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`)).body.interrupts ?? [];

/** A completed two-round source run: dates → "May", budget → "$900". */
async function source(): Promise<{ c: Client; runId: string }> {
  const c = client();
  await c.post('/host/openwop-app/test/login', { email: `fork-${Date.now()}-${n++}@acme.test`, tenantId: `org:fork-${Date.now()}-${n++}` });
  resetMockPrograms();
  programMock('run', [R1, R2, { content: 'TRIP-PLAN' }]);
  const created = await c.post<{ runId: string }>('/runs', {
    workflowId: 'openwop-app.agent-mention',
    inputs: { agentId: AGENT, task: 'plan a trip', provider: 'mock', model: 'mock-1', offerTools: [] },
  });
  const runId = created.body.runId;
  for (const [id, value] of [['dates', 'May'], ['budget', '$900']] as const) {
    await waitStatus(c, runId, settled);
    const r = await c.post(`/runs/${encodeURIComponent(runId)}/interrupts/run`, { resumeValue: { answers: [{ id, answer: value }] } });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    await waitStatus(c, runId, (s) => s === 'running' || s.startsWith('waiting') || terminal(s));
  }
  expect(await waitStatus(c, runId, terminal)).toBe('completed');
  return { c, runId };
}
async function fork(c: Client, runId: string, body: Record<string, unknown>): Promise<string> {
  const f = await c.post<{ runId: string }>(`/runs/${encodeURIComponent(runId)}:fork`, body);
  expect(f.status, JSON.stringify(f.body)).toBe(201);
  return f.body.runId;
}

describe('ADR 1001 D3.5 — forks of a run that asked clarifications', () => {
  it('a replay from the start derives both answers from the source and asks no one', async () => {
    const { c, runId } = await source();
    programMock('run', [R1, R2, { content: 'TRIP-PLAN' }]);
    const f = await fork(c, runId, { mode: 'replay', fromSeq: 0 });
    expect(await waitStatus(c, f, terminal)).toBe('completed');
    expect(await openInterrupts(c, f)).toEqual([]);
    const evs = (await events(c, f)).filter((e) => e.nodeId === 'run');
    expect(evs.filter((e) => e.type === 'interrupt.requested')).toHaveLength(2);
    expect(evs.filter((e) => e.type === 'interrupt.resolved')).toHaveLength(2);
    expect(JSON.stringify(evs.filter((e) => e.type === 'node.completed').at(-1)?.payload)).toContain('TRIP-PLAN');
    expect((await events(c, f)).filter((e) => e.type === 'replay.diverged')).toEqual([]);
  });

  it('a replay cut between the rounds serves round 1 from the prefix and derives round 2', async () => {
    const { c, runId } = await source();
    const src = (await events(c, runId)).filter((e) => e.nodeId === 'run');
    const resolved1 = src.filter((e) => e.type === 'interrupt.resolved')[0];
    const requested2 = src.filter((e) => e.type === 'interrupt.requested')[1];
    if (!resolved1 || !requested2) throw new Error('the source did not record two rounds');
    expect(requested2.sequence).toBeGreaterThan(resolved1.sequence);
    programMock('run', [R1, R2, { content: 'TRIP-PLAN' }]);
    const f = await fork(c, runId, { mode: 'replay', fromSeq: resolved1.sequence + 1 });
    expect(await waitStatus(c, f, terminal)).toBe('completed');
    expect(await openInterrupts(c, f)).toEqual([]);
    const after = (await events(c, f)).filter((e) => e.nodeId === 'run' && e.sequence > resolved1.sequence);
    // Only round 2 is requested after the cut; round 1's request is in the prefix.
    expect(after.filter((e) => e.type === 'interrupt.requested')).toHaveLength(1);
    expect(after.filter((e) => e.type === 'interrupt.resolved')).toHaveLength(1);
    // The fork's sequence matches the source's, so the RFC 0041 detector is quiet.
    expect((await events(c, f)).filter((e) => e.type === 'replay.diverged')).toEqual([]);
  });

  it('a branch fork is a new decision point: it asks the person again', async () => {
    const { c, runId } = await source();
    programMock('run', [R1, { content: 'UNUSED' }]);
    const f = await fork(c, runId, { mode: 'branch', fromSeq: 0 });
    expect(await waitStatus(c, f, settled)).toMatch(/^waiting/);
    const [open] = await openInterrupts(c, f);
    expect(open?.data).toMatchObject({ profile: 'openwop-agent-clarification', round: 1, questions: [{ id: 'dates' }] });
    // Inner guard: the parent's round-1 answer is in a later branch fork's
    // prefix, yet the branch must not be served it. Over HTTP the agent node
    // never re-executes on a branch fork cut after round 1 (ADR 0751: the fork
    // re-creates the SOURCE's open card instead, asserted here), so the inline
    // durable lookup's own guard (`parentResolutionForKey` refuses a non-replay
    // fork) is read directly, on the real fork record and the real stored rows,
    // with a replay-mode positive control on the same record.
    const srcRun = (await events(c, runId)).filter((e) => e.nodeId === 'run');
    const resolved1 = srcRun.filter((e) => e.type === 'interrupt.resolved')[0];
    const requested1 = srcRun.filter((e) => e.type === 'interrupt.requested')[0];
    const restarted = srcRun.find((e) => e.type === 'node.started' && e.sequence > (resolved1?.sequence ?? Infinity));
    if (!resolved1 || !requested1 || !restarted) throw new Error('the source did not record round 1 and a restart');
    programMock('run', [R1, R2, { content: 'UNUSED' }]);
    const f2 = await fork(c, runId, { mode: 'branch', fromSeq: restarted.sequence + 1 });
    expect(await waitStatus(c, f2, settled)).toMatch(/^waiting/);
    const [open2] = await openInterrupts(c, f2);
    expect(open2?.data).toMatchObject({ round: 1, questions: [{ id: 'dates' }] });
    // The store keys a run by its bare id (the wire id carries the tenant).
    const branchRun = await hostExtStorage().getRun(bareRunId(f2));
    if (!branchRun) throw new Error('the branch fork has no run record');
    expect(branchRun.forkMode).toBe('branch');
    const key = String((requested1.payload as { key?: unknown } | undefined)?.key);
    const resumeKey = key.slice(key.indexOf(':run:') + ':run:'.length);
    const lookup = (run: RunRecord) => parentResolutionForKey({ storage: hostExtStorage(), run, nodeId: 'run', resumeKey });
    expect((await lookup({ ...branchRun, forkMode: 'replay' }))?.inPrefix, 'control: a replay at this cut is served round 1 inline').toBe(true);
    expect(await lookup(branchRun), 'a branch never reads the parent\'s answer').toBeNull();
  });

  it('a replay whose agent asks something the source never asked fails instead of asking a person', async () => {
    const { c, runId } = await source();
    programMock('run', [ask('city', 'Which city?')]);
    const f = await fork(c, runId, { mode: 'replay', fromSeq: 0 });
    expect(await waitStatus(c, f, terminal)).toBe('failed');
    expect(await openInterrupts(c, f)).toEqual([]);
    const failed = (await events(c, f)).filter((e) => e.type === 'node.failed' && e.nodeId === 'run').at(-1);
    expect((failed?.payload as { error?: { code?: string } } | undefined)?.error?.code).toBe('openwop-app.replay_diverged_at_clarification');
  });

  it('a replay that reaches a question the source has not answered yet fails instead of waiting for a person', async () => {
    const c = client();
    await c.post('/host/openwop-app/test/login', { email: `fork-${Date.now()}-${n++}@acme.test`, tenantId: `org:fork-${Date.now()}-${n++}` });
    resetMockPrograms();
    programMock('run', [R1, R2]);
    const created = await c.post<{ runId: string }>('/runs', {
      workflowId: 'openwop-app.agent-mention',
      inputs: { agentId: AGENT, task: 'plan a trip', provider: 'mock', model: 'mock-1', offerTools: [] },
    });
    const runId = created.body.runId;
    await waitStatus(c, runId, settled);
    expect((await c.post(`/runs/${encodeURIComponent(runId)}/interrupts/run`, { resumeValue: { answers: [{ id: 'dates', answer: 'May' }] } })).status).toBeLessThan(300);
    // Round 2 open in the source (polled on the card's read, not the status:
    // the run can be back to waiting before a status poll ever sees it run).
    await vi.waitFor(async () => {
      const [open] = await openInterrupts(c, runId);
      expect(open?.data.round, 'round 2 open in the source').toBe(2);
    }, { timeout: 6_000, interval: 25 });
    programMock('run', [R1, R2]);
    const f = await fork(c, runId, { mode: 'replay', fromSeq: 0 });
    expect(await waitStatus(c, f, terminal)).toBe('failed');
    expect(await openInterrupts(c, f)).toEqual([]);
    const failed = (await events(c, f)).filter((e) => e.type === 'node.failed' && e.nodeId === 'run').at(-1);
    expect((failed?.payload as { error?: { code?: string } } | undefined)?.error?.code).toBe('openwop-app.replay_source_unanswered');
  });
});
