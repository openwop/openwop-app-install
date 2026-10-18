/**
 * The free tier's daily allowance reaches the chat as a generic failure code
 * with `reason: daily_limit_reached`. The card must name it and offer the
 * user's own key — not "Something went wrong", and not a retry that cannot
 * succeed before 00:00 UTC (ADR 0773 G-10b, case 4).
 */
import { describe, expect, it } from 'vitest';
import { classifyChatError } from '../errorClassify.js';

describe('classifyChatError — the managed daily limit', () => {
  it('names the limit and offers BYOK, whatever the carrier code', () => {
    for (const code of ['internal_error', 'provider_rate_limited', 'conversation_exchange_failed']) {
      const k = classifyChatError({ code, message: 'Agent tool turn failed: Daily limit reached (50000 tokens).', reason: 'daily_limit_reached' });
      expect(k.title, code).toBe("Today's free allowance is used up");
      expect(k.action?.kind, code).toBe('reconfigure-byok');
      expect(k.detail).not.toContain('Agent tool turn failed');
    }
  });

  it('leaves the same failure without the reason on its existing path', () => {
    const k = classifyChatError({ code: 'internal_error', message: 'Agent tool turn failed: boom' });
    expect(k.action).toBeUndefined();
    expect(k.detail).toBe('Agent tool turn failed: boom');
  });

  // Twin of errorClassify.test.ts "maps provider rate-limit / unavailable /
  // timeout to a retry action" (same code); kept here because this file's claim is
  // the boundary: WITHOUT the daily reason, a burst stays the retryable
  // rate-limit card, not the "allowance used up" one.
  it('keeps an upstream burst limit retryable', () => {
    const k = classifyChatError({ code: 'provider_rate_limited', message: 'x' });
    expect(k.title).toBe('Rate limited');
    expect(k.action?.kind).toBe('retry');
  });
});

describe('classifyChatError — a host provider-policy refusal', () => {
  // capabilities.md "Wire-format error": one code, the cause in `reason`.
  it('offers BYOK when the policy requires a key', () => {
    for (const reason of ['byok_required', 'byok_required_but_unresolved']) {
      const k = classifyChatError({ code: 'provider_policy_denied', message: 'needs a key', reason });
      expect(k.action?.kind).toBe('reconfigure-byok');
    }
  });

  it('stays generic for any other policy reason', () => {
    const k = classifyChatError({ code: 'provider_policy_denied', message: 'no', reason: 'model_not_allowed' });
    expect(k.action).toBeUndefined();
    expect(k.detail).toBe('provider_policy_denied: no');
  });
});
