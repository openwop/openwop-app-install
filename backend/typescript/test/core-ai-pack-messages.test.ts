/**
 * Regression: core.ai.chatCompletion must build a valid messages[] from whatever a
 * node receives — including STRUCTURED upstream data (e.g. {triage:{...}}) with no
 * chat `messages` array. Previously it passed `messages: undefined` straight to
 * ctx.callAI, and the provider crashed with "req.messages is not iterable"
 * (prod: lighthouse.lead-triage `draft` node fed the triage node's object output).
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
const asCtx = (c: ReturnType<typeof captureCtx>['ctx']): Parameters<PackNode>[0] => c as Parameters<PackNode>[0];
beforeAll(async () => { chatCompletion = (await import('../../../packs/core.openwop.ai/index.mjs')).chatCompletion; });

describe('core.ai.chatCompletion — messages coercion (req.messages-not-iterable fix)', () => {
  it('structured-only inputs → one user turn with the serialized payload (never undefined)', async () => {
    const { ctx, calls } = captureCtx({ triage: { score: 0, variant: 'enriched', priority: 'low' } }, { systemPrompt: 'Draft a reply.' });
    const res = await chatCompletion(asCtx(ctx)) as { status: string };
    expect(res.status).toBe('success');
    const msgs = calls[0].messages as Array<{ role: string; content: string }>;
    expect(Array.isArray(msgs)).toBe(true);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(JSON.parse(msgs[0].content)).toEqual({ triage: { score: 0, variant: 'enriched', priority: 'low' } });
  });

  it('an explicit messages[] passes through unchanged', async () => {
    const explicit = [{ role: 'user', content: 'hello' }];
    const { ctx, calls } = captureCtx({ messages: explicit });
    await chatCompletion(asCtx(ctx));
    expect(calls[0].messages).toEqual(explicit);
  });

  it('a recognized text port becomes a user turn', async () => {
    const { ctx, calls } = captureCtx({ text: 'summarize this' });
    await chatCompletion(asCtx(ctx));
    expect(calls[0].messages).toEqual([{ role: 'user', content: 'summarize this' }]);
  });

  it('genuinely empty inputs → empty array (no crash, no undefined)', async () => {
    const { ctx, calls } = captureCtx({});
    await chatCompletion(asCtx(ctx));
    expect(calls[0].messages).toEqual([]);
  });
});
