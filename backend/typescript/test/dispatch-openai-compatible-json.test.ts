/**
 * ADR 0756 follow-up — an OpenAI-compatible server that ignores `stream: true`
 * and answers ONE complete `application/json` chat.completion (the ADR 0182
 * at-own-risk shim is turn-atomic by design) must still yield its completion.
 * Before the fix `dispatchOpenAICompatible` parsed every body as SSE, found no
 * events, and returned an empty completion.
 *
 * Driven through `dispatchChat` with provider `minimax`, which uses the same
 * shared OpenAI-compatible dispatcher over the global fetch.
 *
 * TST-CWA-3. Red when (sabotage-witnessed, wave 69): the JSON branch is skipped
 * or matches only a bare `application/json` (the first three cases); the
 * DECLARED content-length cap OR the ACTUAL body-size cap is removed (one leg
 * each of "refuses an oversized body"); the parse error is swallowed
 * ("malformed JSON"); the content bypasses the <think> splitter; cached tokens
 * are dropped from usage.
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
    // Leg 1 — the DECLARED length is over the 8 MiB cap (the body is tiny).
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonCompletion(
      { choices: [{ message: { content: 'x' } }] },
      { 'content-length': String(9 * 1024 * 1024) },
    ));
    await expect(dispatchChat(req())).rejects.toThrow('minimax_response_too_large');
    // Leg 2 — no declared length at all, but the ACTUAL body is over the cap:
    // a server that omits the header must still be refused, never truncated.
    const big = JSON.stringify({ choices: [{ message: { content: 'y'.repeat(8 * 1024 * 1024) }, finish_reason: 'stop' }] });
    const undeclared = new Response(big, { status: 200, headers: { 'content-type': 'application/json' } });
    expect(undeclared.headers.get('content-length')).toBeNull();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(undeclared);
    await expect(dispatchChat(req())).rejects.toThrow('minimax_response_too_large');
  });

  it('refuses a malformed JSON body with a named error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(dispatchChat(req())).rejects.toThrow('minimax_malformed_json_completion');
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
