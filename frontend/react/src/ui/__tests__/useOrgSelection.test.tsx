/**
 * The three states of the org read, asserted on the hook itself so the 17 pages
 * that consume it inherit the guarantee instead of each re-deriving it.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useOrgSelection } from '../useOrgSelection.js';

const A = { orgId: 'o1', name: 'Acme' };
const B = { orgId: 'o2', name: 'Beta' };

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
    listOrgs.mockResolvedValue([A, B]);
    act(() => result.current.retry());
    await waitFor(() => expect(listOrgs).toHaveBeenCalledTimes(2));
    expect(result.current.orgId).toBe('o2'); // still present — kept
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
