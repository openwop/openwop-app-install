/**
 * classifyChatError — the FE map from a serialized `{code, message, reason}` to
 * the ErrorCard's title/detail/action. Failure honesty: a provider failure must
 * name its cause and offer the one action that helps (BYOK for a key problem,
 * retry for a transient one) — never "Something went wrong" over raw provider
 * JSON, and never a retry for a missing key.
 */
import { describe, it, expect } from 'vitest';
import { classifyChatError } from '../errorClassify.js';

describe('classifyChatError', () => {
  it('maps BYOK credential codes to the reconfigure action', () => {
    for (const code of ['credential_unavailable', 'credential_required', 'byok_required', 'byok_required_but_unresolved']) {
      const k = classifyChatError({ code, message: '' });
      expect(k.title, code).toBe('API key missing');
      expect(k.action?.kind, code).toBe('reconfigure-byok');
    }
  });

  // Twin: errorClassifyDailyLimit.test.ts "keeps an upstream burst limit
  // retryable" pins provider_rate_limited from the daily-limit side (a reasonless
  // burst must not be captured by the daily-limit branch). Both are kept.
  it('maps provider rate-limit / unavailable / timeout to a retry action', () => {
    for (const code of ['provider_rate_limited', 'provider_unavailable', 'provider_timed_out']) {
      expect(classifyChatError({ code, message: '' }).action?.kind).toBe('retry');
    }
  });

  it('extracts the provider HTTP status from an internal_error preamble', () => {
    expect(classifyChatError({ code: 'internal_error', message: 'anthropic_429: slow down' }).title).toBe('Rate limited');
    expect(classifyChatError({ code: 'internal_error', message: 'openai_401: bad key' }).action?.kind).toBe('reconfigure-byok');
    expect(classifyChatError({ code: 'internal_error', message: 'openai_503: oops' }).action?.kind).toBe('retry');
  });

  it('finds the provider status marker even when the conversation lane wraps it', () => {
    // The conversation lane prefixes the marker ("Conversation reply failed: …");
    // an anchored match let the raw provider JSON through as a generic card.
    const k = classifyChatError({ code: 'internal_error', message: 'Conversation reply failed: openai_401: {"error":"bad key"}' });
    expect(k.title).toBe('Authentication failed');
    expect(k.action?.kind).toBe('reconfigure-byok');
    expect(k.detail).not.toContain('{"error"');
  });

  it('falls back to a generic card for an unknown code', () => {
    const k = classifyChatError({ code: 'totally_new', message: 'boom' });
    expect(k.title).toBe('Something went wrong');
    expect(k.detail).toContain('totally_new');
  });

  // ADR 0482 (ux-1) — a dispatch rejected by the daily budget says so.
  it('maps dispatch_failed with the budget reason to the honest budget copy', () => {
    const k = classifyChatError({ code: 'dispatch_failed', message: 'raw sdk text', reason: 'workflow_budget_exhausted' });
    expect(k.title).toBe('Daily budget reached');
    expect(k.detail).toContain('paused until tomorrow (UTC)');
    expect(k.action).toBeUndefined();
  });

  it('keeps a reasonless dispatch_failed generic (message shown verbatim)', () => {
    const k = classifyChatError({ code: 'dispatch_failed', message: 'engine exploded' });
    expect(k.title).toBe('Something went wrong');
    expect(k.detail).toBe('engine exploded');
  });
});
