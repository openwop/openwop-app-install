/**
 * ADR 0203 — admin-tier page enforcement (ADM-8). Pins the three gate states
 * of <AdminLayout>: unresolved access → quiet loading (no deny flash);
 * resolved non-admin → the honest "Administrator access required" StateCard;
 * resolved admin → the normal admin shell (rail + outlet). Presentation-only;
 * the backend 403s remain the authority.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AdminLayout } from '../AdminLayout.js';
import type { EffectiveAccess } from '../../client/accessClient.js';

const state: { access: EffectiveAccess; resolved: boolean } = {
  access: { roles: [], scopes: [], basis: 'none' },
  resolved: true,
};

vi.mock('../../client/useEffectiveAccess.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../client/useEffectiveAccess.js')>();
  return { ...real, useEffectiveAccessState: () => state };
});
vi.mock('../navConfig/NavConfigProvider.js', () => ({
  useResolvedNav: () => ({ admin: [], workspace: [] }),
}));
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureBadge: () => () => null,
  useFeatureLocked: () => () => false,
}));

function mount() {
  return render(
    <MemoryRouter initialEntries={['/orgs']}>
      <Routes>
        <Route element={<AdminLayout />}>
          <Route path="/orgs" element={<div>ORG PAGE BODY</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state.access = { roles: [], scopes: [], basis: 'none' };
  state.resolved = true;
});
afterEach(cleanup);

describe('AdminLayout gate (ADR 0203 / ADM-8)', () => {
  it('resolved non-admin → honest deny card, page body NOT rendered', () => {
    mount();
    expect(screen.getByText('Administrator access required')).toBeTruthy();
    expect(screen.queryByText('ORG PAGE BODY')).toBeNull();
  });

  it('resolved admin (built-in role) → renders the admin shell + page', () => {
    state.access = { roles: ['admin'], scopes: [], basis: 'member' };
    mount();
    expect(screen.getByText('ORG PAGE BODY')).toBeTruthy();
    expect(screen.queryByText('Administrator access required')).toBeNull();
  });

  it('custom role holding a host:*:manage scope counts as admin', () => {
    state.access = { roles: ['ops-custom'], scopes: ['host:members:manage'], basis: 'member' };
    mount();
    expect(screen.getByText('ORG PAGE BODY')).toBeTruthy();
  });

  it('unresolved → quiet loading, neither deny nor page (no deny flash)', () => {
    state.resolved = false;
    mount();
    expect(screen.queryByText('Administrator access required')).toBeNull();
    expect(screen.queryByText('ORG PAGE BODY')).toBeNull();
  });
});
