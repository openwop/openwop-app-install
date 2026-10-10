/**
 * ADR 0815 D6 — the CONTROLLER composes the caller's own access with the lens.
 * `adr0815-owner-tier.test.tsx` injects `can` into the panel, so it cannot see the
 * controller: before this, `can` was `viewAs === null || …`, i.e. "no lens" meant
 * full access, and an admin was offered `owner` in every role picker and org
 * create in a workspace whose owners alone may do either.
 * Decision: docs/adr/0815-orgs-residual-subject-owner-tier-and-removal.md (D1a, D6).
 *
 * Before `getEffectiveAccess` resolves, own/root scopes are `null` (= unknown,
 * the server decides) and `can()` is TRUE — so a `waitFor(can(x) === true)`
 * passes on the UNLOADED state. Every case therefore settles the access read
 * explicitly (`settleAccess`) before asserting.
 *
 * Sabotage that turns it red: `can = lens(scope)` (own access ignored) reds the
 * ADMIN + NON-member cases; dropping the owner filter on `assignableRoleIds` or
 * the root-scope check in `canTenant` reds ADMIN; resolving a member basis to
 * empty scopes reds OWNER; `if (false)` on the create-refusal branch reds the last.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, renderHook, waitFor, act, fireEvent } from '@testing-library/react';
import type { EffectiveAccess } from '../../client/accessClient.js';

const WS = 'ws:acme';
const access = vi.hoisted(() => {
  const value: EffectiveAccess = { roles: ['admin'], scopes: ['host:members:manage', 'host:groups:manage', 'workspace:read'], basis: 'member' };
  return { value };
});
vi.mock('../../client/accessClient.js', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const stubbed = Object.fromEntries(
    Object.entries(real).map(([k, v]) => [k, typeof v === 'function' ? vi.fn(async () => []) : v]),
  );
  return {
    ...stubbed,
    listOrgs: vi.fn(async () => [{ orgId: WS, tenantId: WS, name: 'Acme', slug: 'acme', createdBy: 'x', createdAt: '', updatedAt: '' }]),
    getEffectiveAccess: vi.fn(async () => access.value),
    listOrgRoles: vi.fn(async () => ({ roles: [], customRoles: [] })),
    setActingMember: vi.fn(),
  };
});
vi.mock('../../client/workspaceClient.js', () => ({ listMyWorkspaces: vi.fn(async () => ({ active: WS, workspaces: [] })) }));

import { useOrgsController } from '../useOrgsController.js';
import * as accessClient from '../../client/accessClient.js';
import { ApiError } from '../../client/requestJson.js';

type Ctl = ReturnType<typeof useOrgsController>;

/** Mount, select the workspace org, and wait until BOTH access reads (the root
 *  lens from `loadOrgs` and the selected org's own access) have been answered. */
async function mountSelected(): Promise<{ current: Ctl }> {
  const getAccess = vi.mocked(accessClient.getEffectiveAccess);
  getAccess.mockClear();
  const { result } = renderHook(() => useOrgsController());
  await waitFor(() => expect(result.current.orgs.length).toBe(1));
  act(() => { result.current.setSelectedOrgId(WS); });
  // Root lens (loadOrgs) + own access (selection) — two reads for the same org.
  await waitFor(() => expect(getAccess).toHaveBeenCalledTimes(2));
  await act(async () => {}); // let both resolutions land in state
  return result;
}

describe('ADR 0815 D6 — the caller’s own access bounds what the page offers', () => {
  it('an ADMIN is not offered `owner`, org create, or owner-tier controls', async () => {
    access.value = { roles: ['admin'], scopes: ['host:members:manage', 'host:groups:manage', 'workspace:read'], basis: 'member' };
    const result = await mountSelected();
    expect(result.current.can('host:members:manage')).toBe(true);
    expect(result.current.assignableRoleIds).not.toContain('owner');
    expect(result.current.can('host:org:manage')).toBe(false);
    expect(result.current.canTenant('host:org:manage')).toBe(false);
  });

  it('an OWNER is offered all of it', async () => {
    access.value = { roles: ['owner'], scopes: ['host:members:manage', 'host:groups:manage', 'host:org:manage', 'workspace:read'], basis: 'member' };
    const result = await mountSelected();
    expect(result.current.can('host:org:manage')).toBe(true);
    expect(result.current.assignableRoleIds).toContain('owner');
    expect(result.current.canTenant('host:org:manage')).toBe(true);
  });

  it('a NON-member of a shared-workspace org is offered nothing (the server would refuse all of it)', async () => {
    access.value = { roles: [], scopes: [], basis: 'none' };
    const result = await mountSelected();
    expect(result.current.can('host:members:manage')).toBe(false);
    expect(result.current.canTenant('host:org:manage')).toBe(false);
  });

  it('a refused org create in a shared tenant says what to do, not a bare 403', async () => {
    access.value = { roles: ['viewer'], scopes: ['workspace:read'], basis: 'member' };
    vi.mocked(accessClient.createOrg).mockRejectedValueOnce(new ApiError({
      status: 403, statusText: 'Forbidden', url: '/orgs',
      body: { error: 'forbidden', message: 'Only an owner can create an organization here.', details: { code: 'owner_required' } },
    }));
    const { result } = renderHook(() => useOrgsController());
    await waitFor(() => expect(result.current.orgs.length).toBe(1));
    act(() => { result.current.setOrgName('Team'); });
    // A REAL React submit event (no cast): the handler is wired to a form the way
    // OrgsListPanel wires it.
    const { container } = render(<form onSubmit={(e) => { void result.current.onCreateOrg(e); }} />);
    const form = container.querySelector('form');
    if (!form) throw new Error('form did not render');
    await act(async () => { fireEvent.submit(form); });
    await waitFor(() => expect(result.current.error).toMatch(/Ask an owner of an existing organization/));
  });
});
