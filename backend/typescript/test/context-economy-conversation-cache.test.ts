/**
 * ADR 1003 D3 — the conversation cache breakpoint: where it goes, when it goes,
 * and that it never reaches the ADR 1002 replay digest.
 *
 * A2 marked only tools and system, so each tool-loop round re-billed the whole
 * conversation (prod, 7 days: about 2.8% of managed tools-round prompt tokens
 * were cache reads). D3 marks the LAST message, but only on a round after the
 * first, because that is the only place the prefix is guaranteed to repeat:
 * marking every request pays a 1.25× write each exchange that a per-turn
 * system prompt never reads back (ADR 1003 B1/B2).
 *
 * Covered here, against the REAL Anthropic dispatchers with `fetch` stubbed:
 *  - the helper: string → one marked text block; blocks → marker on the last;
 *    empty → unmarked; never mutates;
 *  - `dispatchAnthropicToolsRound`: no marker without the lever, without the
 *    hint, or on the first round; with both, the last message is marked and the
 *    request carries at most 4 breakpoints; off ⇒ the body is byte-identical
 *    to a request that never heard of D3;
 *  - `dispatchAnthropicWithTools` (the multi-round node loop): round 1 unmarked,
 *    round 2 marked on the tool_result message.
 * The digest half (the hint is outside the preimage) lives in
 * `context-economy-conversation-cache-replay.test.ts`, which mocks the
 * dispatcher this file exercises for real.
 *
 * Sabotage (witnessed 2026-10-29): marking regardless of the hint reds the
 * "first round" cases; dropping the lever check reds "lever off"; marking the
 * FIRST message instead of the last reds the placement case; mutating the
 * caller's message reds the non-mutation case.
 * Re-witnessed 2026-11-03 (w81): marking every block of the last message, ignoring
 * `enabled`, marking an empty final message, and the node loop marking round 1 or
 * never marking round 2 each red their case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAnthropicMessageCache } from '../src/providers/promptCaching.js';
import { dispatchAnthropicToolsRound, dispatchAnthropicWithTools } from '../src/providers/dispatchAnthropicTools.js';

const ENV_KEYS = ['OPENWOP_CONTEXT_ECONOMY', 'OPENWOP_CONTEXT_ECONOMY_PROVIDER_CACHE', 'OPENWOP_CONTEXT_ECONOMY_CONVERSATION_CACHE'];
const saved: Record<string, string | undefined> = {};
let bodies: Array<Record<string, unknown>> = [];
/** Scripted Anthropic replies, consumed in order; the last repeats. */
let replies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  bodies = [];
  replies = [{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const reply = replies.length > 1 ? replies.shift()! : replies[0];
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

/** Every `cache_control` in a request body, by JSON path. */
function breakpoints(v: unknown, at = '$', out: string[] = []): string[] {
  if (Array.isArray(v)) { v.forEach((x, i) => breakpoints(x, `${at}[${i}]`, out)); return out; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'cache_control') out.push(at); else breakpoints(x, `${at}.${k}`, out);
    }
  }
  return out;
}

const ROUND = {
  model: 'claude-test', apiKey: 'sk-test',
  messages: [
    { role: 'system' as const, content: 'You help.' },
    { role: 'user' as const, content: 'first question' },
    { role: 'assistant' as const, content: 'calling a tool' },
    { role: 'user' as const, content: 'TOOL RESULT: 42' },
  ],
  tools: [{ name: 'lookup', description: 'Look up', inputSchema: { type: 'object', properties: {} } }],
};

