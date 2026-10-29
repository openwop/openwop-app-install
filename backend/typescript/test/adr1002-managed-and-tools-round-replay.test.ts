/**
 * ADR 1002 — managed `callAI` and BOTH tools rounds (managed + BYOK) record to the
 * invocation log, and a replay fork is served from it instead of calling the model.
 *
 * Before: `callAIManaged` short-circuited past the log ("managed dispatch is for
 * ad-hoc chat, not workflow runs"), and `callAIWithTools` was "NOT cached" on either
 * tier. A replay of an agent node with tools therefore called the model live: a
 * non-deterministic replay that spent the tenant's managed budget.
 *
 * Every provider here is a vi.mock. `fetch` is stubbed to THROW, so a stray live
 * call fails the test rather than reaching a network.
 *
 * D4: agent TOOL results are recorded and served too, so a replay fork makes zero
 * live model calls AND zero tool executions. The witness's read tool answers
 * differently on the replay, so it cannot pass on byte-identity luck.
 *
 * Sabotage-witnessed (2026-10-28):
 * - P1 (model lane): `viaReplayLane`'s replay read removed → 4 red. The read
 *   made unconditional → the B1 revisit case red. That plus `attempt` dropped
 *   from the key → the retry case red too.
 * - P2 (tool lane): the wrapper executing on replay → 8 red. A replay miss
 *   executing → 4 red. Either tenant check removed → its mismatch case red.
 *   The scrub removed → the scrub case red.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiToolCallRequest } from '../src/executor/types.js';

const TOOL_NAME = 'demo_read';
const SEND_TOOL = 'demo_send';
const WRITE_TOOL = 'demo_write';
const TOOL_RESULT = 'TOOL_RESULT';

/** Round 1 asks for three tools; once a tool result is in the history, it answers. */
function scriptedRound(messages: unknown): { text: string; toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> } {
  return JSON.stringify(messages).includes(TOOL_RESULT)
    ? { text: 'The answer is 42.', toolUses: [] }
    : { text: '', toolUses: [
      { id: 'tu-1', name: TOOL_NAME, input: { q: 'meaning' } },
      { id: 'tu-2', name: SEND_TOOL, input: { to: 'a@example.com' } },
      { id: 'tu-3', name: WRITE_TOOL, input: { title: 'Follow up' } },
    ] };
}

const managedRound = vi.fn(async (req: { messages: unknown }) => ({ ...scriptedRound(req.messages), inputTokens: 10, outputTokens: 3 }));
const managedChat = vi.fn(async (_req: unknown) => ({
  provider: 'openwop-free', model: 'openwop-free', completion: 'managed reply', usage: { inputTokens: 7, outputTokens: 2 }, finishReason: 'stop',
}));
const anthropicRound = vi.fn(async (req: { messages: unknown }) => ({ ...scriptedRound(req.messages), inputTokens: 20, outputTokens: 4, finishReason: 'end_turn' }));

vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return { ...original, dispatchManagedToolsRound: managedRound, dispatchManagedChat: managedChat };
});
vi.mock('../src/providers/dispatchAnthropicTools.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/dispatchAnthropicTools.js')>();
  return { ...original, dispatchAnthropicToolsRound: anthropicRound };
});

type Adapter = ReturnType<typeof import('../src/aiProviders/aiProvidersHost.js')['createAiProvidersAdapter']>;
let createAdapter: typeof import('../src/aiProviders/aiProvidersHost.js')['createAiProvidersAdapter'];
let beginNodeActivity: typeof import('../src/host/effectIdentity.js')['beginNodeActivity'];
let logicalInvocationId: typeof import('../src/host/effectIdentity.js')['logicalInvocationId'];
let runChatToolLoop: typeof import('../src/host/agentDispatch.js')['runChatToolLoop'];
let runWithEffectContext: typeof import('../src/host/runEffectContext.js')['runWithEffectContext'];
let assertEffectAllowed: typeof import('../src/host/runEffectContext.js')['assertEffectAllowed'];
let replayTools: typeof import('../src/host/replayToolResults.js');
let lastReplayLaneKey: typeof import('../src/aiProviders/aiProvidersHost.js')['__lastReplayLaneKeyForTests'];
let invocationLog: () => ReturnType<typeof import('../src/executor/invocationLog.js')['getInvocationLog']>;
let policyResolver: import('../src/host/index.js').HostAdapterSuite['providerPolicyResolver'];
let storage: import('../src/storage/storage.js').Storage;
let app: Awaited<ReturnType<typeof import('../src/index.js')['createApp']>>;

