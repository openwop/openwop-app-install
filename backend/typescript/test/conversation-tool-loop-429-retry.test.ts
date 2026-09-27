/**
 * withRateLimitRetry — the chat tool loop's bounded 429 resilience (the
 * 2026-07-14 boardroom failure: back-to-back advisor turns tripped the
 * provider's per-minute limit and the whole turn died). Pins the contract:
 * exactly ONE retry, only for the typed provider_rate_limited failure, other
 * errors and codes propagate untouched, and 0 backoff disables the wrapper.
 */
import { describe, it, expect, vi } from 'vitest';
import { withRateLimitRetry } from '../src/host/conversationToolLoop.js';
import { AiProviderError } from '../src/aiProviders/aiProvidersHost.js';

const req = { systemPrompt: 's', messages: [], tools: [] } as never;
const ok = { content: 'answer', toolCalls: [] };
const rateLimited = () => new AiProviderError('provider_rate_limited', 'Provider rate-limited.', { status: 429 });

describe('withRateLimitRetry', () => {
  it('retries once after a provider_rate_limited failure and returns the second result', async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce(ok);
    const result = await withRateLimitRetry(call, 1)(req);
    expect(result).toEqual(ok);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('propagates the failure when the retry is rate-limited too (bounded to one)', async () => {
    const call = vi.fn().mockRejectedValue(rateLimited());
    await expect(withRateLimitRetry(call, 1)(req)).rejects.toMatchObject({ code: 'provider_rate_limited' });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not retry other AiProviderError codes', async () => {
    const call = vi.fn().mockRejectedValue(new AiProviderError('provider_unavailable', 'Provider 5xx.', { status: 503 }));
    await expect(withRateLimitRetry(call, 1)(req)).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-AiProviderError failures', async () => {
    const call = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(withRateLimitRetry(call, 1)(req)).rejects.toThrow('network down');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('waitMs 0 disables the retry entirely', async () => {
    const call = vi.fn().mockRejectedValue(rateLimited());
    await expect(withRateLimitRetry(call, 0)(req)).rejects.toMatchObject({ code: 'provider_rate_limited' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('passes a successful first call straight through', async () => {
    const call = vi.fn().mockResolvedValue(ok);
    const result = await withRateLimitRetry(call, 1)(req);
    expect(result).toEqual(ok);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('isProviderRateLimited — the shared vocabulary (grade-pass RESIL-2)', () => {
  it('matches the RAW managed-tier dispatcher shape (minimax_429: …), not just the typed error', async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(new Error('minimax_429: rate limit exceeded'))
      .mockResolvedValueOnce(ok);
    await expect(withRateLimitRetry(call, 1)(req)).resolves.toEqual(ok);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not match other raw upstream statuses or non-errors', async () => {
    for (const err of [new Error('google_500: boom'), new Error('rate limit but wrong shape'), 'minimax_429: not-an-Error']) {
      const call = vi.fn().mockRejectedValue(err);
      await expect(withRateLimitRetry(call, 1)(req)).rejects.toBeTruthy();
      expect(call).toHaveBeenCalledTimes(1);
    }
  });
});
