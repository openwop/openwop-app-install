/**
 * ADR 0912 follow-up (Book AI P22, Anthropic arm) — a structured call to Claude
 * forces ONE tool call whose input_schema is the response schema; the reply is
 * the tool's input. Red under: not sending the forced tool, reading the text
 * block instead of the tool input, forcing the tool while thinking is on (a
 * documented 400), or no fallback on a tool_choice 400.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchChat } from '../src/providers/dispatch.js';

const SCHEMA = { type: 'object', required: ['line'], properties: { line: { type: 'string' } } };
type Captured = { body: Record<string, unknown> };

function sse(events: Array<[string, unknown]>): Response {
  const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const toolReply = (json: string): Response => sse([
  ['message_start', { message: { usage: { input_tokens: 10 } } }],
  ['content_block_start', { index: 0, content_block: { type: 'tool_use', name: 'respond' } }],
  // Streamed in two partial chunks, as Anthropic does.
  ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(0, 5) } }],
  ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(5) } }],
  ['content_block_stop', { index: 0 }],
  ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }],
]);
const textReply = (text: string): Response => sse([
  ['content_block_start', { index: 0, content_block: { type: 'text' } }],
  ['content_block_delta', { index: 0, delta: { type: 'text_delta', text } }],
  ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }],
]);

function stub(queue: Array<() => Response>): Captured[] {
  const seen: Captured[] = [];
  vi.stubGlobal('fetch', (_url: string, init: { body?: string }) => {
    seen.push({ body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
    return Promise.resolve(queue[Math.min(seen.length - 1, queue.length - 1)]!());
  });
  return seen;
}
const base = { provider: 'anthropic' as const, apiKey: 'k', messages: [{ role: 'user' as const, content: 'hi' }] };

afterEach(() => vi.unstubAllGlobals());

describe('ADR 0912 — Anthropic forced-tool structured output', () => {
  it('forces the respond tool with the schema, and the reply is the streamed tool input', async () => {
    const seen = stub([() => toolReply('{"line":"she said \\"run\\""}')]);
    const r = await dispatchChat({ ...base, model: 'claude-sonnet-4-6', jsonSchema: SCHEMA });
    const tools = seen[0]!.body.tools as Array<{ name: string; input_schema: unknown }>;
    expect(tools[0]!.name).toBe('respond');
    expect(tools[0]!.input_schema).toEqual(SCHEMA);
    expect(seen[0]!.body.tool_choice).toEqual({ type: 'tool', name: 'respond', disable_parallel_tool_use: true });
    expect(JSON.parse(r.completion)).toEqual({ line: 'she said "run"' });
    expect(r.structuredMode).toBe('tool');
    expect(r.finishReason).toBe('end_turn'); // a forced tool stop is the expected end
  });

  it('a tool_choice 400 falls back to the prompt hint, once', async () => {
    const seen = stub([
      () => new Response('{"error":{"type":"invalid_request_error","message":"tool_choice is not supported"}}', { status: 400 }),
      () => textReply('{"line":"x"}'),
    ]);
    const r = await dispatchChat({ ...base, model: 'claude-sonnet-4-6', jsonSchema: SCHEMA });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body).not.toHaveProperty('tools');
    expect(r.structuredMode).toBe('prompt');
    expect(r.completion).toBe('{"line":"x"}');
  });

  it('refuses two interleaved tool calls instead of concatenating their JSON', async () => {
    stub([() => sse([
      ['content_block_start', { index: 0, content_block: { type: 'tool_use', name: 'respond' } }],
      ['content_block_start', { index: 1, content_block: { type: 'tool_use', name: 'respond' } }],
      ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"line":"first"}' } }],
      ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"line":"second"}' } }],
      ['message_delta', { delta: { stop_reason: 'tool_use' } }],
    ])]);
    await expect(dispatchChat({ ...base, model: 'claude-sonnet-4-6', jsonSchema: SCHEMA }))
      .rejects.toThrow('anthropic_invalid_structured_tool_response');
  });

  it('refuses an input delta belonging to an undeclared tool block', async () => {
    stub([() => sse([
      ['content_block_start', { index: 0, content_block: { type: 'tool_use', name: 'respond' } }],
      ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"line":"other"}' } }],
      ['message_delta', { delta: { stop_reason: 'tool_use' } }],
    ])]);
    await expect(dispatchChat({ ...base, model: 'claude-sonnet-4-6', jsonSchema: SCHEMA }))
      .rejects.toThrow('anthropic_invalid_structured_tool_response');
  });

  it('with thinking on, the tool is NOT forced (Anthropic refuses that combination)', async () => {
    const seen = stub([() => textReply('{"line":"x"}')]);
    await dispatchChat({ ...base, model: 'claude-sonnet-4-6', jsonSchema: SCHEMA, reasoningVerbosity: 'full' });
    expect(seen[0]!.body).not.toHaveProperty('tool_choice');
  });

  it('a plain call sends no tools', async () => {
    const seen = stub([() => textReply('hello')]);
    const r = await dispatchChat({ ...base, model: 'claude-sonnet-4-6' });
    expect(seen[0]!.body).not.toHaveProperty('tools');
    expect(r.structuredMode).toBeUndefined();
  });
});