const NODE = 'agent';
const TENANT = 'host-shared';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const { createApp } = await import('../src/index.js');
  ({ createAiProvidersAdapter: createAdapter, __lastReplayLaneKeyForTests: lastReplayLaneKey } = await import('../src/aiProviders/aiProvidersHost.js'));
  ({ beginNodeActivity, logicalInvocationId } = await import('../src/host/effectIdentity.js'));
  ({ runChatToolLoop } = await import('../src/host/agentDispatch.js'));
  ({ runWithEffectContext, assertEffectAllowed } = await import('../src/host/runEffectContext.js'));
  replayTools = await import('../src/host/replayToolResults.js');
  const { getInvocationLog } = await import('../src/executor/invocationLog.js');
  invocationLog = getInvocationLog;
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0', enableConsoleTracer: false });
  policyResolver = (app.locals.hostSuite as import('../src/host/index.js').HostAdapterSuite).providerPolicyResolver;
  storage = app.locals.storage as import('../src/storage/storage.js').Storage;
});

afterAll(async () => {
  await (app.locals.storage as { close: () => Promise<void> }).close();
});

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  managedRound.mockClear();
  managedChat.mockClear();
  anthropicRound.mockClear();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ADR 1002 test: no live network call is allowed'));
  return () => fetchSpy.mockRestore();
});

interface Lane { adapter: Adapter; usage: unknown[]; runId: string; tenantId: string; replayFrom?: string }
function lane(runId: string, opts: { attempt?: number; replayFrom?: string; byok?: boolean; tenantId?: string } = {}): Lane {
  const usage: unknown[] = [];
  const tenantId = opts.tenantId ?? TENANT;
  const adapter = createAdapter({
    runId, nodeId: NODE, tenantId, attempt: opts.attempt ?? 1,
    secrets: opts.byok ? { anthropic: 'sk-test' } : {},
    policyResolver,
    ...(opts.replayFrom ? { replayInvocationsFromRunId: opts.replayFrom } : {}),
    emit: async (type: string, payload: unknown) => {
      if (type === 'provider.usage') usage.push(payload);
      return { eventId: `e-${usage.length}`, sequence: usage.length };
    },
  });
  return { adapter, usage, runId, tenantId, ...(opts.replayFrom ? { replayFrom: opts.replayFrom } : {}) };
}

/** The run-effect context the executor builds for a node (`executor.ts`, ADR 0531 + ADR 1002 D4). */
function inNode<T>(l: Lane, fn: () => Promise<T>, attempt = 1): Promise<T> {
  return runWithEffectContext({
    runId: l.runId, replaying: Boolean(l.replayFrom), nodeId: NODE, tenantId: l.tenantId, attempt,
    ...(l.replayFrom ? { replaySourceRunId: l.replayFrom } : {}),
  }, fn);
}

/** Mock tools: a READ whose live answer changes, a GUARDED effect, and an
 *  UNGUARDED durable write. Each counts its real executions. */
let worldState = 0;
const writeStore: string[] = [];
function mockTools() {
  const read = vi.fn(async (_i: Record<string, unknown>) => ({ content: `${TOOL_RESULT} read state=${worldState}` }));
  const send = vi.fn(async (_i: Record<string, unknown>) => {
    assertEffectAllowed('email', 'demo_send');
    return { content: `${TOOL_RESULT} sent` };
  });
  const write = vi.fn(async (i: Record<string, unknown>) => {
    writeStore.push(String(i.title));
    return { content: `${TOOL_RESULT} wrote card-${writeStore.length}` };
  });
  const raw = vi.fn(async (call: { name: string; input: Record<string, unknown> }) =>
    call.name === TOOL_NAME ? read(call.input) : call.name === SEND_TOOL ? send(call.input) : write(call.input));
  return { read, send, write, raw };
}

