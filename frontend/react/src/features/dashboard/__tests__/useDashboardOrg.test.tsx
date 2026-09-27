/**
 * useDashboardOrg (ADR 0375 Phase 3) — the shared org resolver. Pins from the
 * architect review: the in-flight listOrgs() PROMISE is memoized module-wide (N
 * tiles → ONE request), and a rejection CLEARS the memo so it's retryable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const listOrgs = vi.fn();
vi.mock('../../../client/accessClient.js', () => ({ listOrgs: () => listOrgs() }));

import { useDashboardOrg, __resetDashboardOrgMemo } from '../useDashboardOrg.js';

beforeEach(() => { listOrgs.mockReset(); __resetDashboardOrgMemo(); });
afterEach(() => { __resetDashboardOrgMemo(); });

describe('useDashboardOrg', () => {
  it('resolves the first org id', async () => {
    listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'A' }, { orgId: 'org-2', name: 'B' }]);
    const { result } = renderHook(() => useDashboardOrg());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orgId).toBe('org-1');
    expect(result.current.error).toBe(false);
  });

  it('shares ONE listOrgs() request across concurrent consumers (memoized promise)', async () => {
    listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'A' }]);
    const a = renderHook(() => useDashboardOrg());
    const b = renderHook(() => useDashboardOrg());
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    await waitFor(() => expect(b.result.current.loading).toBe(false));
    expect(a.result.current.orgId).toBe('org-1');
    expect(b.result.current.orgId).toBe('org-1');
    expect(listOrgs).toHaveBeenCalledTimes(1); // one fetch, shared
  });

  it('reports no org when the caller has none (orgId null, not error)', async () => {
    listOrgs.mockResolvedValue([]);
    const { result } = renderHook(() => useDashboardOrg());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orgId).toBeNull();
    expect(result.current.error).toBe(false);
  });

  it('surfaces an error and CLEARS the memo so the next mount retries', async () => {
    listOrgs.mockRejectedValueOnce(new Error('boom'));
    const first = renderHook(() => useDashboardOrg());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.error).toBe(true);

    // memo cleared on reject → a fresh mount re-fetches (and can now succeed)
    listOrgs.mockResolvedValue([{ orgId: 'org-9', name: 'Z' }]);
    const second = renderHook(() => useDashboardOrg());
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(second.result.current.orgId).toBe('org-9');
    expect(listOrgs).toHaveBeenCalledTimes(2);
  });
});
