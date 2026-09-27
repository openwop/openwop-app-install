import { describe, it, expect } from 'vitest';
import { classifyHttpError, errorReasonOf } from '../classifyHttpError.js';

describe('classifyHttpError', () => {
  it('maps a 429 (status property) to rate-limited + retryable', () => {
    const c = classifyHttpError(Object.assign(new Error('nope'), { status: 429 }));
    expect(c.kind).toBe('rate-limited');
    expect(c.retryable).toBe(true);
  });

  // ADR 0482 (ux-1) — the budget 429 is keyed on the machine-readable
  // envelope reason, wherever the transport parked the parsed body.
  it('maps a budget-exhausted 429 via ApiError.body.details.reason', () => {
    const err = Object.assign(new Error('POST /v1/runs → 429'), {
      status: 429,
      body: { error: 'rate_limited', message: 'budget', details: { reason: 'workflow_budget_exhausted' } },
    });
    const c = classifyHttpError(err);
    expect(c.kind).toBe('budget-exhausted');
    expect(c.retryable).toBe(false);
  });

  it('maps a budget-exhausted 429 via WopError.envelope.details.reason', () => {
    const err = Object.assign(new Error('429'), {
      status: 429,
      envelope: { error: 'rate_limited', message: 'budget', details: { reason: 'workflow_budget_exhausted' } },
    });
    expect(classifyHttpError(err).kind).toBe('budget-exhausted');
  });

  it('keeps a reasonless 429 as plain rate-limited', () => {
    const err = Object.assign(new Error('429'), { status: 429, body: { error: 'rate_limited', message: 'slow down' } });
    expect(classifyHttpError(err).kind).toBe('rate-limited');
  });

  it('errorReasonOf reads body, envelope, or the error itself — else null', () => {
    expect(errorReasonOf({ body: { details: { reason: 'r1' } } })).toBe('r1');
    expect(errorReasonOf({ envelope: { details: { reason: 'r2' } } })).toBe('r2');
    expect(errorReasonOf({ details: { reason: 'r3' } })).toBe('r3');
    expect(errorReasonOf(new Error('no reason'))).toBeNull();
    expect(errorReasonOf(undefined)).toBeNull();
  });

  it('extracts a 429 from the "listX failed: 429" message convention', () => {
    const c = classifyHttpError(new Error('listMyRuns failed: 429 Too Many Requests'));
    expect(c.kind).toBe('rate-limited');
  });

  it('treats a fetch TypeError as offline', () => {
    const c = classifyHttpError(new TypeError('Failed to fetch'));
    expect(c.kind).toBe('offline');
    expect(c.retryable).toBe(true);
  });

  it('maps 401/403 to a non-retryable auth error', () => {
    expect(classifyHttpError(Object.assign(new Error('x'), { status: 401 })).kind).toBe('auth');
    expect(classifyHttpError(Object.assign(new Error('x'), { statusCode: 403 })).retryable).toBe(false);
  });

  it('maps 404 to not-found and 5xx to a retryable server error', () => {
    expect(classifyHttpError(Object.assign(new Error('x'), { status: 404 })).kind).toBe('not-found');
    const s = classifyHttpError(Object.assign(new Error('x'), { status: 503 }));
    expect(s.kind).toBe('server');
    expect(s.retryable).toBe(true);
  });

  it('falls back to unknown with the original message', () => {
    const c = classifyHttpError(new Error('weird boom'));
    expect(c.kind).toBe('unknown');
    expect(c.detail).toContain('weird boom');
  });
});

// ADR 0621 D5 / USERS-UX-13 — a 401 that REFUSED a live session is keyed on
// `body.error`, never on the status alone; an ordinary `sign_in_required` 401
// stays the generic "session may have expired" kind.
describe('classifyHttpError — session refusals (ADR 0621 D5)', () => {
  const refused = (code: string, carrier: 'body' | 'envelope' = 'body') =>
    Object.assign(new Error('GET /me → 401'), { status: 401, [carrier]: { error: code, message: 'refused' } });

  it('401 account_disabled → account-disabled, not retryable', () => {
    const c = classifyHttpError(refused('account_disabled'));
    expect(c.kind).toBe('account-disabled');
    expect(c.retryable).toBe(false);
  });

  it('401 account_erased → account-erased', () => {
    expect(classifyHttpError(refused('account_erased')).kind).toBe('account-erased');
  });

  it('401 session_revoked → session-revoked (also via the SDK envelope carrier)', () => {
    expect(classifyHttpError(refused('session_revoked')).kind).toBe('session-revoked');
    expect(classifyHttpError(refused('session_revoked', 'envelope')).kind).toBe('session-revoked');
  });

  it('401 sign_in_required stays the generic auth kind', () => {
    expect(classifyHttpError(refused('sign_in_required')).kind).toBe('auth');
  });

  it('a 503 session_authority_unavailable is a transient server error, never a refusal', () => {
    const err = Object.assign(new Error('503'), { status: 503, body: { error: 'session_authority_unavailable', message: 'x' } });
    const c = classifyHttpError(err);
    expect(c.kind).toBe('server');
    expect(c.retryable).toBe(true);
  });
});