const TOOL_DEFS = [TOOL_NAME, SEND_TOOL, WRITE_TOOL].map((name) => ({
  def: { name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} } },
  validate: () => ({ ok: true }),
}));

/** One agent turn the way `agentRunnerNode` composes it: node entry, the run-effect
 *  context, the replay guard around executeTool AND the model round, the shared loop. */
async function agentTurn(l: Lane, byok: boolean, attempt = 1) {
  beginNodeActivity(l.runId, NODE, attempt);
  const tools = mockTools();
  const out = await inNode(l, () => {
    const guard = replayTools.createReplayToolGuard(tools.raw);
    return runChatToolLoop(
    {
      provider: byok ? 'anthropic' : 'openwop-free',
      model: byok ? 'claude-sonnet-4-5' : 'openwop-free',
      credentialRef: byok ? 'anthropic' : 'managed:openwop-free',
      systemPrompt: 'You answer questions.',
      messages: [{ role: 'user', content: 'What is the meaning of life?' }],
      tools: TOOL_DEFS,
      agentId: 'demo-agent',
      persona: 'Demo',
    },
    { callAIWithTools: guard.guardModelRound(l.adapter.callAIWithTools), executeTool: guard.executeTool },
  ); }, attempt);
  return { out, tools };
}

const TOOLS_REQ: AiToolCallRequest = {
  provider: 'openwop-free', model: 'openwop-free', credentialRef: 'managed:openwop-free',
  messages: [{ role: 'user', content: 'Same question every visit.' }],
  tools: [{ name: TOOL_NAME, description: 'Look a thing up', inputSchema: { type: 'object' } }],
};

describe.each([
  ['managed', false, () => managedRound],
  ['BYOK', true, () => anthropicRound],
] as const)('ADR 1002 — %s agent node, 2 rounds, 3 tools', (label, byok, provider) => {
  it('a live run calls the provider every round and executes every tool', async () => {
    const before = writeStore.length;
    const { out, tools } = await agentTurn(lane(`run-src-${label}`, { byok }), byok);
    expect(out.error).toBeUndefined();
    expect(out.finalText).toBe('The answer is 42.');
    expect(provider()).toHaveBeenCalledTimes(2);
    expect(tools.read).toHaveBeenCalledTimes(1);
    expect(tools.send).toHaveBeenCalledTimes(1);
    expect(tools.write).toHaveBeenCalledTimes(1);
    expect(writeStore.length).toBe(before + 1);
  });

  it('a replay fork makes ZERO live model calls AND ZERO tool executions, even though the read tool\'s live answer changed', async () => {
    const source = lane(`run-src2-${label}`, { byok });
    const live = await agentTurn(source, byok);
    expect(provider()).toHaveBeenCalledTimes(2);
    provider().mockClear();
    worldState += 1; // the read tool would now answer differently
    const writesBefore = writeStore.length;

    const forkLane = lane(`run-fork-${label}`, { byok, replayFrom: source.runId });
    const replay = await agentTurn(forkLane, byok);

    expect(provider()).toHaveBeenCalledTimes(0);
    expect(replay.tools.raw).toHaveBeenCalledTimes(0);
    expect(writeStore.length).toBe(writesBefore);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(replay.out.error).toBeUndefined();
    expect(replay.out.finalText).toBe(live.out.finalText);
    // RFC 0041 §C — the served rounds emit the SOURCE's payloads verbatim.
    expect(forkLane.usage).toEqual(source.usage);
    expect(source.usage).toHaveLength(2);

    // A fork of the fork replays from its parent (copy-on-read), still zero of both.
    const fork2 = await agentTurn(lane(`run-fork2-${label}`, { byok, replayFrom: forkLane.runId }), byok);
    expect(provider()).toHaveBeenCalledTimes(0);
    expect(fork2.tools.raw).toHaveBeenCalledTimes(0);
  });
});

