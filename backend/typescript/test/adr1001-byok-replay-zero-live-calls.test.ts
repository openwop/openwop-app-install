/**
 * ADR 1001 D3 / B1 — a BYOK replay fork of an agent node that asked TWO
 * clarifications makes ZERO live model calls.
 *
 * Why it exists: the node continues a paused turn from a checkpoint, so its
 * model calls are spread over several node invocations, each allocating effect
 * ordinals from the per-node counter. The fork reaches the same calls by a
 * different route: from the start, it re-asks and has each answer DERIVED; cut
 * between the rounds, it serves round 1 inline and continues in ONE invocation.
 * Unless the continuation is seeded to the ordinal the turn paused at (D3.3),
 * the fork's continuation computes a different invocation identity, misses the
 * source's record on the real invocation log (ADR 1002), and calls the model
 * live. On the managed tier this was always live before ADR 1002; this pins
 * the BYOK lane through the real executor and the real `:fork` route.
 *
 * The provider is a `vi.mock` of the Anthropic tools-round dispatcher and
 * `fetch` throws, so a live call is counted, never sent.
 *
 * Sabotage-witnessed: removing the source-record read in `viaReplayLane` reds
 * both cases; dropping the `seedNodeActivity` call in
 * `agentClarificationTurn.ts` reds the between-rounds case.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';

/** Deterministic by conversation state: ask dates → ask budget → answer. */
const liveRounds = vi.fn(async (req: { messages: unknown; tools?: Array<{ name: string }> }) => {
  const seen = JSON.stringify(req.messages);
  const ask = (id: string, question: string) => ({ text: '', toolUses: [{ id: `ask-${id}`, name: 'openwop:ask-user', input: { questions: [{ id, question }] } }], inputTokens: 10, outputTokens: 3, finishReason: 'tool_use' });
  if (seen.includes('budget (What budget?)')) return { text: 'TRIP-PLAN', toolUses: [], inputTokens: 10, outputTokens: 3, finishReason: 'end_turn' };
  return seen.includes('dates (Which dates?)') ? ask('budget', 'What budget?') : ask('dates', 'Which dates?');
});
vi.mock('../src/providers/dispatchAnthropicTools.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/dispatchAnthropicTools.js')>();
  return { ...original, dispatchAnthropicToolsRound: liveRounds };
});

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };
const AGENT = 'probe.clarify.byok-aide';
const TOOL_AGENT = 'probe.clarify.byok-tools';
const TOOL = 'openwop:schema.lookup';
const REF = 'anthropic:adr1001';
let model = '';
let setToggle: (on: boolean) => Promise<unknown> = async () => undefined;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const { createApp } = await import('../src/index.js');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const { setSecret } = await import('../src/byok/secretResolver.js');
  await setSecret(REF, 'sk-test-adr1001', { tenantId: 'default' });
  const { getDefaultModel } = await import('../src/providers/catalog.js');
  model = getDefaultModel('anthropic');
  const { getAgentRegistry } = await import('../src/executor/agentRegistry.js');
  getAgentRegistry().register({
    agentId: AGENT, persona: 'BYOK Aide', modelClass: 'chat', systemPrompt: 'You plan trips.',
    packName: 'test.clarify', packVersion: '0.0.1', toolAllowlist: [], confidence: { defaultThreshold: 0.1 },
  });
  getAgentRegistry().register({
    agentId: TOOL_AGENT, persona: 'BYOK Tools', modelClass: 'chat', systemPrompt: 'You plan trips.',
    packName: 'test.clarify', packVersion: '0.0.1', toolAllowlist: [TOOL], confidence: { defaultThreshold: 0.1 },
  });
  (await import('../src/host/agentIdentity.js')).__clearAgentIdentityCache();
  const { saveConfig } = await import('../src/host/featureToggles/service.js');
  const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
  const toggle = getToggleDefault('agent-clarification');
  if (!toggle) throw new Error('agent-clarification toggle is not registered');
  setToggle = (on) => saveConfig({ ...toggle, status: on ? 'on' : 'off' }, 'test');
  await setToggle(true);
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  liveRounds.mockClear();
  // Only the test's own calls to the local app may use fetch.
  const realFetch = globalThis.fetch;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).startsWith(BASE)) return realFetch(input, init);
    throw new Error('ADR 1001 test: no live network call is allowed');
  });
  return () => fetchSpy.mockRestore();
});

