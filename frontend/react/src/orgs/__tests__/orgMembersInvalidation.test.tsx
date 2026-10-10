/**
 * CLNP-2(d) — the shared member cache is actually INVALIDATED, and it expires.
 *
 * `invalidateOrgMembers` existed with zero callers, and kanban kept a second,
 * never-invalidated copy of the same cache beside it (`invalidateMembersCache`, also
 * zero callers). So a member removed in Settings stayed pickable in the kanban
 * assignee picker and KickTodo Circles for the life of the page. These pin the wiring,
 * not just the mechanism: the mutation handlers DROP the shared cache (asserted as
 * the outcome — the next picker load refetches — not as a spy on the call), and a
 * list cached in another session's absence expires on its own.
 *
 * Sabotage that turns it red: deleting `invalidateOrgMembers(selectedOrgId)` after
 * deleteMember / updateMember reds the matching it.each row; ignoring the TTL
 * (`if (hit)`) reds the expiry case; a whole-cache invalidation that leaves the
 * in-flight slot (`inFlight.clear()` removed) reds the first-load case.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { OrgMember } from '../../client/accessClient.js';

const api = vi.hoisted(() => ({
  listMembers: vi.fn(async (_orgId: string): Promise<OrgMember[]> => []),
  createMember: vi.fn(async () => ({})),
  updateMember: vi.fn(async () => ({})),
  deleteMember: vi.fn(async () => undefined),
}));
vi.mock('../../client/accessClient.js', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  // Every other read the controller makes on mount resolves empty — this test is
  // about the mutation → invalidation edge, not the page's data.
  const stubbed = Object.fromEntries(
    Object.entries(real).map(([k, v]) => [k, typeof v === 'function' ? vi.fn(async () => []) : v]),
  );
  return { ...stubbed, ...api, listOrgRoles: vi.fn(async () => ({ roles: [], customRoles: [] })) };
});
vi.mock('../../client/workspaceClient.js', () => ({ listMyWorkspaces: vi.fn(async () => ({ active: 'ws_active', workspaces: [] })) }));
vi.mock('../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));

import { loadOrgMembers, invalidateOrgMembers } from '../orgMembers.js';
import { useOrgsController } from '../useOrgsController.js';

type Ctl = ReturnType<typeof useOrgsController>;
const MEMBER: OrgMember = {
  memberId: 'm1', orgId: 'org_1', tenantId: 'ws_active', subject: 'user_1', displayName: 'Ada',
  roles: ['viewer'], teamIds: [], createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
};
const STALE: OrgMember = { ...MEMBER, displayName: 'STALE' };

beforeEach(() => {
  vi.clearAllMocks();
  invalidateOrgMembers();
});

describe('the loader expires (the change no mutation in THIS tab can see)', () => {
  it('serves the cache inside the TTL and refetches after it', async () => {
    let t = 1_000_000;
    const now = () => t;
    api.listMembers.mockResolvedValue([MEMBER]);
    await loadOrgMembers('org_1', now);
    t += 59_000;
    await loadOrgMembers('org_1', now);
    expect(api.listMembers).toHaveBeenCalledTimes(1);
    t += 2_000; // 61 s after the first read
    await loadOrgMembers('org_1', now);
    expect(api.listMembers).toHaveBeenCalledTimes(2);
  });
});

describe('a whole-cache invalidation disowns a FIRST load still in flight', () => {
  it('the stale first load is not cached', async () => {
    let release!: (v: OrgMember[]) => void;
    api.listMembers.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const first = loadOrgMembers('org_new');
    await vi.waitFor(() => expect(api.listMembers).toHaveBeenCalledTimes(1));
    invalidateOrgMembers(); // e.g. an invite was accepted — no per-org entry exists yet
    release([STALE]);
    await first;
    api.listMembers.mockResolvedValueOnce([MEMBER]);
    await expect(loadOrgMembers('org_new')).resolves.toEqual([MEMBER]);
    expect(api.listMembers).toHaveBeenCalledTimes(2);
  });
});

describe('member mutations invalidate the shared cache', () => {
  it.each([
    ['delete', (c: Ctl) => c.onDeleteMember(MEMBER)],
    ['save roles', (c: Ctl) => c.onSaveRoles(MEMBER)],
  ])('%s calls invalidateOrgMembers(selectedOrgId) — the next picker load refetches', async (_label, act_) => {
    window.history.replaceState(null, '', '/orgs?org=org_1');
    // A picker elsewhere (kanban, Circles, comments) has cached the OLD list.
    api.listMembers.mockResolvedValue([STALE]);
    await expect(loadOrgMembers('org_1')).resolves.toEqual([STALE]);
    const { result } = renderHook(() => useOrgsController());
    await waitFor(() => expect(result.current.selectedOrgId).toBe('org_1'));
    // The server's post-mutation truth. The controller's own detail reload reads
    // `listMembers` directly, not through the loader, so it cannot refill the cache.
    api.listMembers.mockResolvedValue([MEMBER]);
    await act(async () => { await act_(result.current); });
    // Inside the 60 s TTL: only an invalidation makes this a refetch.
    await expect(loadOrgMembers('org_1')).resolves.toEqual([MEMBER]);
  });
});
