/**
 * The model's own tool calls are in the transcript before their results.
 *
 * casavoga-prod, 2026-11-13, three runs in a row: a person approved a gated
 * tool, the agent called it in a round with no text, and the next round read
 * only `Result of <tool>: …` as a user message. The agent then said it had made
 * no call and the result was "pasted". The loop recorded an assistant turn only
 * when the round had text.
 *
 * Red when: a text-less round records nothing before its results; a round's
 * text and its calls split into two assistant turns or lose their order; the
 * turn carries an argument value (a visitor's email: ADR 0470's no-PII-echo
 * boundary, caught by train 270); or two runs of the same scripted rounds send
 * different messages (replay serves rounds by a digest over the messages, ADR
 * 1002).
 */
import { describe, it, expect } from 'vitest';
import { runChatToolLoop, toolCallTurn, type CompiledTool, type ChatToolLoopOpts } from '../src/host/agentDispatch.js';
import type { AiCallMessage, AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';

function tool(name: string): CompiledTool {
  return { def: { name, description: name, inputSchema: { type: 'object', additionalProperties: true } }, validate: () => ({ ok: true }) };
}
const TOOLS = [tool('catalog.label-run'), tool('kb.search')];
const executeTool = async (c: { name: string }) => ({ content: `run started: run-7 (${c.name})` });

function opts(extra: Partial<ChatToolLoopOpts> = {}): ChatToolLoopOpts {
  return {
    provider: 'p', model: 'm', credentialRef: 'byok:k', systemPrompt: 's',
    messages: [{ role: 'user', content: 'Approved — go ahead.' }],
    tools: TOOLS, agentId: 'a', persona: 'P', maxRounds: 3, ...extra,
  };
}

/** Scripted rounds; records the messages each round was sent. */
function scripted(first: AiToolCallResult) {
  const sent: AiCallMessage[][] = [];
  let n = 0;
  const callAIWithTools = async (r: AiToolCallRequest): Promise<AiToolCallResult> => {
    sent.push(r.messages.map((m) => ({ ...m })));
    n += 1;
    return n === 1 ? first : { content: 'Started the label run.', toolCalls: [] };
  };
  return { sent, callAIWithTools };
}

describe('the tool loop records the model\'s calls before their results', () => {
  it('an approved gated tool, re-called in a round with no text: the call turn precedes its result', async () => {
    const s = scripted({ content: '', toolCalls: [{ id: '1', name: 'catalog.label-run', input: { catalogId: 'c-9' } }], finishReason: 'tool-call' });
    // Approved: the tool is enabled and no longer requires approval.
    const res = await runChatToolLoop(opts({ capabilityScope: { enabled: ['catalog.label-run', 'kb.search'], requireApproval: [] } }), { callAIWithTools: s.callAIWithTools, executeTool });
    expect(res.pendingApprovals).toBeUndefined();
    expect(s.sent[1]).toEqual([
      { role: 'user', content: 'Approved — go ahead.' },
      { role: 'assistant', content: 'Called catalog.label-run.' },
      { role: 'user', content: expect.stringMatching(/^Result of catalog\.label-run: /) },
    ]);
  });

  it('a round with text and two calls: one assistant turn, text first, calls in order', async () => {
    const s = scripted({
      content: 'Checking two things.',
      toolCalls: [{ id: '1', name: 'kb.search', input: { q: 'a' } }, { id: '2', name: 'catalog.label-run', input: {} }],
      finishReason: 'tool-call',
    });
    await runChatToolLoop(opts(), { callAIWithTools: s.callAIWithTools, executeTool });
    const second = s.sent[1]!;
    expect(second[1]).toEqual({ role: 'assistant', content: 'Checking two things.\n\nCalled kb.search.\n\nCalled catalog.label-run.' });
    expect(second.slice(2).map((m) => String(m.content).split(':')[0])).toEqual(['Result of kb.search', 'Result of catalog.label-run']);
  });

  it('the same scripted rounds send byte-identical messages twice (replay digests match)', async () => {
    const first: AiToolCallResult = { content: '', toolCalls: [{ id: '1', name: 'kb.search', input: { q: 'x', n: 2 } }], finishReason: 'tool-call' };
    const a = scripted(first);
    const b = scripted(first);
    await runChatToolLoop(opts(), { callAIWithTools: a.callAIWithTools, executeTool });
    await runChatToolLoop(opts(), { callAIWithTools: b.callAIWithTools, executeTool });
    expect(JSON.stringify(b.sent)).toBe(JSON.stringify(a.sent));
  });
});

describe('toolCallTurn', () => {
  it('never carries an argument value, on any call', async () => {
    const s = scripted({
      content: '',
      toolCalls: [
        { id: '1', name: 'kb.search', input: { email: 'jane@example.com', note: 'sk-live-SECRET', nested: { phone: '+1 555 0100' } } },
        { id: '2', name: 'catalog.label-run', input: { name: 'Jane Doe' } },
      ],
      finishReason: 'tool-call',
    });
    await runChatToolLoop(opts(), { callAIWithTools: s.callAIWithTools, executeTool });
    const turn = s.sent[1]![1]!;
    expect(turn).toEqual({ role: 'assistant', content: 'Called kb.search.\n\nCalled catalog.label-run.' });
    for (const v of ['jane@example.com', 'sk-live-SECRET', '555 0100', 'Jane Doe']) expect(JSON.stringify(turn)).not.toContain(v);
  });

  it('a round with no calls and no text adds nothing', () => {
    expect(toolCallTurn('', [])).toBe('');
  });
});
