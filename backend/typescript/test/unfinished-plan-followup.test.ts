/**
 * ADR 0773 B.7 — the chat loop's unfinished-work follow-up.
 *
 * MEASURED (managed tier, 3 quiet runs): a Pair first draft planned 7 ops,
 * drew 2, and the turn ended in 2 of 3 runs. A tool that tracks unfinished
 * work returns `continueTurn`; when the model then stops without a call, the
 * loop sends that text once (twice at most per turn) and grants the rounds to
 * act on it. These drive the REAL `runChatToolLoop` with a scripted model.
 */
import { describe, expect, it } from 'vitest';
import { runChatToolLoop, MAX_CONTINUATIONS, CONTINUATION_ROUNDS, type CompiledTool } from '../src/host/agentDispatch.js';
import type { AiToolCallRequest, AiToolCallResult } from '../src/executor/types.js';

const draw: CompiledTool = { def: { name: 'draw', description: 'draw', inputSchema: { type: 'object' } }, validate: () => ({ ok: true }) };
const NUDGE = 'You planned 7 ops and have drawn 2. Draw the next batch now.';

/** A model that follows `script`: each entry is either a tool call or a final text. */
function scripted(script: Array<'call' | string>) {
  const seen: AiToolCallRequest[] = [];
  let i = 0;
  const callAIWithTools = async (r: AiToolCallRequest): Promise<AiToolCallResult> => {
    seen.push(r);
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return step === 'call' ? { content: '', toolCalls: [{ id: `c${i}`, name: 'draw', input: {} }] } : { content: step!, toolCalls: [] };
  };
  return { callAIWithTools, seen, calls: () => i };
}

const lastUser = (r: AiToolCallRequest): string => {
  const m = [...r.messages].reverse().find((x) => x.role === 'user');
  return typeof m?.content === 'string' ? m.content : '';
};

const opts = { provider: 'p', model: 'm', credentialRef: 'r', systemPrompt: 'sp', messages: [{ role: 'user' as const, content: 'draft it' }], tools: [draw], agentId: 'a', persona: 'P' };

describe('unfinished-work follow-up (ADR 0773 B.7)', () => {
  it('a stop with work pending gets the tool\'s own follow-up, and the turn continues until the work reports done', async () => {
    const m = scripted(['call', 'Batch 2: the If branch.', 'call', 'Done.']);
    let n = 0;
    const executeTool = async () => { n += 1; return { content: 'ok', continueTurn: n === 1 ? NUDGE : null }; };
    const res = await runChatToolLoop(opts, { callAIWithTools: m.callAIWithTools, executeTool });
    expect(m.calls()).toBe(4);
    expect(lastUser(m.seen[2]!)).toBe(NUDGE); // the 3rd model call carries the follow-up
    expect(res.finalText).toBe('Done.');
  });

  it('a second stop with NO call in between still gets the second follow-up: the work is still unfinished', async () => {
    // MEASURED 2026-10-05 (managed tier, case 4): the model answered the first
    // follow-up with "Drawing ops 3–5 now." and no call. Sending the follow-up
    // used to disarm it, and only a fresh tool result re-armed it, so the
    // second of MAX_CONTINUATIONS could never fire on exactly this failure.
    const m = scripted(['call', 'Batch 2 next.', 'Drawing ops 3–5 now.', 'call', 'Done.']);
    let n = 0;
    const res = await runChatToolLoop(opts, {
      callAIWithTools: m.callAIWithTools,
      executeTool: async () => { n += 1; return { content: 'ok', continueTurn: n === 1 ? NUDGE : null }; },
    });
    expect(m.seen.filter((r) => lastUser(r) === NUDGE).length).toBe(2);
    expect(m.calls()).toBe(5);
    expect(res.finalText).toBe('Done.');
  });

  it('no follow-up when the work is finished (null) or never reported', async () => {
    for (const cont of [null, undefined]) {
      const m = scripted(['call', 'All drawn.']);
      const res = await runChatToolLoop(opts, { callAIWithTools: m.callAIWithTools, executeTool: async () => ({ content: 'ok', ...(cont === undefined ? {} : { continueTurn: cont }) }) });
      expect(m.calls()).toBe(2);
      expect(res.finalText).toBe('All drawn.');
    }
  });

  it('a failed tool call does not arm it', async () => {
    const m = scripted(['call', 'Stopping.']);
    await runChatToolLoop(opts, { callAIWithTools: m.callAIWithTools, executeTool: async () => ({ content: 'boom', isError: true, continueTurn: NUDGE }) });
    expect(m.calls()).toBe(2);
  });

  it(`is bounded: at most ${MAX_CONTINUATIONS} follow-ups per turn, even if the work never finishes`, async () => {
    const m = scripted(['call', 'stop', 'call', 'stop', 'call', 'stop', 'call', 'stop']);
    await runChatToolLoop(opts, { callAIWithTools: m.callAIWithTools, executeTool: async () => ({ content: 'ok', continueTurn: NUDGE }) });
    const followUps = m.seen.filter((r) => lastUser(r) === NUDGE).length;
    expect(followUps).toBe(MAX_CONTINUATIONS);
  });

  it(`grants rounds to act on it: a stop on the LAST round still gets its follow-up (budget +${CONTINUATION_ROUNDS})`, async () => {
    // maxRounds 2: round 1 draws, round 2 stops with work pending. Without the
    // extra rounds the loop would end there with the plan unfinished.
    const m = scripted(['call', 'stop', 'call', 'Done.']);
    let n = 0;
    const res = await runChatToolLoop({ ...opts, maxRounds: 2 }, {
      callAIWithTools: m.callAIWithTools,
      executeTool: async () => { n += 1; return { content: 'ok', continueTurn: n === 1 ? NUDGE : null }; },
    });
    expect(m.calls()).toBe(4);
    expect(res.finalText).toBe('Done.');
  });
});
