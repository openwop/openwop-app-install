/**
 * withRateLimitRetry — the chat tool loop's bounded 429 resilience (the
 * 2026-07-14 boardroom failure: back-to-back advisor turns tripped the
 * provider's per-minute limit and the whole turn died). Pins the contract:
 * exactly ONE retry, only for the typed provider_rate_limited failure, other
 * errors and codes propagate untouched, and 0 backoff disables the wrapper.
 */
import { describe, it, expect, vi } from 'vitest';
import { withRateLimitRetry, providerFailureFields } from '../src/host/conversationToolLoop.js';
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

  // CHANGED 2026-10-03: this case used to assert that a 503 is NOT retried. A
  // live eval met Google's 503 "high demand" for minutes and every chat turn
  // died on the first call, so a transient 5xx now gets the same single retry.
  it('retries a TRANSIENT 5xx once (503 "high demand"), typed and raw', async () => {
    const typed = vi.fn()
      .mockRejectedValueOnce(new AiProviderError('provider_unavailable', 'Provider 5xx.', { status: 503, upstreamMessage: 'high demand' }))
      .mockResolvedValueOnce(ok);
    expect(await withRateLimitRetry(typed, 1)(req)).toEqual(ok);
    expect(typed).toHaveBeenCalledTimes(2);
    const raw = vi.fn().mockRejectedValueOnce(new Error('google_503: overloaded')).mockResolvedValueOnce(ok);
    expect(await withRateLimitRetry(raw, 1)(req)).toEqual(ok);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it('a transient 5xx is still bounded to ONE retry', async () => {
    const call = vi.fn().mockRejectedValue(new AiProviderError('provider_unavailable', 'Provider 5xx.', { status: 503 }));
    await expect(withRateLimitRetry(call, 1)(req)).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not retry a PERMANENT 5xx (501) or a 4xx code', async () => {
    for (const e of [
      new AiProviderError('provider_unavailable', 'Provider 5xx.', { status: 501 }),
      new AiProviderError('invalid_request', 'Provider rejected request.', { status: 400 }),
      new Error('google_501: not implemented'),
    ]) {
      const call = vi.fn().mockRejectedValue(e);
      await expect(withRateLimitRetry(call, 1)(req)).rejects.toBe(e);
      expect(call).toHaveBeenCalledTimes(1);
    }
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
    for (const err of [new Error('google_400: bad request'), new Error('rate limit but wrong shape'), 'minimax_429: not-an-Error']) {
      const call = vi.fn().mockRejectedValue(err);
      await expect(withRateLimitRetry(call, 1)(req)).rejects.toBeTruthy();
      expect(call).toHaveBeenCalledTimes(1);
    }
  });
});

describe('providerFailureFields — what a retry log line says', () => {
  it('names code, status and a bounded slice of the provider\'s own message', () => {
    const f = providerFailureFields(new AiProviderError('provider_unavailable', 'Provider 5xx.', { status: 503, upstreamMessage: 'x'.repeat(500) }));
    expect(f).toMatchObject({ code: 'provider_unavailable', status: 503 });
    expect((f.upstreamMessage as string).length).toBe(200);
    expect(providerFailureFields(new Error('google_503: high demand'))).toEqual({ status: 503, upstreamMessage: 'high demand' });
  });
});