describe('ADR 1002 D4 — tool results on the replay lane', () => {
  const call = { name: WRITE_TOOL, input: { title: 'unrecorded' }, callId: 'c1' };

  it('an UNRECORDED call on a replay returns replay_source_missing and does not execute', async () => {
    const fork = lane('run-unrec-fork', { replayFrom: 'run-that-never-ran' });
    const tools = mockTools();
    beginNodeActivity(fork.runId, NODE, 1);
    const out = await inNode(fork, () => replayTools.createReplayToolGuard(tools.raw).executeTool(call));
    expect(out).toMatchObject({ isError: true, errorCode: 'replay_source_missing' });
    expect(tools.raw).not.toHaveBeenCalled();
  });

  it('a recorded result over the 1 MB cap is not recorded, so its replay fails closed', async () => {
    const src = lane('run-big-src');
    const big = vi.fn(async () => ({ content: 'x'.repeat(replayTools.MAX_RECORDED_TOOL_RESULT_BYTES + 1) }));
    beginNodeActivity(src.runId, NODE, 1);
    await inNode(src, () => replayTools.createReplayToolGuard(big).executeTool(call));
    const fork = lane('run-big-fork', { replayFrom: src.runId });
    beginNodeActivity(fork.runId, NODE, 1);
    const out = await inNode(fork, () => replayTools.createReplayToolGuard(big).executeTool(call));
    expect(out).toMatchObject({ errorCode: 'replay_source_missing' });
    expect(big).toHaveBeenCalledTimes(1);
  });

  it('a recorded tool result is scrubbed of credential shapes like the model records', async () => {
    const src = lane('run-scrub-src');
    const leaky = vi.fn(async () => ({ content: `key sk-ant-${'a'.repeat(30)} end` }));
    beginNodeActivity(src.runId, NODE, 1);
    await inNode(src, () => replayTools.createReplayToolGuard(leaky).executeTool(call));
    const invocationId = logicalInvocationId({ tenantId: TENANT, runId: src.runId, nodeId: NODE, logicalInvocationOrdinal: 0, providerKey: replayTools.toolCallKey(call.name, call.input) });
    const rec = await invocationLog().get({ runId: src.runId, nodeId: NODE, attempt: 1, invocationId }) as { result: { content: string } };
    expect(rec.result.content).toContain('<<redacted:credential-shape>>');
    expect(rec.result.content).not.toContain('sk-ant-');
  });
});

