/**
 * ADR 0756 follow-up — an OpenAI-compatible server that ignores `stream: true`
 * and answers ONE complete `application/json` chat.completion (the ADR 0182
 * at-own-risk shim is turn-atomic by design) must still yield its completion.
 * Before the fix `dispatchOpenAICompatible` parsed every body as SSE, found no
 * events, and returned an empty completion.
 *
 * Driven through `dispatchChat` with provider `minimax`, which uses the same
 * shared OpenAI-compatible dispatcher over the global fetch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { dispatchChat } from '../src/providers/dispatch.js';

const req = (onDelta?: (d: string) => void) => ({
  provider: 'minimax' as const,
  model: 'test-model',
  apiKey: 'sk-test',
  messages: [{ role: 'user' as const, content: 'hi' }],
  ...(onDelta ? { onDelta } : {}),
});

function jsonCompletion(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

describe('dispatchOpenAICompatible: non-stream application/json completion', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the completion, finish_reason and usage from a single JSON body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonCompletion({
      choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 3 } },
    }));
    const deltas: string[] = [];
    const r = await dispatchChat(req((d) => deltas.push(d)));
    expect(r.completion).toBe('pong');
    expect(deltas).toEqual(['pong']);
    expect(r.finishReason).toBe('stop');
    expect(r.usage).toEqual({ inputTokens: 7, outputTokens: 1, cachedReadTokens: 3 });
  });

  it('splits <think> reasoning out of the visible completion, as the stream path does', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonCompletion({
      choices: [{ message: { content: '<think>plan</think>answer' }, finish_reason: 'stop' }],
    }));
    const r = await dispatchChat(req());
    expect(r.completion).toBe('answer');
  });

  it('accepts a charset parameter on the content type', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonCompletion(
      { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] },
      { 'content-type': 'application/json; charset=utf-8' },
    ));
    expect((await dispatchChat(req())).completion).toBe('ok');
  });

  it('refuses an oversized body instead of truncating it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonCompletion(
      { choices: [{ message: { content: 'x' } }] },
      { 'content-length': String(9 * 1024 * 1024) },
    ));
    await expect(dispatchChat(req())).rejects.toThrow(/response_too_large/);
  });

  it('refuses a malformed JSON body with a named error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(dispatchChat(req())).rejects.toThrow(/malformed_json_completion/);
  });

  it('still parses an SSE stream (the streaming path is unchanged)', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"po"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"ng"},"finish_reason":"stop"}]}\n\n'
      + 'data: [DONE]\n\n';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const r = await dispatchChat(req());
    expect(r.completion).toBe('pong');
    expect(r.finishReason).toBe('stop');
  });
});
