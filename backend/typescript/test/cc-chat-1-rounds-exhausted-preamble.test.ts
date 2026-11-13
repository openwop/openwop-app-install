/**
 * CC-CHAT-1 — a chat turn that runs out of tool rounds while the model is still
 * calling tools is a TYPED failure, even when a round carried text.
 *
 * Observed live on app.openwop.dev (build 373d4863a, 2026-11-12 02:00–02:03Z,
 * Anthropic Claude Sonnet 5.5, Campaign Brief Strategist): asked to regenerate
 * a messaging kernel, the agent spent the turn on reads ("10 reads" — two calls
 * a round over the default five rounds), and the turn ended on its own
 * preamble, "I'm calling get-brief and validate myself now. I'll start
 * generation once they return." — rendered as a successful answer. Nothing was
 * generated and nothing reported that. Reproduced twice in a row.
 *
 * Mechanism: `lastText` is overwritten by every round's content, including the
 * text a model emits BESIDE its tool calls; the ADR 0975 D6 exhaustion branch
 * fired only when that text was empty. A preamble written next to a tool call is
 * by construction not an answer to the turn.
 *
 * Pins: out of rounds with the last round still calling tools ⇒
 * `tool_rounds_exhausted`, the text kept for context; controls — a turn whose
 * model stops calling tools answers normally; a deferred approval still counts
 * as answered; structured data still counts as answered.
 *
 * Sabotage witness: restore the `!lastText.trim()` condition on the exhaustion
 * branch ⇒ "the live shape" goes red (no error, the preamble is a success).
 */
import { describe, expect, it } from 'vitest';
import { runChatToolLoop, TOOL_ROUNDS_EXHAUSTED, type CompiledTool } from '../src/host/agentDispatch.js';
import type { AiToolCallResult } from '../src/executor/types.js';

const tool = (name: string): CompiledTool => ({ def: { name, description: name, inputSchema: { type: 'object' } }, validate: () => ({ ok: true }) });
const opts = {
  provider: 'anthropic', model: 'claude-sonnet-5-5', credentialRef: 'anthropic:anthropic', systemPrompt: 'sp',
  messages: [{ role: 'user' as const, content: 'Regenerate the messaging kernel for brief ec05a8a9.' }],
  tools: [tool('campaign-brief.get-brief'), tool('campaign-brief.validate'), tool('campaign-brief.generate-kernel')],
  agentId: 'brief-strategist', persona: 'Brief Strategist',
};
const PREAMBLE = "I'm calling get-brief and validate myself now. I'll start generation once they return.";

describe('CC-CHAT-1 — rounds exhausted mid-plan is not an answer', () => {
  it('the live shape: every round is a preamble + two reads; the turn ends tool_rounds_exhausted, not a success', async () => {
    let n = 0;
    const callAIWithTools = async (): Promise<AiToolCallResult> => {
      n += 1;
      return {
        content: PREAMBLE,
        toolCalls: [
          { id: `g${n}`, name: 'campaign-brief.get-brief', input: { briefId: 'ec05a8a9', n } },
          { id: `v${n}`, name: 'campaign-brief.validate', input: { briefId: 'ec05a8a9', n } },
        ],
        finishReason: 'tool-call',
      };
    };
    let executed = 0;
    const res = await runChatToolLoop({ ...opts }, { callAIWithTools, executeTool: async () => { executed += 1; return { content: '{"ok":true}' }; } });
    expect(executed).toBe(10); // "10 reads", as the chat showed
    expect(res.error).toMatchObject({ code: TOOL_ROUNDS_EXHAUSTED });
    expect(res.error?.message).toContain('Brief Strategist');
    expect(res.finalText).toBe(PREAMBLE); // kept for context, never presented as success
  });

  it('control: a model that stops calling tools answers normally', async () => {
    let n = 0;
    const callAIWithTools = async (): Promise<AiToolCallResult> => {
      n += 1;
      return n === 1
        ? { content: PREAMBLE, toolCalls: [{ id: 'g', name: 'campaign-brief.get-brief', input: {} }], finishReason: 'tool-call' }
        : { content: 'The kernel is waiting for your approval.', toolCalls: [], finishReason: 'stop' };
    };
    const res = await runChatToolLoop({ ...opts }, { callAIWithTools, executeTool: async () => ({ content: '{}' }) });
    expect(res.error).toBeUndefined();
    expect(res.finalText).toBe('The kernel is waiting for your approval.');
  });

  it('control: structured data from the last round still counts as an answer', async () => {
    let n = 0;
    const callAIWithTools = async (): Promise<AiToolCallResult> => { n += 1; return { content: PREAMBLE, data: { kernel: 'draft' }, toolCalls: [{ id: `g${n}`, name: 'campaign-brief.get-brief', input: { n } }], finishReason: 'tool-call' }; };
    const res = await runChatToolLoop({ ...opts, maxRounds: 2 }, { callAIWithTools, executeTool: async () => ({ content: '{}' }) });
    expect(res.error).toBeUndefined();
  });
});
