/**
 * CC-CHAN-1 — a refused tool is not re-run for the rest of the turn, and every
 * refusal the loop records names its reason.
 *
 * Observed live on 373d4863a (2026-11-12 02:45Z, 02:52–02:54Z): the Channel
 * Generator called `openwop:campaign-channels.generate` five times; each call
 * was refused by the plan (`forbidden`, reason `not_entitled`) and the turn
 * ended `tool_rounds_exhausted` without the model telling the user why. The
 * gate refusals the loop itself records (`status:'forbidden'`) carried no
 * reason at all, so a reader of the run could not tell an allowlist miss from a
 * firewall denial.
 *
 * Pins: a plan refusal blocks later calls to that tool whatever the arguments
 * (one execution, then `repeated_refusal`); a plain `forbidden` blocks only an
 * identical repeat; an allowlist miss is recorded as `not_on_allowlist`.
 *
 * Sabotage witnesses: never record refusals ⇒ "a plan-refused tool runs once"
 * goes red (5 executions); drop the reason from the allowlist refusal ⇒
 * "an allowlist miss names its reason" goes red.
 */
import { describe, expect, it } from 'vitest';
import { runChatToolLoop, refusalOf, type CompiledTool } from '../src/host/agentDispatch.js';
import type { AiToolCallResult } from '../src/executor/types.js';

const tool = (name: string): CompiledTool => ({ def: { name, description: name, inputSchema: { type: 'object' } }, validate: () => ({ ok: true }) });
const GEN = 'openwop:campaign-channels.generate';
const opts = {
  provider: 'anthropic', model: 'claude-sonnet-5-5', credentialRef: 'r', systemPrompt: 'sp',
  messages: [{ role: 'user' as const, content: 'Generate the email sequence.' }],
  tools: [tool(GEN), tool('openwop:campaign-channels.channels')], agentId: 'channel-generator', persona: 'Channel Generator',
};
const PLAN_REFUSAL = JSON.stringify({ reason: 'not_entitled', feature: 'campaign-channels', error: 'forbidden', message: "This workflow belongs to a feature this workspace's plan does not include, so it was not started." });
type Ev = { type: string; toolName?: string; status?: string; error?: { code?: string } };

describe('CC-CHAN-1 — refusals in the chat tool loop', () => {
  it('a plan-refused tool runs once; later calls (any arguments) are answered from the refusal', async () => {
    let n = 0;
    const callAIWithTools = async (): Promise<AiToolCallResult> => {
      n += 1;
      return n <= 5
        ? { content: '', toolCalls: [{ id: `c${n}`, name: GEN, input: { briefId: 'b', channel: n % 2 ? 'email_sequence' : 'landing_page' } }], finishReason: 'tool-call' }
        : { content: 'Your plan does not include Campaign Channels.', toolCalls: [], finishReason: 'stop' };
    };
    let executed = 0;
    const res = await runChatToolLoop({ ...opts, maxRounds: 8 }, { callAIWithTools, executeTool: async () => { executed += 1; return { content: PLAN_REFUSAL, isError: true }; } });
    expect(executed).toBe(1);
    const returns = (res.events as Ev[]).filter((e) => e.type === 'agent.toolReturned' && e.toolName === GEN);
    expect(returns).toHaveLength(5);
    expect(returns.slice(1).every((e) => e.status === 'forbidden' && e.error?.code === 'repeated_refusal')).toBe(true);
    expect(res.finalText).toBe('Your plan does not include Campaign Channels.');
  });

  it('a plain forbidden blocks only an identical repeat (another argument may be allowed)', () => {
    expect(refusalOf('forbidden', JSON.stringify({ error: 'forbidden', message: 'You need write access to this brief.' }))).toEqual({ code: 'forbidden', toolWide: false });
    expect(refusalOf('forbidden', PLAN_REFUSAL)).toEqual({ code: 'not_entitled', toolWide: true });
    expect(refusalOf('validation_error', '{}')).toBeNull();
  });

  it('an allowlist miss names its reason on the recorded refusal', async () => {
    let n = 0;
    const callAIWithTools = async (): Promise<AiToolCallResult> => {
      n += 1;
      return n === 1
        ? { content: '', toolCalls: [{ id: 'x', name: 'openwop:not-mine', input: {} }], finishReason: 'tool-call' }
        : { content: 'done', toolCalls: [], finishReason: 'stop' };
    };
    const res = await runChatToolLoop({ ...opts }, { callAIWithTools, executeTool: async () => ({ content: '{}' }) });
    const refused = (res.events as Ev[]).find((e) => e.type === 'agent.toolReturned' && e.toolName === 'openwop:not-mine');
    expect(refused).toMatchObject({ status: 'forbidden', error: { code: 'not_on_allowlist' } });
  });
});
