/**
 * The three states of the org read, asserted on the hook itself so the 17 pages
 * that consume it inherit the guarantee instead of each re-deriving it.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useOrgSelection } from '../useOrgSelection.js';
import { StrictMode } from 'react';

const A = { orgId: 'o1', name: 'Acme' };
const B = { orgId: 'o2', name: 'Beta' };
const C = { orgId: 'o3', name: 'Gamma' };

describe('useOrgSelection', () => {
  it('a failed read is NOT an empty list', async () => {
    // The whole point: `orgs` must not become `[]`, because every caller renders
    // `[]` as "no workspaces — create one to …", an instruction a failed read has
    // not earned.
    const listOrgs = vi.fn().mockRejectedValue(new Error('503'));
    const { result } = renderHook(() => useOrgSelection(listOrgs));
    await waitFor(() => expect(result.current.orgsFailed).toBe(true));
    expect(result.current.orgs).toBeNull();
    expect(result.current.orgId).toBe('');
  });

  it('a genuinely empty tenant reads as empty, not failed', async () => {
    const listOrgs = vi.fn().mockResolvedValue([]);
    const { result } = renderHook(() => useOrgSelection(listOrgs));
    await waitFor(() => expect(result.current.orgs).toEqual([]));
    expect(result.current.orgsFailed).toBe(false);
  });

  it('selects the first org on a successful read', async () => {
    const listOrgs = vi.fn().mockResolvedValue([A, B]);
    const { result } = renderHook(() => useOrgSelection(listOrgs));
    await waitFor(() => expect(result.current.orgId).toBe('o1'));
    expect(result.current.orgsFailed).toBe(false);
  });

  it('retry re-runs the read and clears the failure', async () => {
    // The hook's effect is the ONLY place the read happens, so a retry that does
    // not re-trigger it would clear the error and leave every dependent fetch
    // still ungated — the permanent skeleton, restored by the recovery path.
    const listOrgs = vi.fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue([A]);
    const { result } = renderHook(() => useOrgSelection(listOrgs));
    await waitFor(() => expect(result.current.orgsFailed).toBe(true));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.orgId).toBe('o1'));
    expect(result.current.orgsFailed).toBe(false);
    expect(listOrgs).toHaveBeenCalledTimes(2);
  });

  it('keeps a still-valid selection across a re-read, and drops a stale one', async () => {
    const listOrgs = vi.fn().mockResolvedValue([A, B]);
    const { result } = renderHook(() => useOrgSelection(listOrgs));
    await waitFor(() => expect(result.current.orgId).toBe('o1'));
    act(() => result.current.setOrgId('o2'));
    // HOLD the re-read and release it explicitly. Waiting on `toHaveBeenCalledTimes(2)`
    // passed the moment the read was ISSUED, before it resolved, so 'o2' was the
    // hand-set value and a hook that always took the first org stayed green (w49
    // probe `uos-keep`). The re-read must LAND before 'kept' means anything.
    let release!: (v: Array<typeof A>) => void;
    listOrgs.mockImplementationOnce(() => new Promise<Array<typeof A>>((r) => { release = r; }));
    act(() => result.current.retry());
    await waitFor(() => expect(listOrgs).toHaveBeenCalledTimes(2));
    // A DIFFERENT list ([A, B, C]) so `orgs` can only equal it once the re-read lands.
    await act(async () => { release([A, B, C]); await Promise.resolve(); });
    await waitFor(() => expect(result.current.orgs).toEqual([A, B, C]));
    expect(result.current.orgId).toBe('o2'); // still present after the re-read landed — kept
    listOrgs.mockResolvedValue([A]);         // o2 is gone now
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.orgId).toBe('o1'));
  });

  it('defers the read until enabled', async () => {
    // Feature-gated pages must not fetch before the toggle resolves.
    const listOrgs = vi.fn().mockResolvedValue([A]);
    const { result, rerender } = renderHook(({ on }: { on: boolean }) => useOrgSelection(listOrgs, on), {
      initialProps: { on: false },
    });
    expect(listOrgs).not.toHaveBeenCalled();
    expect(result.current.orgsFailed).toBe(false);
    rerender({ on: true });
    await waitFor(() => expect(result.current.orgId).toBe('o1'));
  });
});


function heldOrgs() {
  let resolve: (value: Array<typeof A>) => void = () => { throw new Error('promise not initialized'); };
  let reject: (error: Error) => void = () => { throw new Error('promise not initialized'); };
  const promise = new Promise<Array<typeof A>>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('useOrgSelection optional scope ownership', () => {
  it('masks an initial choice until membership confirms it and returns the actual catalog reference', async () => {
    const pending = heldOrgs();
    const list = vi.fn(() => pending.promise);
    const { result } = renderHook(() => useOrgSelection(list, true, 'o2', { scopeKey: 0 }));
    expect(result.current.orgs).toBeNull();
    expect(result.current.orgId).toBe('');
    const actual = [A, B];
    await act(async () => { pending.resolve(actual); await pending.promise; });
    expect(result.current.orgs).toBe(actual);
    expect(result.current.orgId).toBe('o2');
    act(() => result.current.setOrgId('foreign'));
    expect(result.current.orgId).toBe('');
  });

  it('masks a changed scope on its first render before the deferred read settles', async () => {
    const pending = heldOrgs();
    const actual = [A];
    const list = vi.fn<() => Promise<Array<typeof A>>>().mockResolvedValueOnce(actual).mockImplementationOnce(() => pending.promise);
    const rendered: Array<{ key: string; orgs: readonly typeof A[] | null; id: string; failed: boolean }> = [];
    const { result, rerender } = renderHook(({ key }: { key: string }) => {
      const selection = useOrgSelection(list, true, '', { scopeKey: key });
      rendered.push({ key, orgs: selection.orgs, id: selection.orgId, failed: selection.orgsFailed });
      return selection;
    }, { initialProps: { key: 'A' } });
    await waitFor(() => expect(result.current.orgs).toBe(actual));
    rerender({ key: 'B' });
    expect(rendered.find((r) => r.key === 'B')).toEqual({ key: 'B', orgs: null, id: '', failed: false });
    expect(result.current.orgs).toBeNull();
    await act(async () => { pending.resolve([B]); await pending.promise; });
    expect(result.current.orgId).toBe('o2');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('rejects late first-A and B reads after a committed A-B-A scope sequence', async () => {
    const first = heldOrgs(); const middle = heldOrgs(); const latest = heldOrgs();
    const list = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => middle.promise).mockImplementationOnce(() => latest.promise);
    const { result, rerender } = renderHook(({ key }: { key: string }) => useOrgSelection(list, true, '', { scopeKey: key }), { initialProps: { key: 'A' } });
    rerender({ key: 'B' }); rerender({ key: 'A' });
    await act(async () => { latest.resolve([C]); await latest.promise; });
    expect(result.current.orgId).toBe('o3');
    await act(async () => { first.resolve([A]); middle.reject(new Error('old B')); await first.promise; await middle.promise.catch(() => undefined); });
    expect(result.current.orgs).toEqual([C]);
    expect(result.current.orgId).toBe('o3');
    expect(result.current.orgsFailed).toBe(false);
  });

  it('ignores an old-scope failure after a newer scope succeeds', async () => {
    const old = heldOrgs();
    const list = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValueOnce([B]);
    const { result, rerender } = renderHook(({ key }: { key: number }) => useOrgSelection(list, true, '', { scopeKey: key }), { initialProps: { key: 0 } });
    rerender({ key: 1 });
    await waitFor(() => expect(result.current.orgId).toBe('o2'));
    await act(async () => { old.reject(new Error('obsolete')); await old.promise.catch(() => undefined); });
    expect(result.current.orgs).toEqual([B]); expect(result.current.orgsFailed).toBe(false);
  });

  it('invalidates a prior retry before its same-batch settlement can change the selected org', async () => {
    const old = heldOrgs(); const latest = heldOrgs();
    const list = vi.fn().mockResolvedValueOnce([A, B]).mockImplementationOnce(() => old.promise).mockImplementationOnce(() => latest.promise);
    const { result } = renderHook(() => useOrgSelection(list, true, '', { scopeKey: 0 }));
    await waitFor(() => expect(result.current.orgId).toBe('o1'));
    act(() => result.current.retry());
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await act(async () => { result.current.retry(); old.resolve([B]); await old.promise; });
    expect(result.current.orgs).toBeNull(); expect(result.current.orgId).toBe('');
    await act(async () => { latest.resolve([A, B]); await latest.promise; });
    expect(result.current.orgId).toBe('o1');
    expect(result.current.orgsFailed).toBe(false);
  });

  it('distinguishes a current failed read, pending retry and genuinely empty success', async () => {
    const retry = heldOrgs();
    const list = vi.fn().mockRejectedValueOnce(new Error('current')).mockImplementationOnce(() => retry.promise);
    const { result } = renderHook(() => useOrgSelection(list, true, 'o1', { scopeKey: 0 }));
    await waitFor(() => expect(result.current.orgsFailed).toBe(true));
    expect(result.current.orgs).toBeNull(); expect(result.current.orgId).toBe('');
    act(() => result.current.retry());
    expect(result.current.orgsFailed).toBe(false); expect(result.current.orgs).toBeNull(); expect(result.current.orgId).toBe('');
    await act(async () => { retry.resolve([]); await retry.promise; });
    expect(result.current.orgs).toEqual([]); expect(result.current.orgsFailed).toBe(false); expect(result.current.orgId).toBe('');
  });

  it('confirms the latest explicitly selected member when a current retry returns it', async () => {
    const pending = heldOrgs();
    const list = vi.fn().mockResolvedValueOnce([A, B]).mockImplementationOnce(() => pending.promise);
    const { result } = renderHook(() => useOrgSelection(list, true, '', { scopeKey: 0 }));
    await waitFor(() => expect(result.current.orgId).toBe('o1'));
    act(() => { result.current.retry(); result.current.setOrgId('o2'); });
    expect(result.current.orgId).toBe('');
    await act(async () => { pending.resolve([A, B]); await pending.promise; });
    expect(result.current.orgId).toBe('o2');
  });

  it('does not expose a previously accepted catalog across disable and re-enable', async () => {
    const next = heldOrgs();
    const list = vi.fn().mockResolvedValueOnce([A]).mockImplementationOnce(() => next.promise);
    const { result, rerender } = renderHook(({ on }: { on: boolean }) => useOrgSelection(list, on, '', { scopeKey: 0 }), { initialProps: { on: true } });
    await waitFor(() => expect(result.current.orgId).toBe('o1'));
    rerender({ on: false }); expect(result.current.orgs).toBeNull(); expect(result.current.orgId).toBe('');
    rerender({ on: true }); expect(result.current.orgs).toBeNull();
    await act(async () => { next.resolve([B]); await next.promise; });
    expect(result.current.orgId).toBe('o2'); expect(list).toHaveBeenCalledTimes(2);
  });

  it('does not refetch when only the inline options object or unrelated render changes', async () => {
    const list = vi.fn().mockResolvedValue([A]);
    const { result, rerender } = renderHook(({ key, unrelated }: { key: number; unrelated: number }) => {
      void unrelated;
      return useOrgSelection(list, true, '', { scopeKey: key });
    }, { initialProps: { key: 0, unrelated: 0 } });
    await waitFor(() => expect(result.current.orgId).toBe('o1'));
    rerender({ key: 0, unrelated: 1 });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('rejects the first StrictMode setup result after the rearmed read succeeds', async () => {
    const first = heldOrgs(); const second = heldOrgs();
    const list = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const { result } = renderHook(() => useOrgSelection(list, true, '', { scopeKey: 0 }), { wrapper: StrictMode });
    expect(list).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve([B]); await second.promise; });
    await act(async () => { first.resolve([A]); await first.promise; });
    expect(result.current.orgId).toBe('o2'); expect(result.current.orgs).toEqual([B]);
  });

  it('preserves three-argument initial and retry display semantics', async () => {
    const initial = heldOrgs(); const retry = heldOrgs();
    const list = vi.fn().mockImplementationOnce(() => initial.promise).mockImplementationOnce(() => retry.promise);
    const { result } = renderHook(() => useOrgSelection(list, true, 'o2'));
    expect(result.current.orgId).toBe('o2');
    const actual = [A, B];
    await act(async () => { initial.resolve(actual); await initial.promise; });
    act(() => result.current.retry());
    expect(result.current.orgs).toBe(actual); expect(result.current.orgId).toBe('o2'); expect(result.current.orgsFailed).toBe(false);
    await act(async () => { retry.reject(new Error('current retry')); await retry.promise.catch(() => undefined); });
    expect(result.current.orgs).toBe(actual); expect(result.current.orgId).toBe('o2'); expect(result.current.orgsFailed).toBe(true);
  });
});
