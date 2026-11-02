/**
 * `classifyDispatchError` — chat improvements plan §2B.2 (TST-DAD-4). Pure-function
 * classifier mapping dispatch errors to {category, action, userMessage}: the FE
 * recovery UI, notifications and retry policies branch on it, so a wrong arm
 * renders the generic "Something went wrong" or retries a daily cap in seconds.
 *
 * Red when (sabotage-witnessed, wave 70): the daily-cap arm stops sizing
 * `retryAfterMs` to the next UTC midnight; `msUntilNextUtcMidnight` targets the
 * wrong day; `sign_in_required` loses its `sign_in` action; the 402 arm or the
 * `model_not_allowed` policy reason falls through.
 */

import { describe, expect, it, vi } from 'vitest';
import { AiProviderError, type AiProviderErrorCode } from '../src/aiProviders/aiProvidersHost.js';
import { classifyDispatchError, msUntilNextUtcMidnight } from '../src/observability/errorRecovery.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

describe('classifyDispatchError — AiProviderError codes', () => {
  it('byok_required → auth / reconfigure', () => {
    const r = classifyDispatchError(new AiProviderError('byok_required', 'No credential'));
    expect(r.category).toBe('auth');
    expect(r.action).toBe('reconfigure');
    expect(r.userMessage).toMatch(/BYOK/i);
  });

  // Managed-provider codes flow through the same classifier via the
  // deliberate `as AiProviderErrorCode` cast in executor.ts:emitTerminalFailure
  // (they are outside the union) — the fixtures below use that same cast. Without explicit
  // cases they would render as the generic "Something went wrong"
  // default — which is wrong for user-actionable errors like
  // sign-in-required and daily-cap.
  it('sign_in_required → auth / sign_in with sign-in message', () => {
    const r = classifyDispatchError(
      new AiProviderError('sign_in_required' as AiProviderErrorCode, 'Sign in to use the free tier.'),
    );
    expect(r.category).toBe('auth');
    // Distinct from `reconfigure` so consumers (FE recovery UI,
    // notification surface, automated retry policies) can branch
    // deterministically on "anon caller on a managed path" without
    // pattern-matching the userMessage.
    expect(r.action).toBe('sign_in');
    expect(r.userMessage).toMatch(/sign in/i);
    expect(r.userMessage).not.toMatch(/something went wrong/i);
  });

  it('daily_limit_reached → rate_limit / wait with retryAfterMs sized for the actual UTC-midnight reset', () => {
    // Fake only Date, at 18:30 UTC: the cap resets at 00:00 UTC, 5h30m away.
    // Without this hint, callers honoring `retryAfterMs` would retry in
    // seconds and keep burning the same 401.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 4, 29, 18, 30, 0, 0)));
      const r = classifyDispatchError(
        new AiProviderError('daily_limit_reached' as AiProviderErrorCode, 'cap hit'),
      );
      expect(r.category).toBe('rate_limit');
      expect(r.action).toBe('wait');
      expect(r.userMessage).toMatch(/daily limit/i);
      expect(r.retryAfterMs).toBe(5 * ONE_HOUR_MS + 30 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('msUntilNextUtcMidnight is deterministic + correct for a fixed instant', () => {
    // 2026-05-29 18:30:00 UTC → next midnight = 2026-05-30 00:00:00 UTC
    // → 5h 30m = 19_800_000ms.
    const at = new Date(Date.UTC(2026, 4, 29, 18, 30, 0, 0));
    expect(msUntilNextUtcMidnight(at)).toBe(5 * ONE_HOUR_MS + 30 * 60 * 1000);
    // Edge: exactly at UTC midnight → returns a full day.
    const atMidnight = new Date(Date.UTC(2026, 4, 29, 0, 0, 0, 0));
    expect(msUntilNextUtcMidnight(atMidnight)).toBe(ONE_DAY_MS);
    // Edge: one millisecond before midnight → returns 1ms.
    const justBefore = new Date(Date.UTC(2026, 4, 29, 23, 59, 59, 999));
    expect(msUntilNextUtcMidnight(justBefore)).toBe(1);
  });

  it('managed_unavailable → network / retry', () => {
    const r = classifyDispatchError(
      new AiProviderError('managed_unavailable' as AiProviderErrorCode, 'no key'),
    );
    expect(r.category).toBe('network');
    expect(r.action).toBe('retry');
    expect(r.userMessage).toMatch(/temporarily unavailable/i);
  });

  it('provider_rate_limited → rate_limit / wait + retryAfterMs', () => {
    const r = classifyDispatchError(new AiProviderError('provider_rate_limited', '429'));
    expect(r.category).toBe('rate_limit');
    expect(r.action).toBe('wait');
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it('provider_timed_out → timeout / retry', () => {
    const r = classifyDispatchError(new AiProviderError('provider_timed_out', 'timed out'));
    expect(r.category).toBe('timeout');
    expect(r.action).toBe('retry');
  });

  it('safety_filter → safety / regenerate', () => {
    const r = classifyDispatchError(new AiProviderError('safety_filter', 'blocked'));
    expect(r.category).toBe('safety');
    expect(r.action).toBe('regenerate');
  });

  it('host_capability_missing → config / reconfigure', () => {
    const r = classifyDispatchError(new AiProviderError('host_capability_missing', 'no embeddings'));
    expect(r.category).toBe('config');
    expect(r.action).toBe('reconfigure');
  });

  it('internal_error with anthropic_429 preamble → rate_limit / wait', () => {
    const r = classifyDispatchError(new AiProviderError('internal_error', 'anthropic_429: too many'));
    expect(r.category).toBe('rate_limit');
    expect(r.action).toBe('wait');
    expect(r.userMessage).toMatch(/anthropic/);
  });

  it('internal_error with openai_401 preamble → auth / reconfigure', () => {
    const r = classifyDispatchError(new AiProviderError('internal_error', 'openai_401: invalid api key'));
    expect(r.category).toBe('auth');
    expect(r.action).toBe('reconfigure');
  });

  it('internal_error with google_500 preamble → network / retry', () => {
    const r = classifyDispatchError(new AiProviderError('internal_error', 'google_500: server error'));
    expect(r.category).toBe('network');
    expect(r.action).toBe('retry');
  });
});

describe('classifyDispatchError — provider_policy_denied keeps its reason', () => {
  // Every policy refusal carries one wire code; the guidance follows `reason`.
  const denied = (reason?: string) =>
    classifyDispatchError(new AiProviderError('provider_policy_denied', 'denied', reason ? { reason } : {}));

  it('reason byok_required → auth / reconfigure (BYOK guidance)', () => {
    expect(denied('byok_required')).toMatchObject({ category: 'auth', action: 'reconfigure' });
    expect(denied('byok_required_but_unresolved')).toMatchObject({ category: 'auth' });
    expect(denied('byok_required').userMessage).toMatch(/API key/);
  });

  it('reason model_not_allowed → config / reconfigure (pick another model)', () => {
    const r = denied('model_not_allowed');
    expect(r).toMatchObject({ category: 'config', action: 'reconfigure' });
    expect(r.userMessage).toMatch(/model/);
  });

  it('reason provider_disabled (or none) → the generic policy message', () => {
    expect(denied('provider_disabled').userMessage).toMatch(/denies this provider/);
    expect(denied().userMessage).toMatch(/denies this provider/);
  });
});

describe('classifyDispatchError — raw Error fallbacks', () => {
  it('raw <provider>_<status>: preamble — no AiProviderError wrap', () => {
    const r = classifyDispatchError(new Error('anthropic_429: Too many'));
    expect(r.category).toBe('rate_limit');
    expect(r.action).toBe('wait');
  });

  it('AbortError → timeout / abort', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const r = classifyDispatchError(err);
    expect(r.category).toBe('timeout');
    expect(r.action).toBe('abort');
  });

  it('network failure message → network / retry', () => {
    const r = classifyDispatchError(new Error('fetch failed: ECONNREFUSED'));
    expect(r.category).toBe('network');
    expect(r.action).toBe('retry');
  });

  it('unknown error → unknown / abort', () => {
    const r = classifyDispatchError(new Error('something weird happened'));
    expect(r.category).toBe('unknown');
    expect(r.action).toBe('abort');
  });

  it('non-Error throwable → unknown / abort', () => {
    const r = classifyDispatchError('string error');
    expect(r.category).toBe('unknown');
    expect(r.action).toBe('abort');
  });
});

describe('classifyDispatchError — provider-status status table', () => {
  it.each([
    ['400', 'config', 'reconfigure'],
    ['402', 'quota', 'reconfigure'],
    ['403', 'auth', 'reconfigure'],
    ['408', 'timeout', 'retry'],
    ['422', 'config', 'reconfigure'],
    ['500', 'network', 'retry'],
    ['502', 'network', 'retry'],
    ['503', 'network', 'retry'],
  ])('HTTP %s → category=%s action=%s', (status, category, action) => {
    const r = classifyDispatchError(new Error(`anthropic_${status}: msg`));
    expect(r.category).toBe(category);
    expect(r.action).toBe(action);
  });
});
