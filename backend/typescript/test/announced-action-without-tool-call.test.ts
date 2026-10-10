/**
 * ADR 0796 — a reply that announces an action and calls no tool gets ONE
 * host follow-up instead of ending the turn. Pins the trigger (a trailing
 * colon, tools offered, a round left), the once-per-turn bound, and that an
 * ordinary final answer is untouched.
 */
import { describe, expect, it } from 'vitest';
import { ANNOUNCED_WITHOUT_CALL_NUDGE, endsOnAnnouncement, runChatToolLoop, type CompiledTool } from '../src/host/agentDispatch.js';

const TOOL: CompiledTool = {
  def: { name: 'feature.x.draw', description: 'draw', inputSchema: { type: 'object', properties: {} } },
  validate: () => ({ ok: true }),
};

type Reply = { content: string; toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> };

async function run(replies: Reply[], over: { tools?: CompiledTool[]; maxRounds?: number } = {}) {
  const seen: string[][] = [];
  const executed: string[] = [];
  let call = 0;
  const result = await runChatToolLoop(
    {
      provider: 'mock', model: 'm', credentialRef: '', systemPrompt: 's',
      messages: [{ role: 'user', content: 'draft it' }],
      tools: over.tools ?? [TOOL], agentId: 'a1', persona: 'Probe',
      ...(over.maxRounds ? { maxRounds: over.maxRounds } : {}),
    },
    {
      callAIWithTools: async (req) => {
        seen.push(req.messages.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : ''}`));
        return replies[Math.min(call++, replies.length - 1)]!;
      },
      executeTool: async (call) => { executed.push(call.name); return { content: 'ok' }; },
    },
  );
  return { result, seen, executed };
}

describe('endsOnAnnouncement', () => {
  it('matches only a trailing colon', () => {
    expect(endsOnAnnouncement('First batch — add the trigger:')).toBe(true);
    expect(endsOnAnnouncement('Suggesting now:\n')).toBe(true);
    expect(endsOnAnnouncement('I left the gate as it is.')).toBe(false);
    expect(endsOnAnnouncement('Which matters more: speed or accuracy?')).toBe(false);
    expect(endsOnAnnouncement('')).toBe(false);
    expect(endsOnAnnouncement(undefined)).toBe(false);
  });
});

describe('the announced-action follow-up (ADR 0796)', () => {
  it('asks once, and the tool call the model then makes is executed', async () => {
    const { result, seen, executed } = await run([
      { content: 'Let me draw this in batches:', toolCalls: [] },
      { content: '', toolCalls: [{ id: 'c1', name: 'feature.x.draw', input: {} }] },
      { content: 'Drew the first batch.', toolCalls: [] },
    ]);
    expect(executed).toEqual(['feature.x.draw']);
    expect(result.finalText).toBe('Drew the first batch.');
    expect(result.rounds).toBe(3);
    expect(seen[1]!.at(-1)).toBe(`user:${ANNOUNCED_WITHOUT_CALL_NUDGE}`);
    expect(seen[1]!.at(-2)).toBe('assistant:Let me draw this in batches:');
  });

  it('fires at most once per turn — a second announcement is the final answer', async () => {
    const { result, seen } = await run([{ content: 'Suggesting now:', toolCalls: [] }]);
    expect(result.rounds).toBe(2);
    expect(result.finalText).toBe('Suggesting now:');
    expect(seen.flat().filter((m) => m === `user:${ANNOUNCED_WITHOUT_CALL_NUDGE}`)).toHaveLength(1);
  });

  it('leaves an ordinary final answer alone', async () => {
    const { result } = await run([{ content: 'Done. Nothing else to change.', toolCalls: [] }]);
    expect(result.rounds).toBe(1);
  });

  it('does not fire when no tools were offered', async () => {
    const { result } = await run([{ content: 'Here is the plan:', toolCalls: [] }], { tools: [] });
    expect(result.rounds).toBe(1);
  });

  it('does not fire on the last round', async () => {
    const { result } = await run([{ content: 'Suggesting now:', toolCalls: [] }], { maxRounds: 1 });
    expect(result.rounds).toBe(1);
  });
});
