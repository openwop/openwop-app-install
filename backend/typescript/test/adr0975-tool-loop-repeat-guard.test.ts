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
 * a failed call may be repeated; the five-call loop ends `tool_rounds_exhausted`,
 * and a turn that did say something keeps its text but still ends
 * `tool_rounds_exhausted` (CC-CHAT-1 correction, 2026-11-12). (The `continueTurn`
 * exemption for a call that reported unfinished work, ADR 0773 B.7, at
 * `agentDispatch.ts` `lastRanCall = …`, is NOT exercised here — corrected in
 * grade-tests w74, TST-DUJ2.) The exhaustion branch has a second witness:
 * `agent-dispatch-tool-loop.test.ts` "bounds the loop at maxToolRounds".
 *
 * Red when (sabotage-witnessed, w74 probes tlr-*): the repeat check is removed
 * (the tool runs five times); `lastRanCall` is never cleared by another tool; a
 * failure is remembered; the exhaustion branch is removed (the loop returns an
 * empty success); the exhaustion branch treats a preamble as an answer.
 *
 * CC-AGENT-3 cases (below): red when the read-set check is removed (the
 * alternating pair runs every round) or never cleared by a write.
 *
 * #5932 (below): since the two rules became one write-generation rule, red when a
 * write does not start a new generation, or when a repeated WRITE with only reads
 * between is re-run (the A,B,A,B write/read loop).
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
  it('the adopter-deployment loop: five identical calls run the tool ONCE and end tool_rounds_exhausted, not empty', async () => {
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

  // CC-CHAT-1 (2026-11-12) — CORRECTED: this used to pin "no exhaustion error",
  // which is the live defect: a preamble beside a tool call ("Looking…") was
  // returned as the turn's successful answer. The text is still kept (context),
  // and the turn is now the typed failure.
  it('a turn that said something keeps its text when the rounds run out, AND ends tool_rounds_exhausted', async () => {
    const callAIWithTools = async (): Promise<AiToolCallResult> => ({ content: 'Looking…', toolCalls: [{ id: 'x', name: 'candidates', input: {} }] });
    const res = await runChatToolLoop(opts(2), { callAIWithTools, executeTool: async () => ({ content: 'ok' }) });
    expect(res.finalText).toBe('Looking…');
    expect(res.error).toMatchObject({ code: TOOL_ROUNDS_EXHAUSTED });
  });
});

// CC-AGENT-3 (prod f1b882654, 2026-11-13) — the Brief Strategist alternated two
// READ tools with identical arguments for all five rounds (get-brief, validate,
// get-brief, …). Each call differed from the one before it, so the last-call
// guard never fired and the turn ended tool_rounds_exhausted.
describe('CC-AGENT-3 — a repeat of ANY read since the last write is answered, not re-run', () => {
  const effects: Record<string, 'read' | 'write'> = { 'get-brief': 'read', validate: 'read', 'generate-kernel': 'write' };
  const toolEffect = (n: string) => effects[n];
  const optsE = (maxRounds: number) => ({ ...opts(maxRounds), tools: [tool('get-brief'), tool('validate'), tool('generate-kernel')], toolEffect });
  const ran = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => (c[0] as { name: string }).name);

  it('two alternating reads run once each; the repeats get the note and the turn can answer', async () => {
    const m = scripted([{ call: 'get-brief', input: { briefId: 'b1' } }, { call: 'validate', input: { briefId: 'b1' } }, { call: 'get-brief', input: { briefId: 'b1' } }, { call: 'validate', input: { briefId: 'b1' } }, { text: 'Valid; ready to generate.' }]);
    const executeTool = vi.fn().mockResolvedValue({ content: '{"valid":true}' });
    const res = await runChatToolLoop(optsE(6), { callAIWithTools: m.callAIWithTools, executeTool });
    expect(ran(executeTool)).toEqual(['get-brief', 'validate']);
    expect(lastUser(m.seen[3]!)).toBe(repeatedCallNote('get-brief'));
    expect(lastUser(m.seen[4]!)).toBe(repeatedCallNote('validate'));
    expect(res.finalText).toBe('Valid; ready to generate.');
    expect(res.error).toBeUndefined();
  });

  it('a write in between clears it: the same read after the write runs again', async () => {
    const m = scripted([{ call: 'get-brief', input: { briefId: 'b1' } }, { call: 'validate', input: { briefId: 'b1' } }, { call: 'generate-kernel', input: { briefId: 'b1' } }, { call: 'get-brief', input: { briefId: 'b1' } }, { text: 'Started.' }]);
    const executeTool = vi.fn().mockResolvedValue({ content: 'ok' });
    await runChatToolLoop(optsE(6), { callAIWithTools: m.callAIWithTools, executeTool });
    expect(ran(executeTool)).toEqual(['get-brief', 'validate', 'generate-kernel', 'get-brief']);
  });

  it('a read with different arguments still runs', async () => {
    const m = scripted([{ call: 'get-brief', input: { briefId: 'b1' } }, { call: 'validate', input: { briefId: 'b1' } }, { call: 'get-brief', input: { briefId: 'b2' } }, { text: 'Done.' }]);
    const executeTool = vi.fn().mockResolvedValue({ content: 'ok' });
    await runChatToolLoop(optsE(6), { callAIWithTools: m.callAIWithTools, executeTool });
    expect(ran(executeTool)).toEqual(['get-brief', 'validate', 'get-brief']);
  });

  it('a tool with no known effect (MCP, unregistered) keeps the last-call rule only', async () => {
    const m = scripted([{ call: 'candidates' }, { call: 'factory.run' }, { call: 'candidates' }, { text: 'ok' }]);
    const executeTool = vi.fn().mockResolvedValue({ content: 'ok' });
    await runChatToolLoop({ ...opts(6), toolEffect: () => undefined }, { callAIWithTools: m.callAIWithTools, executeTool });
    expect(ran(executeTool)).toEqual(['candidates', 'factory.run', 'candidates']);
  });
});