describe('withAnthropicMessageCache', () => {
  it('a string last message becomes one marked text block; earlier messages untouched', () => {
    const msgs = [{ role: 'user' as const, content: 'a' }, { role: 'assistant' as const, content: 'b' }];
    const out = withAnthropicMessageCache(msgs, true);
    expect(out[0]).toBe(msgs[0]);
    expect(out[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }] });
  });

  it('a block array gets the marker on its LAST block only', () => {
    const msgs = [{ role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }, { type: 'tool_result', tool_use_id: 't2', content: 'y' }] }];
    const out = withAnthropicMessageCache(msgs, true);
    expect(breakpoints(out)).toEqual(['$[0].content[1]']);
  });

  it('off, empty array, or an empty final message → the input unchanged', () => {
    const msgs = [{ role: 'user' as const, content: '' }];
    expect(withAnthropicMessageCache(msgs, true)).toBe(msgs);
    expect(withAnthropicMessageCache([{ role: 'user' as const, content: 'a' }], false)).toEqual([{ role: 'user', content: 'a' }]);
    expect(withAnthropicMessageCache([], true)).toEqual([]);
  });

  it('never mutates the caller (the replay digest reads the caller\'s messages)', () => {
    const msgs = [{ role: 'user' as const, content: [{ type: 'text', text: 'a' }] }];
    const snap = JSON.stringify(msgs);
    withAnthropicMessageCache(msgs, true);
    expect(JSON.stringify(msgs)).toBe(snap);
  });
});

describe('dispatchAnthropicToolsRound — the conversation breakpoint', () => {
  it('lever on + continuation hint → the LAST message is marked, ≤ 4 breakpoints in all', async () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_PROVIDER_CACHE = 'true';
    process.env.OPENWOP_CONTEXT_ECONOMY_CONVERSATION_CACHE = 'true';
    await dispatchAnthropicToolsRound({ ...ROUND, cacheConversation: true });
    const bps = breakpoints(bodies[0]);
    expect(bps).toContain('$.messages[2].content[0]'); // the last non-system message
    expect(bps.filter((p) => p.startsWith('$.messages'))).toEqual(['$.messages[2].content[0]']);
    expect(bps.length).toBeLessThanOrEqual(4);
    // Exactly where they are: the A2 tools + system breakpoints, plus D3's one.
    expect(bps).toEqual(['$.tools[0]', '$.system[0]', '$.messages[2].content[0]']);
    const marked = (bodies[0].messages as Array<{ content: Array<{ text?: string }> }>)[2].content[0];
    expect(marked.text).toBe('TOOL RESULT: 42');
  });

  it('lever on, FIRST round (no hint) → no message breakpoint', async () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_CONVERSATION_CACHE = 'true';
    await dispatchAnthropicToolsRound(ROUND);
    expect(breakpoints(bodies[0]).filter((p) => p.startsWith('$.messages'))).toEqual([]);
  });

  it('lever off + hint → the body is byte-identical to a request without the hint', async () => {
    await dispatchAnthropicToolsRound({ ...ROUND, cacheConversation: true });
    await dispatchAnthropicToolsRound(ROUND);
    expect(JSON.stringify(bodies[0])).toBe(JSON.stringify(bodies[1]));
    expect(breakpoints(bodies[0])).toEqual([]);
  });
});

describe('dispatchAnthropicWithTools — the multi-round node loop', () => {
  it('round 1 is unmarked; round 2 marks the tool_result message', async () => {
    process.env.OPENWOP_CONTEXT_ECONOMY_CONVERSATION_CACHE = 'true';
    replies = [
      { content: [{ type: 'tool_use', id: 'tu1', name: 'lookup', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    await dispatchAnthropicWithTools({
      provider: 'anthropic', model: 'claude-test', apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'go' }],
      tools: ROUND.tools,
      onToolUse: async (r) => ({ toolUseId: r.id, content: 'RESULT' }),
    });
    expect(bodies).toHaveLength(2);
    expect(breakpoints(bodies[0]).filter((p) => p.startsWith('$.messages'))).toEqual([]);
    const second = breakpoints(bodies[1]).filter((p) => p.startsWith('$.messages'));
    expect(second).toHaveLength(1);
    const msgs = bodies[1].messages as Array<{ role: string; content: Array<{ type: string }> }>;
    expect(second[0]).toBe(`$.messages[${msgs.length - 1}].content[0]`);
    expect(msgs[msgs.length - 1].content[0].type).toBe('tool_result');
  });
});
