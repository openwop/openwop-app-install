/**
 * CLNP-2(d) — the shared member cache is actually INVALIDATED, and it expires.
 *
 * `invalidateOrgMembers` existed with zero callers, and kanban kept a second,
 * never-invalidated copy of the same cache beside it (`invalidateMembersCache`, also
 * zero callers). So a member removed in Settings stayed pickable in the kanban
 * assignee picker and KickTodo Circles for the life of the page. These pin the wiring,
 * not just the mechanism: the mutation handlers call the invalidation, and a list
 * cached in another session's absence expires on its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  listMembers: vi.fn(async () => [] as unknown[]),
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
import * as orgMembers from '../orgMembers.js';
import { useOrgsController } from '../useOrgsController.js';
import type { OrgMember } from '../../client/accessClient.js';

type Ctl = ReturnType<typeof useOrgsController>;
const MEMBER: OrgMember = {
  memberId: 'm1', orgId: 'org_1', tenantId: 'ws_active', subject: 'user_1', displayName: 'Ada',
  roles: ['viewer'], teamIds: [], createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  invalidateOrgMembers();
});

describe('the loader expires (the change no mutation in THIS tab can see)', () => {
  it('serves the cache inside the TTL and refetches after it', async () => {
    let t = 1_000_000;
    const now = () => t;
    api.listMembers.mockResolvedValue([{ subject: 'user_1', displayName: 'Ada' }]);
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
    let release!: (v: unknown[]) => void;
    api.listMembers.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const first = loadOrgMembers('org_new');
    await vi.waitFor(() => expect(api.listMembers).toHaveBeenCalledTimes(1));
    invalidateOrgMembers(); // e.g. an invite was accepted — no per-org entry exists yet
    release([{ subject: 'user_1', displayName: 'STALE' }]);
    await first;
    api.listMembers.mockResolvedValueOnce([{ subject: 'user_1', displayName: 'Ada' }]);
    await expect(loadOrgMembers('org_new')).resolves.toEqual([{ subject: 'user_1', displayName: 'Ada' }]);
    expect(api.listMembers).toHaveBeenCalledTimes(2);
  });
});

describe('member mutations invalidate the shared cache', () => {
  it.each([
    ['delete', (c: Ctl) => c.onDeleteMember(MEMBER)],
    ['save roles', (c: Ctl) => c.onSaveRoles(MEMBER)],
  ])('%s calls invalidateOrgMembers(selectedOrgId)', async (_label, act_) => {
    window.history.replaceState(null, '', '/orgs?org=org_1');
    const spy = vi.spyOn(orgMembers, 'invalidateOrgMembers');
    const { result } = renderHook(() => useOrgsController());
    await waitFor(() => expect(result.current.selectedOrgId).toBe('org_1'));
    spy.mockClear();
    await act(async () => { await act_(result.current); });
    expect(spy).toHaveBeenCalledWith('org_1');
  });
});
