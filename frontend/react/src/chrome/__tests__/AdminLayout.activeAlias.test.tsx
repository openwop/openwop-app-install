/** Hub aliases must expose the same current-page state visually and to AT. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SettingsIcon } from '../../ui/icons/index.js';
import { AdminLayout } from '../AdminLayout.js';

vi.mock('../../client/useEffectiveAccess.js', () => ({
  useEffectiveAccessState: () => ({ access: { roles: ['admin'], scopes: [], basis: 'member' }, resolved: true }),
  isAdminCaller: () => true,
}));
vi.mock('../navConfig/NavConfigProvider.js', () => ({
  useResolvedNav: () => ({
    workspace: [], site: [], degraded: false,
    admin: [{
      id: 'Platform', label: 'Platform',
      items: [{ to: '/models', activeFor: ['/model-router'], label: 'Models', hint: 'Models', icon: SettingsIcon }],
    }],
  }),
}));
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureBadge: () => () => null,
  useFeatureLocked: () => () => false,
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('AdminLayout active aliases', () => {
  it('marks the visible hub link current for a represented direct URL', () => {
    render(
      <MemoryRouter initialEntries={['/model-router']}>
        <Routes>
          <Route element={<AdminLayout />}>
            <Route path="/model-router" element={<div>MODEL ROUTER</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Models' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('navigation', { name: 'Admin sections' })).toBeTruthy();
  });

  it('uses a labeled accordion on mobile even when the desktop rail was collapsed', () => {
    localStorage.setItem('openwop.admin.railCollapsed', '1');
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 860px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route element={<AdminLayout />}>
            <Route path="/admin" element={<div>OVERVIEW</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const group = screen.getByRole('button', { name: 'Platform' });
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('link', { name: 'Models' })).toBeNull();
    fireEvent.click(group);
    expect(screen.getByRole('link', { name: 'Models' })).toBeTruthy();
  });
});
