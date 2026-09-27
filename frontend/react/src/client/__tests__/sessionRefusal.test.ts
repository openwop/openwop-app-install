/**
 * ADR 0621 D5 / USERS-UX-13 — the ONE choke for a mid-session hard sign-out.
 * The registered handler must fire for exactly the three refusal codes on a
 * 401, and for nothing else (an anonymous `sign_in_required` 401 must never
 * evict; a 503 authority outage is transient, D6).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleSessionRefusal,
  noteSessionRefusal,
  registerSessionRefusalHandler,
  sessionRefusalOf,
} from '../sessionRefusal.js';
import { requestJson, ApiError } from '../requestJson.js';
import { apiErrorFrom } from '../errorEnvelope.js';
import { assertSynced, SyncFailureError } from '../config.js';

afterEach(() => {
  registerSessionRefusalHandler(null);
  vi.restoreAllMocks();
});

describe('sessionRefusalOf', () => {
  it('reads the three codes off a 401 body (flat + legacy nested)', () => {
    expect(sessionRefusalOf(401, { error: 'account_disabled', message: 'x' })).toBe('account_disabled');
    expect(sessionRefusalOf(401, { error: 'account_erased', message: 'x' })).toBe('account_erased');
    expect(sessionRefusalOf(401, { error: { code: 'session_revoked' } })).toBe('session_revoked');
  });
  it('the v2 spelling of a revoked session (RFC 0170 credential_revoked) evicts exactly like session_revoked', () => {
    expect(sessionRefusalOf(401, { error: 'credential_revoked' })).toBe('session_revoked');
    expect(sessionRefusalOf(401, { error: { code: 'credential_revoked' } })).toBe('session_revoked');
  });
  it('is null for an ordinary 401, a non-401, and garbage bodies', () => {
    expect(sessionRefusalOf(401, { error: 'sign_in_required' })).toBeNull();
    expect(sessionRefusalOf(403, { error: 'account_disabled' })).toBeNull();
    expect(sessionRefusalOf(503, { error: 'session_authority_unavailable' })).toBeNull();
    expect(sessionRefusalOf(401, undefined)).toBeNull();
    expect(sessionRefusalOf(401, 'account_disabled')).toBeNull();
    expect(sessionRefusalOf(401, [])).toBeNull();
  });
});

describe('the handler', () => {
  it('fires once per refusal with the code; not for sign_in_required', () => {
    const handler = vi.fn();
    registerSessionRefusalHandler(handler);
    expect(noteSessionRefusal(401, { error: 'session_revoked', message: 'x' })).toBe(true);
    expect(noteSessionRefusal(401, { error: 'sign_in_required', message: 'x' })).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('session_revoked');
  });

  it('handleSessionRefusal reads a CLONE, so the caller can still parse the body', async () => {
    const handler = vi.fn();
    registerSessionRefusalHandler(handler);
    const res = new Response(JSON.stringify({ error: 'account_disabled', message: 'x' }), { status: 401 });
    expect(await handleSessionRefusal(res)).toBe(true);
    expect(handler).toHaveBeenCalledWith('account_disabled');
    expect(await res.json()).toEqual({ error: 'account_disabled', message: 'x' });
  });
});

describe('the shared helpers route through the choke', () => {
  const refusal = () => new Response(JSON.stringify({ error: 'account_erased', message: 'gone' }), {
    status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json' },
  });

  it('requestJson: handler fires AND the typed ApiError still throws with the code', async () => {
    const handler = vi.fn();
    registerSessionRefusalHandler(handler);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(refusal());
    const err = await requestJson('/v1/anything').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(handler).toHaveBeenCalledWith('account_erased');
  });

  it('apiErrorFrom: handler fires', async () => {
    const handler = vi.fn();
    registerSessionRefusalHandler(handler);
    const err = await apiErrorFrom(refusal(), 'fallback');
    expect(err.status).toBe(401);
    expect(handler).toHaveBeenCalledWith('account_erased');
  });

  it('assertSynced: handler fires and the write is REFUSED (never held as offline)', async () => {
    const handler = vi.fn();
    registerSessionRefusalHandler(handler);
    await expect(assertSynced(refusal())).rejects.toBeInstanceOf(SyncFailureError);
    expect(handler).toHaveBeenCalledWith('account_erased');
  });
});
