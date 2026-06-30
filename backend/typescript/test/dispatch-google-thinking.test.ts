/**
 * dispatchGoogle thinking-budget detection (live-verified 2026-06-23). At a low
 * maxOutputTokens a thinking model returns EMPTY unless we set thinkingConfig.thinkingBudget=0
 * — so the reasoning-model detection must cover gemini-3.x (flash AND flash-lite, which —
 * unlike 2.5-flash-lite — accepts thinkingConfig). Mocks only the network; asserts the exact
 * request body our dispatcher sends.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchChat } from '../src/providers/dispatch.js';

interface GenConfig { thinkingConfig?: { thinkingBudget?: number; includeThoughts?: boolean } }
interface GeminiReqBody { generationConfig?: GenConfig }

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

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