describe('ADR 1002 — privacy: records stay in the tenant and die with the run', () => {
  const call = { name: WRITE_TOOL, input: { title: 'private' }, callId: 'c1' };
  const plain = { provider: 'openwop-free', model: 'openwop-free', credentialRef: 'managed:openwop-free', messages: [{ role: 'user' as const, content: 'Private question.' }] };

  async function recordSource(src: Lane): Promise<void> {
    const now = new Date().toISOString();
    await storage.insertRun({ runId: src.runId, workflowId: 'wf', tenantId: src.tenantId, status: 'completed', inputs: null, metadata: {}, configurable: {}, createdAt: now, updatedAt: now });
    beginNodeActivity(src.runId, NODE, 1);
    await inNode(src, () => replayTools.createReplayToolGuard(mockTools().raw).executeTool(call));
    await src.adapter.callAI(plain);
  }
  /** Replays one tool call and one model call against `src`; returns what was served. */
  async function replayAgainst(src: Lane, forkId: string): Promise<{ tool: unknown; modelCalls: number }> {
    const fork = lane(forkId, { replayFrom: src.runId, tenantId: src.tenantId });
    const tools = mockTools();
    managedChat.mockClear();
    beginNodeActivity(fork.runId, NODE, 1);
    const tool = await inNode(fork, () => replayTools.createReplayToolGuard(tools.raw).executeTool(call));
    expect(tools.raw).not.toHaveBeenCalled();
    await fork.adapter.callAI(plain);
    return { tool, modelCalls: managedChat.mock.calls.length };
  }

  it('control: an undeleted source is served (tool result, zero model calls)', async () => {
    const src = lane('run-priv-keep', { tenantId: 'user:priv-keep' });
    await recordSource(src);
    const r = await replayAgainst(src, 'run-priv-keep-fork');
    expect(r.tool).toMatchObject({ content: expect.stringContaining('wrote card') });
    expect(r.modelCalls).toBe(0);
  });

  it('deleteRun removes the tool and model records', async () => {
    const src = lane('run-priv-del', { tenantId: 'user:priv-del' });
    await recordSource(src);
    expect(await storage.deleteRun(src.runId)).toBe(true);
    const r = await replayAgainst(src, 'run-priv-del-fork');
    expect(r.tool).toMatchObject({ errorCode: 'replay_source_missing' });
    expect(r.modelCalls).toBe(1);
  });

  it('tenant erasure (deleteAllTenantData) removes the tool and model records', async () => {
    const src = lane('run-priv-erase', { tenantId: 'user:priv-erase' });
    await recordSource(src);
    await storage.deleteAllTenantData(src.tenantId);
    const r = await replayAgainst(src, 'run-priv-erase-fork');
    expect(r.tool).toMatchObject({ errorCode: 'replay_source_missing' });
    expect(r.modelCalls).toBe(1);
  });

  it('a tool record stamped with ANOTHER tenant is refused (replay_tenant_mismatch) and never copied', async () => {
    const tenantB = 'user:tenant-b';
    const src = 'run-xt-src';
    const invocationId = logicalInvocationId({ tenantId: tenantB, runId: src, nodeId: NODE, logicalInvocationOrdinal: 0, providerKey: replayTools.toolCallKey(call.name, call.input) });
    await invocationLog().put({ runId: src, nodeId: NODE, attempt: 1, invocationId }, { kind: 'openwop-app.tool-result', tenantId: 'user:tenant-a', outcome: 'returned', result: { content: 'tenant A secret' } });
    const fork = lane('run-xt-fork', { replayFrom: src, tenantId: tenantB });
    const tools = mockTools();
    beginNodeActivity(fork.runId, NODE, 1);
    const out = await inNode(fork, () => replayTools.createReplayToolGuard(tools.raw).executeTool(call));
    expect(out).toMatchObject({ isError: true, errorCode: 'replay_tenant_mismatch' });
    expect(JSON.stringify(out)).not.toContain('tenant A secret');
    expect(tools.raw).not.toHaveBeenCalled();
    const forkKey = logicalInvocationId({ tenantId: tenantB, runId: fork.runId, nodeId: NODE, logicalInvocationOrdinal: 0, providerKey: replayTools.toolCallKey(call.name, call.input) });
    expect(await invocationLog().get({ runId: fork.runId, nodeId: NODE, attempt: 1, invocationId: forkKey })).toBeNull();
  });

  it('a model record stamped with ANOTHER tenant is refused and nothing is dispatched', async () => {
    const tenantB = 'user:tenant-b2';
    const src = lane('run-xtm-src', { tenantId: tenantB });
    beginNodeActivity(src.runId, NODE, 1);
    await src.adapter.callAI(plain);
    const key = lastReplayLaneKey()!;
    const rec = await invocationLog().get(key) as Record<string, unknown>;
    await invocationLog().put(key, { ...rec, tenantId: 'user:tenant-a' });
    managedChat.mockClear();
    const fork = lane('run-xtm-fork', { replayFrom: src.runId, tenantId: tenantB });
    beginNodeActivity(fork.runId, NODE, 1);
    await expect(fork.adapter.callAI(plain)).rejects.toThrow(/replay_tenant_mismatch/);
    expect(managedChat).not.toHaveBeenCalled();
  });
});

