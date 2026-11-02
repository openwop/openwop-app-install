/**
 * INVARIANT: what a model is sent does not depend on which run sent it.
 *
 * ADR 1002 replay depends on this. A replay fork has its own runId, and its
 * model rounds are served from the source's invocation log keyed by a digest
 * of the request (`toolsRoundDigest` / `plainRequestDigest`, both over the
 * messages). If any text the host puts into a request carries the runId, or
 * anything derived from it, the fork's digest differs, the record misses, and
 * the model is called live. XCH-ENV-9 shipped exactly that (the
 * `schema.request` answer echoed `<runId>:<nodeId>:schema:<round>`), and the
 * site-specific pins could not have caught the next one.
 *
 * So this is a GENERAL guard. The same multi-round agent turn runs under two
 * different runIds with identical model outputs per round, through the real
 * executor and run routes, with only the provider stubbed. Every request the
 * provider receives is recorded. For every round:
 *  - the request (model, messages, tools, max tokens) is byte-identical
 *    across the two runs;
 *  - no request contains either runId as a substring.
 * Two entry points:
 *  - the tools-round path (agent-runner → `runAgentDispatchLive` →
 *    `runChatToolLoop`, BYOK Anthropic), scripted through a refused ask
 *    and the host's one repair message, an ADR 1006 clarification round
 *    (paused, answered, resumed), a tool round and a final answer;
 *  - the single-completion `callAI` path (no tools, no clarification).
 *
 * Witnessed: red on 8da0849a5's `agentDispatch.ts` (the schema.request round
 * carries the runId), green with the XCH-ENV-9 echo fix. ADR 1007 deleted that
 * round, so the script moved to the ask, repair and tool rounds: putting the
 * runId into the ask-repair message reds round 2 of both tool-path cases.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';

/** Every request a provider stub received, in order, as the digest would see it. */
const toolRequests: string[] = [];
const plainRequests: string[] = [];

const LOOKUP = { id: 'guard-lookup', name: 'openwop:schema.lookup', input: { kind: 'node', names: ['core.noop'] } };
const LOOKUP_ANSWERED = `Result of ${LOOKUP.name}`;
const BAD_ASK = { id: 'guard-bad-ask', name: 'openwop:ask-user', input: { questions: [] } };
const CLARIFY_ASK = { id: 'guard-ask', name: 'openwop:ask-user', input: { questions: [{ id: 'dates', question: 'Which dates?' }] } };

/** ADR 1003 D3 — the continuation hint each tools round received, in order. */
const toolHints: boolean[] = [];
/** Deterministic by conversation state: refused ask → ask → tool → answer. The
 *  tool comes last because tool output makes a later ask answerable only in the
 *  app, and this guard resumes over the API. */
const toolsRound = vi.fn(async (req: { model: string; messages: unknown; tools: unknown; maxTokens?: number; cacheConversation?: boolean }) => {
  const record = JSON.stringify({ model: req.model, messages: req.messages, tools: req.tools, maxTokens: req.maxTokens ?? null });
  toolRequests.push(record);
  toolHints.push(req.cacheConversation === true);
  if (record.includes(LOOKUP_ANSWERED)) return { text: 'TRIP-PLAN', toolUses: [], inputTokens: 10, outputTokens: 3, finishReason: 'end_turn' };
  const next = record.includes('dates (Which dates?)') ? LOOKUP : record.includes('refused your question') ? CLARIFY_ASK : BAD_ASK;
  return { text: '', toolUses: [next], inputTokens: 10, outputTokens: 3, finishReason: 'tool_use' };
});
vi.mock('../src/providers/dispatchAnthropicTools.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/dispatchAnthropicTools.js')>();
  return { ...original, dispatchAnthropicToolsRound: toolsRound };
});
vi.mock('../src/providers/dispatch.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/dispatch.js')>();
  return {
    ...original,
    dispatchChat: vi.fn(async (req: { provider: string; model: string; messages: unknown; maxTokens?: number }) => {
      plainRequests.push(JSON.stringify({ provider: req.provider, model: req.model, messages: req.messages, maxTokens: req.maxTokens ?? null }));
      return { completion: 'PLAIN-ANSWER', usage: { inputTokens: 1, outputTokens: 1 } };
    }),
  };
});

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };
const TOOL_AGENT = 'probe.xch9.guard-tools';
const PLAIN_AGENT = 'probe.xch9.guard-plain';
const TOOL = 'openwop:schema.lookup';
const REF = 'anthropic:xch9-guard';
let model = '';
let setClarification: (on: boolean) => Promise<void> = async () => {};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const { createApp } = await import('../src/index.js');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const { setSecret } = await import('../src/byok/secretResolver.js');
  await setSecret(REF, 'sk-test-xch9-guard', { tenantId: 'default' });
  const { getDefaultModel } = await import('../src/providers/catalog.js');
  model = getDefaultModel('anthropic');
  const { getAgentRegistry } = await import('../src/executor/agentRegistry.js');
  for (const [agentId, toolAllowlist] of [[TOOL_AGENT, [TOOL]], [PLAIN_AGENT, []]] as const) {
    getAgentRegistry().register({
      agentId, persona: 'Guard Probe', modelClass: 'chat', systemPrompt: 'You plan trips.',
      packName: 'test.xch9', packVersion: '0.0.1', toolAllowlist: [...toolAllowlist], confidence: { defaultThreshold: 0.1 },
    });
  }
  (await import('../src/host/agentIdentity.js')).__clearAgentIdentityCache();
  const { saveConfig } = await import('../src/host/featureToggles/service.js');
  const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
  const toggle = getToggleDefault('agent-clarification');
  if (!toggle) throw new Error('agent-clarification toggle is not registered');
  setClarification = async (on) => { await saveConfig({ ...toggle, status: on ? 'on' : 'off' }, 'test'); };
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  const realFetch = globalThis.fetch;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).startsWith(BASE)) return realFetch(input, init);
    throw new Error('XCH-ENV-9 guard: no live network call is allowed');
  });
  return () => fetchSpy.mockRestore();
});

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

