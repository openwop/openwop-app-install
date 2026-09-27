import { describe, it, expect } from 'vitest';
import { classifyChatError } from '../errorClassify.js';

describe('classifyChatError', () => {
  it('maps BYOK credential codes to the reconfigure action', () => {
    for (const code of ['credential_required', 'byok_required', 'byok_required_but_unresolved']) {
      const k = classifyChatError({ code, message: '' });
      expect(k.action?.kind).toBe('reconfigure-byok');
    }
  });

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
