/**
 * dispatchGoogle thinking-budget detection (live-verified 2026-06-23). At a low
 * maxOutputTokens a thinking model returns EMPTY unless we set thinkingConfig.thinkingBudget=0
 * — so the reasoning-model detection must cover gemini-3.x (flash AND flash-lite, which —
 * unlike 2.5-flash-lite — accepts thinkingConfig). Mocks only the network; asserts the exact
 * request body our dispatcher sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchChat, resetGoogleThinkingShapeMemoForTests } from '../src/providers/dispatch.js';

interface GenConfig { maxOutputTokens?: number; thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: string; includeThoughts?: boolean } }
interface GeminiReqBody { generationConfig?: GenConfig }

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });
beforeEach(() => { resetGoogleThinkingShapeMemoForTests(); });

async function captureGoogleBody(model: string): Promise<GeminiReqBody> {
  let body: GeminiReqBody = {};
  const mock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('generativelanguage.googleapis.com')) {
      body = JSON.parse(String(init?.body)) as GeminiReqBody;
      return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return realFetch(input, init);
  });
  global.fetch = mock as typeof fetch;
  await dispatchChat({ provider: 'google', model, apiKey: 'k', messages: [{ role: 'user', content: 'hi' }], maxTokens: 24 });
  return body;
}

describe('dispatchGoogle reasoning-budget detection', () => {
  it('sets thinkingBudget:0 for a gemini-3 flash model (fixes the empty-completion at low tokens)', async () => {
    const body = await captureGoogleBody('gemini-3-flash-preview');
    expect(body.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);
  });

  it('sets thinkingBudget:0 for gemini-3.x flash-LITE too (3.x lite accepts thinkingConfig)', async () => {
    const body = await captureGoogleBody('gemini-3.1-flash-lite');
    expect(body.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);
  });

  it('keeps thinkingBudget:0 for 2.5 flash (unchanged)', async () => {
    const body = await captureGoogleBody('gemini-2.5-flash');
    expect(body.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);
  });

  it('does NOT set thinkingConfig for 2.5-flash-LITE (it rejects thinkingConfig — exclusion preserved)', async () => {
    const body = await captureGoogleBody('gemini-2.5-flash-lite');
    expect(body.generationConfig?.thinkingConfig).toBeUndefined();
  });
});

// ── Gemini models that REJECT the thinking parameter we send (2026-09-16) ─────
//
// MEASURED on one key with the same request: gemini-3.5-flash-lite answers
// `thinkingBudget: 0` with 400 INVALID_ARGUMENT (every call to that catalog model
// failed) but accepts `thinkingLevel: 'minimal'`, while 3.7/3.8-flash reject
// `thinkingLevel: 'minimal'`. The dispatcher walks a ladder
// budget0 → levelMinimal → no thinkingConfig, advancing ONLY on that rejection.
// `minimal` comes before "no config" because an unbounded-thinking call can spend
// a caller-capped budget on thought and return empty (review of #3894).
describe('dispatchGoogle walks the thinking-shape ladder when Google rejects a shape', () => {
  const OK_SSE = 'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n';
  const INVALID = JSON.stringify({ error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' } });

  function scripted(responses: Array<{ status: number; body: string }>): { bodies: GeminiReqBody[]; calls: () => number } {
    const bodies: GeminiReqBody[] = [];
    let i = 0;
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('generativelanguage.googleapis.com')) return realFetch(input, init);
      bodies.push(JSON.parse(String(init?.body)) as GeminiReqBody);
      const r = responses[Math.min(i++, responses.length - 1)]!;
      return new Response(r.body, { status: r.status, headers: { 'content-type': r.status === 200 ? 'text/event-stream' : 'application/json' } });
    }) as typeof fetch;
    return { bodies, calls: () => bodies.length };
  }
  const call = (model: string, extra: Record<string, unknown> = {}) =>
    dispatchChat({ provider: 'google', model, apiKey: 'k', messages: [{ role: 'user', content: 'hi' }], maxTokens: 24, ...extra });

  it('a rejected thinkingBudget:0 ⇒ the next request bounds thinking with thinkingLevel:minimal, keeping the caller cap', async () => {
    const s = scripted([{ status: 400, body: INVALID }, { status: 200, body: OK_SSE }]);
    const r = await call('gemini-3.5-flash-lite');
    expect(r.completion).toBe('ok');
    expect(s.calls()).toBe(2);
    expect(s.bodies[0]!.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(s.bodies[1]!.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
    expect(s.bodies[1]!.generationConfig?.maxOutputTokens).toBe(24);
  });

  it('both bounded shapes rejected ⇒ a third request with NO thinkingConfig, still at the caller cap (never raised)', async () => {
    const s = scripted([{ status: 400, body: INVALID }, { status: 400, body: INVALID }, { status: 200, body: OK_SSE }]);
    await call('gemini-3.8-flash');
    expect(s.calls()).toBe(3);
    expect(s.bodies[2]!.generationConfig?.thinkingConfig).toBeUndefined();
    expect(s.bodies[2]!.generationConfig?.maxOutputTokens).toBe(24);
  });

  it('an empty MAX_TOKENS completion on the last rung is returned with its finishReason intact — the adapter types it, the dispatcher never hides it', async () => {
    const EMPTY_MAX = 'data: {"candidates":[{"content":{"parts":[]},"finishReason":"MAX_TOKENS"}]}\n\n';
    scripted([{ status: 400, body: INVALID }, { status: 400, body: INVALID }, { status: 200, body: EMPTY_MAX }]);
    const r = await call('gemini-3.8-flash');
    expect(r.completion).toBe('');
    expect(r.finishReason).toBe('MAX_TOKENS');
  });

  it('the accepted shape is memoised per model: the next call goes straight to it, one request', async () => {
    scripted([{ status: 400, body: INVALID }, { status: 200, body: OK_SSE }]);
    await call('gemini-3.5-flash-lite');
    const s = scripted([{ status: 200, body: OK_SSE }]);
    await call('gemini-3.5-flash-lite');
    expect(s.calls()).toBe(1);
    expect(s.bodies[0]!.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
    const other = scripted([{ status: 200, body: OK_SSE }]);
    await call('gemini-3.1-flash-lite');
    expect(other.bodies[0]!.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('thinking ON: a rejected includeThoughts ⇒ one retry without thinkingConfig', async () => {
    const s = scripted([{ status: 400, body: INVALID }, { status: 200, body: OK_SSE }]);
    await call('gemini-3.5-flash-lite', { reasoningVerbosity: 'full' });
    expect(s.calls()).toBe(2);
    expect(s.bodies[0]!.generationConfig?.thinkingConfig).toEqual({ includeThoughts: true });
    expect(s.bodies[1]!.generationConfig?.thinkingConfig).toBeUndefined();
  });

  it('a different 400 is NOT retried (only the thinking rejection is)', async () => {
    const s = scripted([{ status: 400, body: JSON.stringify({ error: { code: 400, message: 'API key not valid.', status: 'FAILED_PRECONDITION' } }) }]);
    await expect(call('gemini-3.5-flash-lite')).rejects.toThrow(/google_400/);
    expect(s.calls()).toBe(1);
  });

  it('a model that sends no thinkingConfig is never retried on INVALID_ARGUMENT', async () => {
    const s = scripted([{ status: 400, body: INVALID }]);
    await expect(call('gemini-2.5-flash-lite')).rejects.toThrow(/google_400/);
    expect(s.calls()).toBe(1);
  });

  it('the ladder is finite: every shape rejected ⇒ the typed provider error after three requests', async () => {
    const s = scripted([{ status: 400, body: INVALID }]);
    await expect(call('gemini-3.5-flash-lite')).rejects.toThrow(/google_400/);
    expect(s.calls()).toBe(3);
  });
});