/** One run of `agentId`; answers each clarification with `answers` in order.
 *  Returns the runId and the requests the provider stub received for it. */
async function runTurn(agentId: string, offerTools: string[], answers: Array<[string, string]>, sink: string[]) {
  const before = sink.length;
  const created = await api<{ runId: string }>('/runs', {
    workflowId: 'openwop-app.agent-mention',
    inputs: { agentId, task: 'plan a trip', provider: 'anthropic', model, credentialRef: REF, offerTools },
    configurable: { version: 1, ai: { credentialRef: REF } },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const runId = created.body.runId;
  for (const [id, value] of answers) {
    expect(await waitStatus(runId, (s) => s.startsWith('waiting') || terminal(s))).toMatch(/^waiting/);
    const r = await api(`/runs/${encodeURIComponent(runId)}/interrupts/run`, { resumeValue: { answers: [{ id, answer: value }] } });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    await waitStatus(runId, (s) => s === 'running' || s.startsWith('waiting') || terminal(s));
  }
  expect(await waitStatus(runId, terminal)).toBe('completed');
  return { runId, requests: sink.slice(before) };
}

function expectRunIndependent(a: { runId: string; requests: string[] }, b: { runId: string; requests: string[] }): void {
  expect(a.runId).not.toBe(b.runId);
  expect(b.requests.length).toBe(a.requests.length);
  a.requests.forEach((req, i) => {
    expect(b.requests[i], `round ${i + 1} differs between the two runs`).toBe(req);
    for (const runId of [a.runId, b.runId]) {
      expect(req.includes(runId), `round ${i + 1} carries runId ${runId}`).toBe(false);
      expect(b.requests[i]!.includes(runId), `round ${i + 1} (second run) carries runId ${runId}`).toBe(false);
    }
  });
}

describe('model input is run-independent (the ADR 1002 replay invariant)', () => {
  it('the tools-round path: tool, repair, clarification and answer rounds are identical across two runs', async () => {
    await setClarification(true);
    const a = await runTurn(TOOL_AGENT, [TOOL], [['dates', 'May']], toolRequests);
    const b = await runTurn(TOOL_AGENT, [TOOL], [['dates', 'May']], toolRequests);
    // The scripted turn reached every round: the repair, the clarification,
    // the tool and the answer.
    expect(a.requests.length).toBeGreaterThanOrEqual(4);
    expect(a.requests.some((r) => r.includes(LOOKUP_ANSWERED))).toBe(true);
    expect(a.requests.some((r) => r.includes('refused your question'))).toBe(true);
    expect(a.requests.some((r) => r.includes('dates (Which dates?)'))).toBe(true);
    expectRunIndependent(a, b);
  });

  // ADR 1003 — with EVERY context-economy lever on (the master switch: tool
  // diet, transcript and memory budgets, provider and conversation cache), the
  // invariant still holds, and the D3 hint is sent from round 2 on. Sabotage:
  // a lever that put a run-derived value into the request would red this case.
  it('lever ON: the same rounds are identical across two runs, and rounds 2+ carry the D3 hint', async () => {
    await setClarification(true);
    process.env.OPENWOP_CONTEXT_ECONOMY = 'true';
    try {
      const hintsBefore = toolHints.length;
      const a = await runTurn(TOOL_AGENT, [TOOL], [['dates', 'May']], toolRequests);
      const aHints = toolHints.slice(hintsBefore);
      const b = await runTurn(TOOL_AGENT, [TOOL], [['dates', 'May']], toolRequests);
      expect(a.requests.length).toBeGreaterThanOrEqual(3);
      expectRunIndependent(a, b);
      // The first round of a dispatch never carries the hint; a later round of
      // the same dispatch does.
      expect(aHints[0]).toBe(false);
      expect(aHints.some((h) => h)).toBe(true);
    } finally {
      delete process.env.OPENWOP_CONTEXT_ECONOMY;
    }
  });

  it('the single-completion callAI path is identical across two runs', async () => {
    await setClarification(false);
    const a = await runTurn(PLAIN_AGENT, [], [], plainRequests);
    const b = await runTurn(PLAIN_AGENT, [], [], plainRequests);
    expect(a.requests.length).toBeGreaterThanOrEqual(1);
    expectRunIndependent(a, b);
  });
});
