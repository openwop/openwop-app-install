/** ADR 0398 P3 / ADR 0712 — the shared name-only saved-key inventory (KB reindex and
 * run options); names only, no value resolution. A scope or auth change must leave no
 * other scope's key names verified, even for one render.
 * Sabotage-witnessed (w93): prefix-matching provider ids; not stripping `byok:`; no
 * render-phase scope invalidation; accepting a stale read; no generation bump or
 * invalidate callback on auth change; reading while disabled. */
import { StrictMode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireAuthChanged } from '../../../client/config.js';
import { refsForExactProviders, useStoredCredentialRefs } from '../useStoredCredentialRefs.js';
const list = vi.hoisted(() => vi.fn<typeof import('../byokClient.js')['listStoredRefs']>());
vi.mock('../byokClient.js', () => ({ listStoredRefs: list }));
function deferred<T>() { let resolve: (value: T) => void = () => { throw new Error('Promise not initialized'); }; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => list.mockReset().mockResolvedValue(['google:current']));
afterEach(cleanup);
it('filters exact/colon provider names including optional byok prefix, excluding prefix overlaps and unrelated vendors', () => {
  expect(refsForExactProviders(['google', 'google:qa', 'byok:google:qa', 'google-vertex:team', 'googles:qa', 'cohere:qa', 'billing:stripe-key'], ['google'])).toEqual(['google', 'google:qa', 'byok:google:qa']);
});
it('does not carry the previous scope failure into the new scope while its read remains unresolved', async () => {
  const pending = deferred<string[]>(); list.mockRejectedValueOnce(new Error('old scope unavailable')).mockReturnValueOnce(pending.promise);
  // Record every render: the first render of a new scope runs BEFORE its effects, and
  // must already be unverified (no carried failure, no carried names).
  const renders: Array<{ scopeKey: string; failed: boolean; refs: readonly string[] | undefined }> = [];
  const { result, rerender } = renderHook(({ scopeKey }) => {
    const hook = useStoredCredentialRefs({ enabled: true, scopeKey });
    renders.push({ scopeKey, failed: hook.failed, refs: hook.refs });
    return hook;
  }, { initialProps: { scopeKey: 'first' } });
  await waitFor(() => expect(result.current.failed).toBe(true));
  rerender({ scopeKey: 'second' });
  expect(renders.find(entry => entry.scopeKey === 'second')).toEqual({ scopeKey: 'second', failed: false, refs: undefined });
  expect(result.current.failed).toBe(false); expect(result.current.refs).toBeUndefined(); expect(result.current.pending).toBe(true);
  await act(async () => pending.resolve(['cohere:second'])); expect(result.current.refs).toEqual(['cohere:second']); expect(result.current.isVerified()).toBe(true);
});
it('rejects old-scope and ABA late successes while preserving only the latest scope inventory', async () => {
  const first = deferred<string[]>(); const second = deferred<string[]>();
  list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValueOnce(['google:new-first']);
  const { result, rerender } = renderHook(({ scopeKey }) => useStoredCredentialRefs({ enabled: true, scopeKey }), { initialProps: { scopeKey: 'first' } });
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1)); rerender({ scopeKey: 'second' }); await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  rerender({ scopeKey: 'first' }); await waitFor(() => expect(result.current.refs).toEqual(['google:new-first']));
  await act(async () => { first.resolve(['google:old-first']); second.resolve(['cohere:old-second']); });
  expect(result.current.refs).toEqual(['google:new-first']);
});
it('invalidates loaded metadata synchronously on auth change and stays invalid after unmount', async () => {
  const pending = deferred<string[]>(); list.mockResolvedValueOnce(['google:old']).mockReturnValueOnce(pending.promise);
  const invalidated = vi.fn(); const { result, unmount } = renderHook(() => useStoredCredentialRefs({ enabled: true, onInvalidate: invalidated }));
  await waitFor(() => expect(result.current.isVerified()).toBe(true)); const old = result.current; const token = old.capture();
  act(() => { fireAuthChanged(); expect(old.isVerified()).toBe(false); expect(old.isCurrent(token)).toBe(false); });
  expect(invalidated).toHaveBeenCalledTimes(1); unmount(); await act(async () => pending.resolve(['google:obsolete']));
  expect(old.isCurrent(token)).toBe(false);
});
it('survives StrictMode effect replay and performs no read while disabled', async () => {
  const { result, rerender } = renderHook(({ enabled }) => useStoredCredentialRefs({ enabled }), { initialProps: { enabled: false }, wrapper: StrictMode });
  expect(list).not.toHaveBeenCalled(); expect(result.current.pending).toBe(false);
  rerender({ enabled: true }); await waitFor(() => expect(result.current.refs).toEqual(['google:current'])); expect(result.current.isVerified()).toBe(true);
});
