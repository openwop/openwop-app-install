/**
 * ADR 0975 D6 — the chat tool loop does not spin on an identical call, and a
 * turn that runs out of rounds without an answer is a typed failure.
 *
 * MEASURED on kicktodo.com (2026-10-25): the Studio's Challenge Author, on the
 * managed model, called `openwop:kicktodo.candidates` five times with identical
 * arguments, spent every round, and the turn ended with an EMPTY reply — the
 * chat showed "No response from this advisor", an empty success.
 *
 * Pins: an identical repeat of the last call that RAN is answered with a note,
 * not re-executed; a different call in between (a read after a write) runs again;
 * a failed call, and a call that reported unfinished work (ADR 0773 B.7), may be
 * repeated; the five-call loop ends `tool_rounds_exhausted`, while a turn that
 * did say something keeps its text.
 *
 * Red when (sabotage-witnessed): the repeat check is removed (the tool runs five
 * times); `lastRanCall` is never cleared by another tool; a failure is remembered;
 * the exhaustion branch is removed (the loop returns an empty success).
 */
import { describe, expect, it, vi } from 'vitest';
import { runChatToolLoop, repeatedCallNote, TOOL_ROUNDS_EXHAUSTED, type CompiledTool } from '../src/host/agentDispatch.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';

const tool = (name: string): CompiledTool => ({ def: { name, description: name, inputSchema: { type: 'object' } }, validate: () => ({ ok: true }) });
const opts = (maxRounds: number) => ({
  provider: 'p', model: 'm', credentialRef: 'r', systemPrompt: 'sp',
  messages: [{ role: 'user' as const, content: 'make the challenge' }],
  tools: [tool('candidates'), tool('factory.run')], agentId: 'a', persona: 'Author', maxRounds,
});
type Step = { call: string; input?: Record<string, unknown> } | { text: string };
function scripted(script: Step[]) {
  const seen: AiToolCallRequest[] = [];
  let i = 0;
  const callAIWithTools = async (r: AiToolCallRequest): Promise<AiToolCallResult> => {
    seen.push(r);
    const step = script[Math.min(i, script.length - 1)]!;
    i += 1;
    return 'call' in step
      ? { content: '', toolCalls: [{ id: `c${i}`, name: step.call, input: step.input ?? {} }] }
      : { content: step.text, toolCalls: [] };
  };
  return { callAIWithTools, seen };
}
const lastUser = (r: AiToolCallRequest): string => {
  const m = [...r.messages].reverse().find((x) => x.role === 'user');
  return typeof m?.content === 'string' ? m.content : '';
};

describe('ADR 0975 D6 — the repeat guard', () => {
  it('the kicktodo.com loop: five identical calls run the tool ONCE and end tool_rounds_exhausted, not empty', async () => {
    const m = scripted([{ call: 'candidates' }]);
    const executeTool = vi.fn().mockResolvedValue({ content: '{"candidates":[]}' });
    const res = await runChatToolLoop(opts(5), { callAIWithTools: m.callAIWithTools, executeTool });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(lastUser(m.seen[2]!)).toBe(repeatedCallNote('candidates'));
    expect(res.finalText).toBe('');
    expect(res.error).toMatchObject({ code: TOOL_ROUNDS_EXHAUSTED });
  });

  it('a different call in between clears it: a read after a write runs again', async () => {
    const m = scripted([{ call: 'candidates' }, { call: 'factory.run', input: { topic: 'walk' } }, { call: 'candidates' }, { text: 'Started.' }]);
    const executeTool = vi.fn().mockResolvedValue({ content: 'ok' });
    const res = await runChatToolLoop(opts(6), { callAIWithTools: m.callAIWithTools, executeTool });
    expect(executeTool.mock.calls.map((c) => (c[0] as { name: string }).name)).toEqual(['candidates', 'factory.run', 'candidates']);
    expect(res.finalText).toBe('Started.');
    expect(res.error).toBeUndefined();
  });

  it('a failed call may be retried as-is (a transient failure is not an answer)', async () => {
    const m = scripted([{ call: 'candidates' }, { call: 'candidates' }, { text: 'Here they are.' }]);
    const executeTool = vi.fn()
      .mockResolvedValueOnce({ content: 'tool_execution_failed: timeout', isError: true })
      .mockResolvedValueOnce({ content: '{"candidates":[]}' });
    const res = await runChatToolLoop(opts(5), { callAIWithTools: m.callAIWithTools, executeTool });
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(res.finalText).toBe('Here they are.');
  });

  it('a turn that said something keeps its text when the rounds run out (no exhaustion error)', async () => {
    const callAIWithTools = async (): Promise<AiToolCallResult> => ({ content: 'Looking…', toolCalls: [{ id: 'x', name: 'candidates', input: {} }] });
    const res = await runChatToolLoop(opts(2), { callAIWithTools, executeTool: async () => ({ content: 'ok' }) });
    expect(res.finalText).toBe('Looking…');
    expect(res.error).toBeUndefined();
  });
});
