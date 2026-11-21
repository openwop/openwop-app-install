/**
 * Regression: core.ai.chatCompletion must build a valid messages[] from whatever a
 * node receives — including STRUCTURED upstream data (e.g. {triage:{...}}) with no
 * chat `messages` array. Previously it passed `messages: undefined` straight to
 * ctx.callAI, and the provider crashed with "req.messages is not iterable"
 * (prod: lighthouse.lead-triage `draft` node fed the triage node's object output).
 *
 * Tracker TST-CQC-1 (w68, re-probed wave 121 as w121g1-cai-*). Sabotage-witnessed:
 * red when the structured-payload rung is skipped, when an explicit messages[] is
 * ignored, when the recognized-port list is narrowed — the text-port case puts an
 * UNRECOGNIZED string key first, so only the precedence list picks `text` (since
 * CC-SEO-3 two defined fields are serialized whole, never sent as one bare
 * string) — and (CC-CHAIN-6) when empty inputs with no systemPrompt reach the
 * provider or fail with any code but `invalid_inputs`.
 */
import { describe, expect, it, beforeAll } from 'vitest';

/** A ctx whose callAI records the request it receives. */
function captureCtx(inputs: unknown, config: Record<string, unknown> = {}) {
  const calls: Array<{ messages: unknown }> = [];
  const ctx = {
    inputs, config,
    callAI: async (req: { messages: unknown }) => { calls.push({ messages: req.messages }); return { content: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' }; },
  };
  return { ctx, calls };
}

type PackNode = typeof import('../../../packs/core.openwop.ai/index.mjs')['chatCompletion'];
let chatCompletion: PackNode;
beforeAll(async () => { chatCompletion = (await import('../../../packs/core.openwop.ai/index.mjs')).chatCompletion; });

describe('core.ai.chatCompletion — messages coercion (req.messages-not-iterable fix)', () => {
  it('structured-only inputs → one user turn with the serialized payload (never undefined)', async () => {
    const { ctx, calls } = captureCtx({ triage: { score: 0, variant: 'enriched', priority: 'low' } }, { systemPrompt: 'Draft a reply.' });
    const res = await chatCompletion(ctx);
    expect(res.status).toBe('success');
    const msgs = calls[0].messages;
    expect(msgs).toEqual([{ role: 'user', content: expect.any(String) }]);
    const content = Array.isArray(msgs) && typeof msgs[0]?.content === 'string' ? msgs[0].content : '';
    expect(JSON.parse(content)).toEqual({ triage: { score: 0, variant: 'enriched', priority: 'low' } });
  });

  it('an explicit messages[] passes through unchanged', async () => {
    const explicit = [{ role: 'user', content: 'hello' }];
    const { ctx, calls } = captureCtx({ messages: explicit });
    await chatCompletion(ctx);
    expect(calls[0].messages).toEqual(explicit);
  });

  it('a recognized text port becomes a user turn (ahead of an unrecognized string key)', async () => {
    // `note` is inserted FIRST: the generic fallback would pick it; the
    // recognized-port list must pick `text`.
    const { ctx, calls } = captureCtx({ note: 'aside', text: 'summarize this' });
    await chatCompletion(ctx);
    expect(calls[0].messages).toEqual([{ role: 'user', content: 'summarize this' }]);
  });

  // CC-CHAIN-6 — this case used to pin `messages: []` reaching the provider, which
  // Anthropic rejects ("Provider rejected request", invalid_request; measured on
  // 373d4863a). Genuinely empty inputs with no systemPrompt are now a typed failure
  // with no provider round-trip (no crash, no undefined — the original intent).
  it('genuinely empty inputs and no systemPrompt → typed failure, no provider call', async () => {
    const { ctx, calls } = captureCtx({});
    const out = await chatCompletion(ctx);
    expect(calls).toEqual([]);
    expect(out).toEqual({
      status: 'failed',
      error: { code: 'invalid_inputs', message: 'chatCompletion needs a message or a systemPrompt; this node received neither.' },
    });
  });
});
