/**
 * ADR 0492 — the identity seam, and specifically the arm that used to be a
 * silent `false`.
 *
 * `isMine` returns `boolean | 'unknown'`. The whole point is that `'unknown'`
 * is NOT `false`, because `false` is the permissive answer for "is this mine?"
 * (own-row guards stop firing) and the restrictive answer for "may I manage
 * it?" (owner-only controls vanish). All three arms are asserted — pinning only
 * the unknown arm would stay green if this regressed to "always unknown".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';

const getMyProfile = vi.fn();
vi.mock('../profilesClient.js', () => ({
  getMyProfile: (...a: unknown[]) => getMyProfile(...a),
}));

import { isMine, useMyIdentity, type MyIdentity } from '../useMyIdentity.js';

beforeEach(() => { getMyProfile.mockReset(); });
afterEach(cleanup);

describe('isMine — unknown is not false', () => {
  const known: MyIdentity = { status: 'known', userId: 'u1', profile: {} as never };

  it('true for your own row', () => {
    expect(isMine(known, 'u1')).toBe(true);
  });

  it('false for someone else’s row', () => {
    expect(isMine(known, 'u2')).toBe(false);
  });

  it("'unknown' — NOT false — when identity could not be read", () => {
    expect(isMine({ status: 'unknown', error: 'boom' }, 'u1')).toBe('unknown');
    // The regression this guards: `=== false` would let an own-row guard through.
    expect(isMine({ status: 'unknown', error: 'boom' }, 'u1')).not.toBe(false);
  });

  it("'unknown' while still loading, so nothing is asserted early", () => {
    expect(isMine({ status: 'loading' }, 'u1')).toBe('unknown');
  });

  it('false for a row with no owner, even when identity IS known', () => {
    // An absent owner is a real "not yours" — it must not be conflated with
    // "we could not tell", or the caller would disable controls for empty rows.
    expect(isMine(known, null)).toBe(false);
  });
});

describe('useMyIdentity', () => {
  it('resolves to known on a successful read', async () => {
    getMyProfile.mockResolvedValue({ userId: 'u1', displayName: 'Sam' });
    const { result } = renderHook(() => useMyIdentity());
    await waitFor(() => expect(result.current.status).not.toBe('loading'));
    expect(result.current).toMatchObject({ status: 'known', userId: 'u1' });
  });

  it('resolves to unknown — carrying NO userId — when the read throws', async () => {
    getMyProfile.mockRejectedValue(new Error('identity read failed'));
    const { result } = renderHook(() => useMyIdentity());
    // Settle on ANY resolution rather than on the expected one, so the assertions
    // below are REACHED when the hook resolves the wrong way. Waiting directly on
    // `.toBe('unknown')` threw first, which left the shape checks after it
    // unevaluated under sabotage — red file, unverified assertions.
    await waitFor(() => expect(result.current.status).not.toBe('loading'));
    expect(result.current.status).toBe('unknown');
    // Deliberately absent: a caller wanting an id must handle this arm first.
    expect('userId' in result.current).toBe(false);
    expect(result.current).toMatchObject({ error: 'identity read failed' });
  });
});
