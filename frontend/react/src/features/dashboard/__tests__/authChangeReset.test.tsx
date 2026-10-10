/**
 * ADR 0846 D5 — the dashboard's tile caches belong to the identity that filled
 * them. Sign-out does not reload the page, so before this the next account to
 * sign in on the same tab was served the previous account's viewer-scoped reads
 * (sharedRead, 30 s) and kept the previous account's org (useDashboardOrg, until
 * a reload). Both legs were RED on `origin/main` (f8a3ea22e).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const listOrgs = vi.fn();
vi.mock('../../../client/accessClient.js', () => ({ listOrgs: () => listOrgs() }));

import { fireAuthChanged } from '../../../client/config.js';
import { sharedRead, __resetSharedReads } from '../sharedRead.js';
import { useDashboardOrg, __resetDashboardOrgMemo } from '../useDashboardOrg.js';

beforeEach(() => { listOrgs.mockReset(); __resetSharedReads(); __resetDashboardOrgMemo(); });

describe('ADR 0846 D5 — dashboard caches reset on an identity change', () => {
  it('sharedRead serves the cached value within its TTL, and refetches after an auth change', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('alice-report').mockResolvedValueOnce('bob-report');
    expect(await sharedRead('crm-pipeline:org-1', fetcher)).toBe('alice-report');
    expect(await sharedRead('crm-pipeline:org-1', fetcher)).toBe('alice-report'); // CONTROL: the cache works
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireAuthChanged(); // sign-out → sign-in on the same tab
    expect(await sharedRead('crm-pipeline:org-1', fetcher)).toBe('bob-report');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('a read in flight across the change is not cached for the next identity', async () => {
    let release!: (v: string) => void;
    const slow = vi.fn(() => new Promise<string>((r) => { release = r; }));
    const pending = sharedRead('csm-accounts', slow);
    fireAuthChanged();
    release('alice-accounts');
    expect(await pending).toBe('alice-accounts'); // the original caller still gets its answer
    const fresh = vi.fn().mockResolvedValue('bob-accounts');
    expect(await sharedRead('csm-accounts', fresh)).toBe('bob-accounts');
  });

  it('useDashboardOrg re-resolves the org after an auth change', async () => {
    listOrgs.mockResolvedValueOnce([{ orgId: 'org-alice', name: 'A' }]).mockResolvedValueOnce([{ orgId: 'org-bob', name: 'B' }]);
    const first = renderHook(() => useDashboardOrg());
    await waitFor(() => expect(first.result.current.orgId).toBe('org-alice'));
    first.unmount();
    fireAuthChanged();
    const second = renderHook(() => useDashboardOrg());
    await waitFor(() => expect(second.result.current.orgId).toBe('org-bob'));
    expect(listOrgs).toHaveBeenCalledTimes(2);
  });
});