interface Ev { type: string; nodeId?: string; sequence: number }
async function api<T>(path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: H, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json().catch(() => undefined) as T };
}
async function waitStatus(runId: string, pred: (s: string) => boolean): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const s = (await api<{ status?: string }>(`/runs/${encodeURIComponent(runId)}`)).body?.status ?? '';
    if (pred(s)) return s;
    if (Date.now() - t0 > 20_000) throw new Error(`run ${runId} stuck at ${s}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const terminal = (s: string): boolean => ['completed', 'failed', 'cancelled'].includes(s);
const events = async (runId: string): Promise<Ev[]> => (await api<{ events: Ev[] }>(`/runs/${encodeURIComponent(runId)}/events/poll?fromSeq=0&limit=1000`)).body.events ?? [];

/** A completed BYOK source run that asked twice (dates → May, budget → $900). */
async function source(): Promise<string> {
  const created = await api<{ runId: string }>('/runs', {
    workflowId: 'openwop-app.agent-mention',
    inputs: { agentId: AGENT, task: 'plan a trip', provider: 'anthropic', model, credentialRef: REF, offerTools: [] },
    configurable: { version: 1, ai: { credentialRef: REF } },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const runId = created.body.runId;
  for (const [id, value] of [['dates', 'May'], ['budget', '$900']] as const) {
    await waitStatus(runId, (s) => s.startsWith('waiting') || terminal(s));
    const r = await api(`/runs/${encodeURIComponent(runId)}/interrupts/run`, { resumeValue: { answers: [{ id, answer: value }] } });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    await waitStatus(runId, (s) => s === 'running' || s.startsWith('waiting') || terminal(s));
  }
  expect(await waitStatus(runId, terminal)).toBe('completed');
  return runId;
}

describe('ADR 1001 B1 — a BYOK replay fork of a two-round agent node makes zero live model calls', () => {
  it('a replay from the start is served every model call from the source\'s invocation log', async () => {
    const runId = await source();
    expect(liveRounds).toHaveBeenCalledTimes(3); // the source: ask, ask, answer
    liveRounds.mockClear();
    const f = await api<{ runId: string }>(`/runs/${encodeURIComponent(runId)}:fork`, { mode: 'replay', fromSeq: 0 });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    expect(await waitStatus(f.body.runId, terminal)).toBe('completed');
    expect(liveRounds, 'a replay fork must not call the model').toHaveBeenCalledTimes(0);
  });

  it('a replay cut between the rounds (round 1 served inline, one invocation) is served too', async () => {
    const runId = await source();
    liveRounds.mockClear();
    const resolved1 = (await events(runId)).filter((e) => e.type === 'interrupt.resolved' && e.nodeId === 'run')[0];
    if (!resolved1) throw new Error('the source recorded no resolution');
    const f = await api<{ runId: string }>(`/runs/${encodeURIComponent(runId)}:fork`, { mode: 'replay', fromSeq: resolved1.sequence + 1 });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    expect(await waitStatus(f.body.runId, terminal)).toBe('completed');
    expect(liveRounds, 'the continuation must reach the source\'s records at the same ordinals').toHaveBeenCalledTimes(0);
  });
});

describe('ADR 1006 — what reaches the provider', () => {
  const offered = (): string[] => (liveRounds.mock.calls[0]?.[0].tools ?? []).map((t) => t.name);
  const start = async (agentId: string, offerTools: string[]): Promise<string> => {
    const created = await api<{ runId: string }>('/runs', {
      workflowId: 'openwop-app.agent-mention',
      inputs: { agentId, task: 'plan a trip', provider: 'anthropic', model, credentialRef: REF, offerTools },
      configurable: { version: 1, ai: { credentialRef: REF } },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.runId;
  };

  it('a run stamped to ask offers the tool, to an agent whose allowlist does not name it', async () => {
    const runId = await start(AGENT, []);
    await waitStatus(runId, (s) => s.startsWith('waiting') || terminal(s));
    expect(offered()).toEqual(['openwop:ask-user']);
  });

  it('a run born with the toggle off is not offered it', async () => {
    await setToggle(false);
    try {
      const runId = await start(TOOL_AGENT, [TOOL]);
      await waitStatus(runId, (s) => s.startsWith('waiting') || terminal(s));
      expect(liveRounds).toHaveBeenCalled();
      expect(offered()).toEqual([TOOL]);
    } finally {
      await setToggle(true);
    }
  });
});
