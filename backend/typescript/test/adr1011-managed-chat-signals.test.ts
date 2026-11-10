/**
 * ADR 1011 P1 — a managed chat turn reaches the tool loop with the round's stop
 * reason and the invalid-arguments mark.
 *
 * What breaks: `runChatToolLoop` read both, but the managed chat adapter returned
 * neither, so a truncated or refused round still ran its calls and malformed
 * arguments still ran as `{}`. All 28 production rounds measured for ADR 1010 took
 * this lane. Drives the real turn entry with only the provider round stubbed.
 * Red when `conversationToolLoop.ts` returns `{content, toolCalls}` by hand.
 *
 * Sabotage witnessed (wave 84): the adapter returning `{ content, toolCalls }` reds the cut
 * and refused cases; rebuilding each call as `{id, name, input}` (dropping the mark) reds
 * the marked case. The last case is the positive control: a valid call on this lane does
 * run, so "runs nothing" is a refusal, not a tool that was never admitted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TOOL = 'openwop:kanban.add-todo';
const script = vi.hoisted(() => ({ rounds: [] as ManagedToolsRoundResult[] }));
vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return { ...actual, dispatchManagedToolsRound: vi.fn(async () => script.rounds.shift() ?? { text: 'done', toolUses: [] }) };
});

import { runConversationAgentToolTurn } from '../src/host/conversationToolLoop.js';
import type { ManagedToolsRoundResult } from '../src/providers/managedProvider.js';
import type { ToolUseBlock } from '../src/providers/dispatchAnthropicTools.js';
import { setConversationCapabilityScope } from '../src/host/conversationStore.js';
import type { ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import type { RunRecord } from '../src/types.js';

const TENANT = 'tenant-adr1011';
const agent: ResolvedAgentManifest = { agentId: 'a', persona: 'P', modelClass: 'general', systemPrompt: 'sp', packName: 'core.openwop.test', packVersion: '0', toolAllowlist: [] };
const run: RunRecord = {
  runId: 'run-adr1011', workflowId: 'openwop-app.conversation', tenantId: TENANT, status: 'waiting-input',
  inputs: { credentialRef: 'managed:openwop-free' }, metadata: { chatSessionId: 'sess-adr1011' }, configurable: {},
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
const turn = () => runConversationAgentToolTurn({
  run, agent, systemPrompt: 'sp', history: [{ role: 'user', content: 'hi' }],
  runId: run.runId, nodeId: 'n', conversationId: 'run-adr1011:n:0', policyResolver: { resolveForRun: async () => [] },
});
const called = (r: Awaited<ReturnType<typeof turn>>) => r!.events.filter((e) => e.type === 'agent.toolCalled');
const call = (extra: Partial<ToolUseBlock> = {}): ToolUseBlock => ({ id: 'c1', name: TOOL, input: { title: 'x' }, ...extra });

let reset: () => void = () => {};
beforeAll(async () => {
  const { initHostExtPersistence, __resetHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
  const { openStorage } = await import('../src/storage/index.js');
  initHostExtPersistence(await openStorage('memory://'));
  reset = __resetHostExtPersistence;
  await setConversationCapabilityScope(TENANT, 'sess-adr1011', { mode: 'restricted', enabled: [TOOL] });
});
afterAll(() => reset());
beforeEach(() => { script.rounds = []; });

describe('managed chat turns', () => {
  it('a round the output limit cut runs nothing, and a second cut fails typed', async () => {
    const cut: ManagedToolsRoundResult = { text: '', toolUses: [call()], finishReason: 'length' };
    script.rounds = [cut, cut];
    const r = await turn();
    expect(called(r)).toEqual([]);
    expect(r!.error?.code).toBe('envelope_truncation_unrecoverable');
    expect(script.rounds).toEqual([]); // the one repair spent the second round
  });

  it('a refused round runs nothing and is not retried', async () => {
    script.rounds = [{ text: 'echo', toolUses: [call()], finishReason: 'content_filter' }, { text: 'retried', toolUses: [] }];
    const r = await turn();
    expect(called(r)).toEqual([]);
    expect(r!.error?.code).toBe('envelope_refusal');
    expect(script.rounds).toHaveLength(1);
  });

  // The mark, not the schema, must refuse it: a tool with no required field accepts `{}`.
  it('marked arguments are refused as malformed, not judged by the tool schema', async () => {
    script.rounds = [{ text: '', toolUses: [call({ input: {}, argumentsInvalid: true })], finishReason: 'tool_calls' }];
    const r = await turn();
    expect(called(r)).toEqual([]);
    const refused = r!.events.find((e) => e.type === 'agent.toolReturned');
    expect(refused).toMatchObject({ status: 'error', error: { code: 'invalid_args', message: expect.stringContaining('not a JSON object') } });
  });

  it('positive control: a complete round with valid arguments runs its call on this lane', async () => {
    script.rounds = [{ text: '', toolUses: [call({ id: 'c-ok' })], finishReason: 'tool_calls' }];
    const r = await turn();
    expect(called(r)).toEqual([expect.objectContaining({ toolName: TOOL, callId: 'c-ok' })]);
  });
});