// #5932 (casavoga-prod 370f6666) — A,B,A,B with one write and one read ran every
// round: the write cleared the read set, and each call differed from the one
// before it. A repeat now runs only if something wrote since it last ran.
describe('#5932 — a repeat runs again only after a write since it last ran', () => {
  const effects: Record<string, 'read' | 'write'> = { 'save-offer': 'write', 'get-offer': 'read', 'set-status': 'write' };
  const optsE = (maxRounds: number) => ({ ...opts(maxRounds), tools: [tool('save-offer'), tool('get-offer'), tool('set-status')], toolEffect: (n: string) => effects[n] });
  const ran = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => (c[0] as { name: string }).name);

  it('write, read, write, read with the same arguments runs each once, and the turn can answer', async () => {
    const m = scripted([{ call: 'save-offer', input: { id: 'o1' } }, { call: 'get-offer', input: { id: 'o1' } }, { call: 'save-offer', input: { id: 'o1' } }, { call: 'get-offer', input: { id: 'o1' } }, { text: 'Saved.' }]);
    const executeTool = vi.fn().mockResolvedValue({ content: 'ok' });
    const res = await runChatToolLoop(optsE(6), { callAIWithTools: m.callAIWithTools, executeTool });
    expect(ran(executeTool)).toEqual(['save-offer', 'get-offer']);
    expect(lastUser(m.seen[3]!)).toBe(repeatedCallNote('save-offer'));
    expect(lastUser(m.seen[4]!)).toBe(repeatedCallNote('get-offer'));
    expect(res.finalText).toBe('Saved.');
    expect(res.error).toBeUndefined();
  });

  it('a different write in between starts a new generation: the same write runs again', async () => {
    const m = scripted([{ call: 'save-offer', input: { id: 'o1' } }, { call: 'set-status', input: { id: 'o1', s: 'sent' } }, { call: 'save-offer', input: { id: 'o1' } }, { text: 'Done.' }]);
    const executeTool = vi.fn().mockResolvedValue({ content: 'ok' });
    await runChatToolLoop(optsE(6), { callAIWithTools: m.callAIWithTools, executeTool });
    expect(ran(executeTool)).toEqual(['save-offer', 'set-status', 'save-offer']);
  });

  it('a failed write still starts a new generation (it may have half-applied)', async () => {
    const m = scripted([{ call: 'get-offer', input: { id: 'o1' } }, { call: 'save-offer', input: { id: 'o1' } }, { call: 'get-offer', input: { id: 'o1' } }, { text: 'Retried.' }]);
    const executeTool = vi.fn()
      .mockResolvedValueOnce({ content: 'ok' })
      .mockResolvedValueOnce({ content: 'tool_execution_failed: conflict', isError: true })
      .mockResolvedValueOnce({ content: 'ok' });
    await runChatToolLoop(optsE(6), { callAIWithTools: m.callAIWithTools, executeTool });
    expect(ran(executeTool)).toEqual(['get-offer', 'save-offer', 'get-offer']);
  });
});
