/**
 * ADR 0118 Phase 1 — LLM span attribute allowlist (the no-prompt-bytes invariant).
 * The security-critical enforcement: prompt/response content + credentials are
 * dropped; only provider/model/token/latency metadata survives.
 */
import { describe, it, expect } from 'vitest';
import { safeSpanAttributes, withLlmSpan, PROVIDER_DISPATCH_SPAN } from '../src/observability/llmSpans.js';

describe('safeSpanAttributes — no-prompt-bytes / no-credential invariant', () => {
  it('keeps allowlisted metadata (prefixed openwop.ai.)', () => {
    const out = safeSpanAttributes({ provider: 'openai', model: 'gpt-x', inputTokens: 10, outputTokens: 5, cacheHit: true, latencyMs: 120 });
    expect(out).toEqual({
      'openwop.ai.provider': 'openai',
      'openwop.ai.model': 'gpt-x',
      'openwop.ai.inputTokens': 10,
      'openwop.ai.outputTokens': 5,
      'openwop.ai.cacheHit': true,
      'openwop.ai.latencyMs': 120,
    });
  });

  it('DROPS prompt/response content + credential-shaped keys', () => {
    const out = safeSpanAttributes({
      provider: 'openai',
      prompt: 'the user secret prompt text',
      messages: 'serialized conversation',
      response: 'the model output',
      apiKey: 'sk-leak',
      credential: 'bearer-xyz',
      authorization: 'Bearer xyz',
    } as Record<string, string>);
    expect(out).toEqual({ 'openwop.ai.provider': 'openai' });
    // No content/credential key survives, under any prefix.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('sk-leak');
    expect(serialized).not.toContain('Bearer');
  });

  it('drops undefined values', () => {
    expect(safeSpanAttributes({ provider: 'openai', model: undefined })).toEqual({ 'openwop.ai.provider': 'openai' });
  });
});

describe('withLlmSpan', () => {
  it('runs the body and returns its result (pass-through when OTel is a no-op)', async () => {
    const r = await withLlmSpan(PROVIDER_DISPATCH_SPAN, { provider: 'openai', model: 'm' }, async () => 42);
    expect(r).toBe(42);
  });

  it('propagates errors (without leaking the prompt into the span)', async () => {
    await expect(withLlmSpan(PROVIDER_DISPATCH_SPAN, { provider: 'openai', prompt: 'secret' } as Record<string, string>, async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
  });
});