describe('ADR 1002 — live-run behaviour is unchanged', () => {
  it('B1: a live loop revisiting the node at the SAME attempt with an IDENTICAL request calls the provider twice', async () => {
    // beginNodeActivity rewinds the ordinal to 0 on re-entry, so both visits
    // compute the same identity. Only the replay-only read keeps the second visit live.
    const runId = 'run-revisit';
    const { adapter } = lane(runId);
    beginNodeActivity(runId, NODE, 1);
    await adapter.callAIWithTools(TOOLS_REQ);
    beginNodeActivity(runId, NODE, 1);
    await adapter.callAIWithTools(TOOLS_REQ);
    expect(managedRound).toHaveBeenCalledTimes(2);

    beginNodeActivity(runId, NODE, 1);
    await adapter.callAI({ provider: 'openwop-free', model: 'openwop-free', credentialRef: 'managed:openwop-free', messages: [{ role: 'user', content: 'hi' }] });
    beginNodeActivity(runId, NODE, 1);
    await adapter.callAI({ provider: 'openwop-free', model: 'openwop-free', credentialRef: 'managed:openwop-free', messages: [{ role: 'user', content: 'hi' }] });
    expect(managedChat).toHaveBeenCalledTimes(2);
  });

  it('a retry (new attempt) calls the provider again', async () => {
    const runId = 'run-retry';
    beginNodeActivity(runId, NODE, 1);
    await lane(runId, { attempt: 1 }).adapter.callAIWithTools(TOOLS_REQ);
    beginNodeActivity(runId, NODE, 2);
    await lane(runId, { attempt: 2 }).adapter.callAIWithTools(TOOLS_REQ);
    expect(managedRound).toHaveBeenCalledTimes(2);
  });
});

describe('ADR 1002 — replay fidelity', () => {
  it('managed plain callAI: a replay fork is served, zero live calls', async () => {
    const req = { provider: 'openwop-free', model: 'openwop-free', credentialRef: 'managed:openwop-free', messages: [{ role: 'user' as const, content: 'Summarise.' }] };
    beginNodeActivity('run-plain-src', NODE, 1);
    const live = await lane('run-plain-src').adapter.callAI(req);
    beginNodeActivity('run-plain-fork', NODE, 1);
    const served = await lane('run-plain-fork', { replayFrom: 'run-plain-src' }).adapter.callAI(req);
    expect(managedChat).toHaveBeenCalledTimes(1);
    expect(served.content).toBe(live.content);
  });

  it('a recorded managed failure replays as the SAME failure (managedCode kept), then attempt 2 is served', async () => {
    const { ManagedProviderError } = await import('../src/providers/managedProvider.js');
    managedRound.mockImplementationOnce(async () => { throw new ManagedProviderError('daily_limit_reached', 'Daily limit reached'); });
    const src = 'run-fail-src';
    beginNodeActivity(src, NODE, 1);
    await expect(lane(src, { attempt: 1 }).adapter.callAIWithTools(TOOLS_REQ)).rejects.toMatchObject({ code: 'provider_rate_limited', details: { managedCode: 'daily_limit_reached' } });
    beginNodeActivity(src, NODE, 2);
    await lane(src, { attempt: 2 }).adapter.callAIWithTools(TOOLS_REQ);
    expect(managedRound).toHaveBeenCalledTimes(2);
    managedRound.mockClear();

    const fork = 'run-fail-fork';
    beginNodeActivity(fork, NODE, 1);
    await expect(lane(fork, { attempt: 1, replayFrom: src }).adapter.callAIWithTools(TOOLS_REQ)).rejects.toMatchObject({ code: 'provider_rate_limited', details: { managedCode: 'daily_limit_reached' } });
    beginNodeActivity(fork, NODE, 2);
    const served = await lane(fork, { attempt: 2, replayFrom: src }).adapter.callAIWithTools(TOOLS_REQ);
    expect(served.toolCalls?.map((t) => t.name)).toEqual([TOOL_NAME, SEND_TOOL, WRITE_TOOL]);
    expect(managedRound).toHaveBeenCalledTimes(0);
  });

  it('a replay whose request DIVERGED from the source misses and calls live', async () => {
    beginNodeActivity('run-div-src', NODE, 1);
    await lane('run-div-src').adapter.callAIWithTools(TOOLS_REQ);
    managedRound.mockClear();
    beginNodeActivity('run-div-fork', NODE, 1);
    await lane('run-div-fork', { replayFrom: 'run-div-src' }).adapter.callAIWithTools({ ...TOOLS_REQ, messages: [{ role: 'user', content: 'A different question.' }] });
    expect(managedRound).toHaveBeenCalledTimes(1);
  });
});

