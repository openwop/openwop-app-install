/**
 * ADR 0641 (auth posture is a per-route property) — signed-out bare-path
 * redirects (myndhyve.ai, 2026-11-07, `9e0ff0ec9`; no ADR of its own). `/features`,
 * `/agencies`, `/capabilities`, `/compare`, `/campaign-studio` and
 * `/vulnerability-disclosure` forward to `/p/<slug>` for a SIGNED-OUT visitor on
 * a sign-in-gated deployment. Several are real app routes, so a signed-in
 * visitor must still get the app, and a visitor whose auth is still resolving
 * must not be bounced before we know.
 *
 * Covers the pure decision and the hook end to end (page published → forward
 * with query+hash; page missing → no redirect, the sign-in wall stays).
 *
 * Sabotage that turns it red (each witnessed): drop the `hasUser` check (a
 * signed-in visitor is redirected); drop the `authLoading` wait; drop the
 * `gateMode` check (the gate-less demo app loses its routes); make the path
 * match a prefix (`/campaign-studio/plans/1` redirects); drop the existence
 * check (a missing page forwards into a 404); drop `search`/`hash` from the
 * target (re-measured, /grade-tests wave 95, with the `.catch` fallback and
 * the no-fetch-without-a-candidate early return).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';

const fetchMock = { exists: true, calls: [] as string[] };
const pageExists = async (slug: string): Promise<boolean> => { fetchMock.calls.push(slug); return fetchMock.exists; };

import { decideSignedOutRedirect, signedOutPageSlug, SIGNED_OUT_PAGE_PATHS } from '../signedOutPageRedirect.js';
import { useSignedOutPageRedirect } from '../useSignedOutPageRedirect.js';

const base = { gateMode: 'sign-in' as const, hasUser: false, authLoading: false };

beforeEach(() => { fetchMock.exists = true; fetchMock.calls = []; });
afterEach(cleanup);

describe('signedOutPageSlug', () => {
  it('matches exactly the six bare paths, one trailing slash allowed', () => {
    expect([...SIGNED_OUT_PAGE_PATHS].sort()).toEqual(
      ['agencies', 'campaign-studio', 'capabilities', 'compare', 'features', 'vulnerability-disclosure'],
    );
    for (const p of SIGNED_OUT_PAGE_PATHS) {
      expect(signedOutPageSlug(`/${p}`)).toBe(p);
      expect(signedOutPageSlug(`/${p}/`)).toBe(p);
    }
  });

  it('never matches an app deep link under one of those paths, or another path', () => {
    expect(signedOutPageSlug('/campaign-studio/plans/abc')).toBeNull();
    expect(signedOutPageSlug('/features/x')).toBeNull();
    expect(signedOutPageSlug('/dashboard')).toBeNull();
    expect(signedOutPageSlug('/p/features')).toBeNull();
    expect(signedOutPageSlug('/')).toBeNull();
  });
});

describe('decideSignedOutRedirect', () => {
  it('checks the page for a signed-out visitor once auth has resolved', () => {
    expect(decideSignedOutRedirect({ ...base, pathname: '/compare' })).toEqual({ kind: 'check', slug: 'compare' });
  });

  it('leaves a signed-in visitor on the app route', () => {
    expect(decideSignedOutRedirect({ ...base, hasUser: true, pathname: '/compare' })).toEqual({ kind: 'none' });
  });

  it('waits while auth is still resolving instead of redirecting', () => {
    expect(decideSignedOutRedirect({ ...base, authLoading: true, pathname: '/features' })).toEqual({ kind: 'wait' });
  });

  it('does nothing on a deployment without the sign-in gate', () => {
    expect(decideSignedOutRedirect({ ...base, gateMode: 'none', pathname: '/features' })).toEqual({ kind: 'none' });
    expect(decideSignedOutRedirect({ ...base, gateMode: 'password', pathname: '/features' })).toEqual({ kind: 'none' });
  });
});

describe('useSignedOutPageRedirect', () => {
  const hook = (o: Partial<Parameters<typeof useSignedOutPageRedirect>[0]> = {}) =>
    renderHook(() => useSignedOutPageRedirect({ ...base, pathname: '/campaign-studio', search: '?utm_source=ad', hash: '#top', pageExists, ...o }));

  it('forwards to /p/<slug> with the query and hash when the page is published', async () => {
    const { result } = hook();
    expect(result.current).toEqual({ kind: 'pending' });
    await waitFor(() => expect(result.current).toEqual({ kind: 'redirect', to: '/p/campaign-studio?utm_source=ad#top' }));
    expect(fetchMock.calls).toEqual(['campaign-studio']);
  });

  it('keeps the sign-in wall when the host-site has no such page', async () => {
    fetchMock.exists = false;
    const { result } = hook();
    await waitFor(() => expect(result.current).toEqual({ kind: 'none' }));
  });

  it('keeps the sign-in wall when the page read fails', async () => {
    const { result } = hook({ pageExists: async () => { throw new Error('offline'); } });
    await waitFor(() => expect(result.current).toEqual({ kind: 'none' }));
  });

  it('holds, and fetches nothing, while auth resolves; a user who then signs in is never forwarded', () => {
    const props: Parameters<typeof useSignedOutPageRedirect>[0] = { ...base, authLoading: true, pathname: '/compare', search: '', hash: '', pageExists };
    const { result, rerender } = renderHook((p: typeof props) => useSignedOutPageRedirect(p), { initialProps: props });
    expect(result.current).toEqual({ kind: 'pending' });
    expect(fetchMock.calls).toEqual([]);
    rerender({ ...props, authLoading: false, hasUser: true });
    expect(result.current).toEqual({ kind: 'none' });
    expect(fetchMock.calls).toEqual([]);
  });

  it('never fetches, and never redirects, for a signed-in visitor', () => {
    const { result } = hook({ hasUser: true });
    expect(result.current).toEqual({ kind: 'none' });
    expect(fetchMock.calls).toEqual([]);
  });
});
