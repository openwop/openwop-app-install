/**
 * ADR 1011 P1 (RFC 0256 §B) — the tool loop reads a round's completion first and
 * validates a call's arguments before any gate.
 *
 * What breaks: a call the output limit cut off ran with `{}` as its arguments; a
 * safety stop was retried; a person was asked to approve a call that would then
 * be refused. The provider half (malformed JSON is marked, blank is no arguments)
 * runs through the real OpenAI-compatible round.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runChatToolLoop, type AgentEvent, type CompiledTool } from '../src/host/agentDispatch.js';
import { dispatchMiniMaxToolsRound, dispatchOpenAIToolsRound } from '../src/providers/dispatchProviderTools.js';
import { dispatchMiniMaxWithTools } from '../src/providers/dispatchMiniMaxTools.js';
import { normalizeFinishReason, toolRoundResult } from '../src/aiProviders/aiProvidersHost.js';
import type { AiToolCallResult } from '../src/executor/types.js';

const TOOL = 'send';
const tool: CompiledTool = {
  def: { name: TOOL, description: 'send', inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] } },
  validate: (input) => (typeof input.to === 'string' ? { ok: true } : { ok: false, errors: 'to is required' }),
};

const opts = (extra: Partial<Parameters<typeof runChatToolLoop>[0]> = {}): Parameters<typeof runChatToolLoop>[0] => ({
  provider: 'anthropic', model: 'm', credentialRef: 'k', systemPrompt: 's',
  messages: [{ role: 'user', content: 'go' }], tools: [tool], agentId: 'a1', persona: 'Tester',
  ...extra,
});

const scripted = (...rounds: AiToolCallResult[]) => {
  const seen: string[] = [];
  let i = 0;
  return {
    seen,
    callAIWithTools: async (req: { messages: ReadonlyArray<{ content: unknown }> }) => {
      seen.push(String(req.messages.at(-1)?.content));
      const round = rounds[Math.min(i, rounds.length - 1)]!;
      i += 1;
      return round;
    },
  };
};

const returned = (events: readonly AgentEvent[]) =>
  events.flatMap((e) => (e.type === 'agent.toolReturned' ? [e] : []));

describe('completion comes first', () => {
  const cut: AiToolCallResult = { content: 'partial', toolCalls: [{ id: 'c1', name: TOOL, input: { to: 'a' } }], finishReason: 'length' };

  it('runs nothing from a truncated round, repairs once, and then answers', async () => {
    let ran = 0;
    const model = scripted(cut, { content: 'done', toolCalls: [], finishReason: 'stop' });
    const res = await runChatToolLoop(opts(), { callAIWithTools: model.callAIWithTools, executeTool: async () => { ran += 1; return { content: 'x' }; } });
    expect(ran).toBe(0);
    expect(res.error).toBeUndefined();
    expect(res.finalText).toBe('done');
    expect(model.seen[1]).toMatch(/output limit/);
    expect(returned(res.events)[0]).toMatchObject({ status: 'error', error: { code: 'envelope_truncation_unrecoverable' } });
  });

  it('fails typed on a second truncated round, with the truncated text not as the answer', async () => {
    let ran = 0;
    const model = scripted(cut, cut);
    const res = await runChatToolLoop(opts(), { callAIWithTools: model.callAIWithTools, executeTool: async () => { ran += 1; return { content: 'x' }; } });
    expect(ran).toBe(0);
    expect(model.seen).toHaveLength(2);
    expect(res.error?.code).toBe('envelope_truncation_unrecoverable');
    expect(res.finalText).toBe('');
  });

  it('fails typed when the truncated round was the last one', async () => {
    const res = await runChatToolLoop(opts({ maxRounds: 1 }), { ...scripted(cut), executeTool: async () => ({ content: 'x' }) });
    expect(res.error?.code).toBe('envelope_truncation_unrecoverable');
  });

  it('does not retry a refused round and does not keep its text', async () => {
    let ran = 0;
    const model = scripted({ content: 'echoed prompt', toolCalls: [{ id: 'c1', name: TOOL, input: { to: 'a' } }], finishReason: 'content-filter' });
    const res = await runChatToolLoop(opts(), { callAIWithTools: model.callAIWithTools, executeTool: async () => { ran += 1; return { content: 'x' }; } });
    expect(ran).toBe(0);
    expect(model.seen).toHaveLength(1);
    expect(res.error?.code).toBe('envelope_refusal');
    expect(res.finalText).toBe('');
  });

  it('does not nudge a refused round that ended on an announcement', async () => {
    const model = scripted({ content: 'First I will send it:', toolCalls: [], finishReason: 'content-filter' });
    await runChatToolLoop(opts(), { callAIWithTools: model.callAIWithTools, executeTool: async () => ({ content: 'x' }) });
    expect(model.seen).toHaveLength(1);
  });
});

describe('arguments before gates', () => {
  it('refuses invalid arguments without holding them for approval', async () => {
    const res = await runChatToolLoop(
      opts({ capabilityScope: { enabled: [TOOL], requireApproval: [TOOL] } }),
      { ...scripted({ toolCalls: [{ id: 'c1', name: TOOL, input: {} }], finishReason: 'tool-call' }, { content: 'ok', toolCalls: [] }), executeTool: async () => ({ content: 'x' }) },
    );
    expect(res.pendingApprovals).toBeUndefined();
    expect(returned(res.events)[0]).toMatchObject({ status: 'error', error: { code: 'invalid_args' } });
  });

  it('never consults the firewall for invalid arguments', async () => {
    const evaluate = vi.fn(() => ({ decision: 'deny' as const }));
    await runChatToolLoop(
      opts({ firewall: { evaluate } }),
      { ...scripted({ toolCalls: [{ id: 'c1', name: TOOL, input: {} }], finishReason: 'tool-call' }, { content: 'ok', toolCalls: [] }), executeTool: async () => ({ content: 'x' }) },
    );
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('refuses a call the provider marked, even when its empty input would validate', async () => {
    const lax: CompiledTool = { ...tool, validate: () => ({ ok: true }) };
    let ran = 0;
    const res = await runChatToolLoop(
      opts({ tools: [lax] }),
      { ...scripted({ toolCalls: [{ id: 'c1', name: TOOL, input: {}, argumentsInvalid: true }], finishReason: 'tool-call' }, { content: 'ok', toolCalls: [] }), executeTool: async () => { ran += 1; return { content: 'x' }; } },
    );
    expect(ran).toBe(0);
    expect(returned(res.events)[0]).toMatchObject({ error: { code: 'invalid_args' } });
  });
});

describe('provider arguments', () => {
  afterEach(() => vi.restoreAllMocks());

  const round = async (args: string) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: TOOL, arguments: args } }] }, finish_reason: 'tool_calls' }],
    }), { status: 200 }));
    const r = await dispatchMiniMaxToolsRound({ model: 'm', apiKey: 'k', messages: [], tools: [{ name: TOOL, description: 'd', inputSchema: { type: 'object' } }] });
    return r.toolUses[0]!;
  };

  it.each([['{"to":"a'], ['[1]'], ['"text"'], ['7']])('marks %s', async (args) => {
    expect(await round(args)).toMatchObject({ input: {}, argumentsInvalid: true });
  });

  it.each([[''], ['  '], ['null'], ['{}']])('reads %j as no arguments', async (args) => {
    const use = await round(args);
    expect(use.input).toEqual({});
    expect(use.argumentsInvalid).toBeUndefined();
  });

  it('keeps a complete object', async () => {
    expect((await round('{"to":"a"}')).input).toEqual({ to: 'a' });
  });
});

describe('the other paths', () => {
  afterEach(() => vi.restoreAllMocks());

  it('normalizes an Anthropic refusal as a refusal', () => {
    expect(normalizeFinishReason('refusal')).toBe('content-filter');
  });

  it.each([['length'], ['content_filter']])('the bound-workflow MiniMax loop runs nothing from a %s round', async (finish_reason) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: TOOL, arguments: '' } }] }, finish_reason }],
    }), { status: 200 }));
    const onToolUse = vi.fn(async () => ({ toolUseId: 'c1', content: 'x' }));
    await dispatchMiniMaxWithTools({ provider: 'minimax', model: 'm', apiKey: 'k', messages: [{ role: 'user', content: 'go' }], tools: [], onToolUse });
    expect(onToolUse).not.toHaveBeenCalled();
  });
});

describe('every adapter hands the loop what it reads', () => {
  afterEach(() => vi.restoreAllMocks());

  it('toolRoundResult keeps the mark and normalizes the stop reason', () => {
    const toolUses = [{ id: 'c1', name: TOOL, input: {}, argumentsInvalid: true as const }];
    expect(toolRoundResult({ text: 't', toolUses, finishReason: 'length' })).toEqual({ content: 't', toolCalls: toolUses, finishReason: 'length' });
  });

  it('a truncated round reaches the loop through toolRoundResult and runs nothing', async () => {
    let ran = 0;
    const cut = toolRoundResult({ text: '', toolUses: [{ id: 'c1', name: TOOL, input: { to: 'a' } }], finishReason: 'length' });
    const res = await runChatToolLoop(opts(), { callAIWithTools: async () => cut, executeTool: async () => { ran += 1; return { content: 'x' }; } });
    expect(ran).toBe(0);
    expect(res.error?.code).toBe('envelope_truncation_unrecoverable');
  });

  it.each([
    ['max_output_tokens', 'length'],
    ['content_filter', 'content-filter'],
    ['something_new', 'length'],
  ])('an incomplete Responses round with reason %s reads as %s', async (reason, expected) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      status: 'incomplete', incomplete_details: { reason },
      output: [{ type: 'function_call', call_id: 'c1', name: TOOL, arguments: '{"to":"a"}' }],
    }), { status: 200 }));
    const round = await dispatchOpenAIToolsRound({ model: 'm', apiKey: 'k', webSearch: true, messages: [], tools: [{ name: TOOL, description: 'd', inputSchema: { type: 'object' } }] });
    expect(normalizeFinishReason(round.finishReason)).toBe(expected);
  });

  it('a complete Responses round stays unmarked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: TOOL, arguments: '{"to":"a"}' }],
    }), { status: 200 }));
    const round = await dispatchOpenAIToolsRound({ model: 'm', apiKey: 'k', webSearch: true, messages: [], tools: [{ name: TOOL, description: 'd', inputSchema: { type: 'object' } }] });
    expect(round.finishReason).toBeUndefined();
  });

  // The ADR 1011 bug: three adapters rebuilt each call as {id, name, input}, which
  // dropped the mark, and returned no stop reason. The loop's tests still passed.
  it.each([
    ['src/host/conversationToolLoop.ts'],
    ['src/aiProviders/aiProvidersHost.ts'],
    ['src/features/chat-widget/publicGateway.ts'],
  ])('%s does not rebuild tool calls field by field', (file) => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    expect(source).not.toMatch(/toolUses\.map\(\(t\) => \(\{ id: t\.id, name: t\.name, input: t\.input \}\)\)/);
  });
});