describe('ADR 1002 — recorded shapes are DECODED, never cast (fail closed on a mismatch)', () => {
  const plain = { provider: 'openwop-free', model: 'openwop-free', credentialRef: 'managed:openwop-free', messages: [{ role: 'user' as const, content: 'Decode me.' }] };

  it('a model record with a malformed shape is refused (replay_record_invalid) and nothing is dispatched', async () => {
    const src = lane('run-dec-src');
    beginNodeActivity(src.runId, NODE, 1);
    await src.adapter.callAI(plain);
    const key = lastReplayLaneKey()!;
    const rec = await invocationLog().get(key) as Record<string, unknown>;
    await invocationLog().put(key, { ...rec, content: 42 });
    managedChat.mockClear();
    const fork = lane('run-dec-fork', { replayFrom: src.runId });
    beginNodeActivity(fork.runId, NODE, 1);
    await expect(fork.adapter.callAI(plain)).rejects.toThrow(/replay_record_invalid/);
    expect(managedChat).not.toHaveBeenCalled();
  });

  it('a tool record with a malformed shape is a miss (replay_source_missing) and does not execute', async () => {
    const call = { name: WRITE_TOOL, input: { title: 'malformed' }, callId: 'c1' };
    const src = 'run-dec-tool-src';
    const invocationId = logicalInvocationId({ tenantId: TENANT, runId: src, nodeId: NODE, logicalInvocationOrdinal: 0, providerKey: replayTools.toolCallKey(call.name, call.input) });
    await invocationLog().put({ runId: src, nodeId: NODE, attempt: 1, invocationId }, { kind: 'openwop-app.tool-result', tenantId: TENANT, outcome: 'returned', result: { content: ['not', 'a', 'string'] } });
    const fork = lane('run-dec-tool-fork', { replayFrom: src });
    const tools = mockTools();
    beginNodeActivity(fork.runId, NODE, 1);
    const out = await inNode(fork, () => replayTools.createReplayToolGuard(tools.raw).executeTool(call));
    expect(out).toMatchObject({ isError: true, errorCode: 'replay_source_missing' });
    expect(tools.raw).not.toHaveBeenCalled();
  });
});

describe('ADR 1002 D4 — through the REAL agent-runner node and REAL write tools', () => {
  const AGENT = 'test.adr1002-filer';
  const NODE_TENANT = 'user:adr1002-node';
  const TODO_TOOL = 'openwop:kanban.add-todo';

  async function cardCount(tenantId: string): Promise<number> {
    const { listBoardsWithCards } = await import('../src/host/kanbanService.js');
    return (await listBoardsWithCards(tenantId)).reduce((n, b) => n + b.cards.length, 0);
  }

  /** Runs the agent-runner node for `runId`, the way the executor does (run-effect
   *  context + the run's adapter), with the model scripted to file one todo. */
  async function runNode(runId: string, replayFrom?: string) {
    const { default: agentRunnerNode } = await import('../src/host/agentRunnerNode.js');
    const { getAgentRegistry } = await import('../src/executor/agentRegistry.js');
    if (!getAgentRegistry().get?.(AGENT)) {
      getAgentRegistry().register({ agentId: AGENT, persona: 'Filer', modelClass: 'chat', systemPrompt: 'You file todos.', packName: 'test', packVersion: '0', toolAllowlist: [TODO_TOOL] });
    }
    managedRound.mockImplementation(async (req: { messages: unknown }) => (JSON.stringify(req.messages).includes('card')
      ? { text: 'Filed it.', toolUses: [], inputTokens: 5, outputTokens: 2 }
      : { text: '', toolUses: [{ id: 'tu-todo', name: TODO_TOOL, input: { title: 'Call the venue' } }], inputTokens: 5, outputTokens: 2 }));
    const l = lane(runId, { tenantId: NODE_TENANT, ...(replayFrom ? { replayFrom } : {}) });
    beginNodeActivity(runId, NODE, 1);
    const nodeCtx: import('../src/executor/types.js').NodeContext = {
      runId, nodeId: NODE, tenantId: NODE_TENANT, attempt: 1, secrets: {},
      inputs: { agentId: AGENT, task: 'File the venue call', credentialRef: 'managed:openwop-free' },
      config: { offerTools: [TODO_TOOL] }, configurable: {},
      actingUserId: 'user:adr1002-human',
      callAI: l.adapter.callAI, callAIWithTools: l.adapter.callAIWithTools,
      emit: async () => ({ eventId: 'e', sequence: 0 }),
    };
    return inNode(l, () => agentRunnerNode.execute(nodeCtx));
  }

  afterAll(() => { managedRound.mockReset(); managedRound.mockImplementation(async (req: { messages: unknown }) => ({ ...scriptedRound(req.messages), inputTokens: 10, outputTokens: 3 })); });

  it('live: the node files ONE card; a replay fork files ZERO and makes ZERO model calls', async () => {
    const before = await cardCount(NODE_TENANT);
    const live = await runNode('run-node-src');
    expect(live.status, JSON.stringify(live)).toBe('success');
    expect(managedRound).toHaveBeenCalledTimes(2);
    expect(await cardCount(NODE_TENANT)).toBe(before + 1);

    managedRound.mockClear();
    const replay = await runNode('run-node-fork', 'run-node-src');
    expect(replay.status, JSON.stringify(replay)).toBe('success');
    expect(managedRound).toHaveBeenCalledTimes(0);
    expect(await cardCount(NODE_TENANT)).toBe(before + 1);
  });

  it('an UNRECORDED tool call on a replay FAILS THE NODE with replay_source_missing and files nothing', async () => {
    const before = await cardCount(NODE_TENANT);
    managedRound.mockClear();
    const out = await runNode('run-node-unrec', 'run-node-never-ran');
    expect(out).toMatchObject({ status: 'failure', retryable: false, error: { code: 'replay_source_missing' } });
    expect(await cardCount(NODE_TENANT)).toBe(before);
    // The source has no model records either, so round 1 dispatched (the D2 miss
    // policy); the guard stopped round 2, so the model never saw the refusal.
    expect(managedRound).toHaveBeenCalledTimes(1);
  });

  it('tasks.schedule-followup + schedule-recurring: a replay fork creates ZERO new scheduler:job rows', async () => {
    // The agent-runner lane passes no conversationId, so there these tools refuse
    // before writing. This drives the real tools with a scope that DOES write (the
    // chat lane's), so the witness is not vacuous.
    const { createAgentToolProvider } = await import('../src/host/agentToolProvider.js');
    const { listJobsForSubject } = await import('../src/host/schedulingService.js');
    const SCHED_TENANT = 'user:adr1002-sched';
    const human = 'u-adr1002';
    const jobs = async (): Promise<number> => (await listJobsForSubject(SCHED_TENANT, { kind: 'user', id: human })).length;
    const calls = [
      { name: 'openwop:tasks.schedule-followup', input: { task: 'Check the venue reply', runAtISO: new Date(Date.now() + 3_600_000).toISOString() } },
      { name: 'openwop:tasks.schedule-recurring', input: { task: 'Morning check-in', cronExpr: '0 9 * * *', timezone: 'UTC' } },
    ];
    const turn = async (l: Lane) => {
      const provider = createAgentToolProvider({ tenantId: SCHED_TENANT, personalTenant: SCHED_TENANT, runId: l.runId, actingUserId: human, agentProfileId: 'host:iris', conversationId: 'conv-adr1002' });
      const raw = vi.fn(provider.executeTool);
      beginNodeActivity(l.runId, NODE, 1);
      const outs = await inNode(l, async () => {
        const guard = replayTools.createReplayToolGuard(raw);
        const r = [];
        for (const c of calls) r.push(await guard.executeTool(c));
        return r;
      });
      return { outs, raw };
    };
    const before = await jobs();
    const src = lane('run-sched-src', { tenantId: SCHED_TENANT });
    const live = await turn(src);
    expect(live.outs.every((o) => !o.isError), JSON.stringify(live.outs)).toBe(true);
    expect(await jobs()).toBe(before + 2);

    const replay = await turn(lane('run-sched-fork', { tenantId: SCHED_TENANT, replayFrom: src.runId }));
    expect(replay.raw).not.toHaveBeenCalled();
    expect(replay.outs).toEqual(live.outs);
    expect(await jobs()).toBe(before + 2);
  });
});
