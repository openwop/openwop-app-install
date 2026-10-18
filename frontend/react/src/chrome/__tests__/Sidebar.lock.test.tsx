/**
 * ADR 0419 R3 — nav-wide lock rendering. A LOCKED feature (toggle on, plan/bundles
 * don't entitle it) shows a lock affordance and its nav link points to the feature
 * store (upsell) instead of its own page (which 403s). Presentation-only; the R2/P3
 * backend gate is the authority. The lock is asserted by its accessible name (the
 * localized `navLocked` label), never by a class name.
 *
 * Same harness, two more Sidebar contracts: ADR 0487 — the brand link renders the
 * resolved product name as ONE wordmark (no split `sub` line); and the mobile
 * quick-access bar projects the effective Pinned group and wires More to the
 * focus-returning primary drawer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BoxesIcon } from '../../ui/icons/index.js';

let lockedId: string | null = 'crm';
const LOCKED_NAME = 'Locked — unlock in the feature store';
// Chrome that fetches on mount is stubbed (no live network in this unit test).
vi.mock('../WorkspaceSwitcher.js', () => ({ WorkspaceSwitcher: () => null }));
vi.mock('../../notifications/NotificationBell.js', () => ({ NotificationBell: () => null }));
vi.mock('../../auth/SignInButton.js', () => ({ SignInButton: () => null }));

vi.mock('../navConfig/NavConfigProvider.js', () => ({
  useResolvedNav: () => ({
    workspace: [{ id: 'g', headerless: true, items: [{ to: '/crm', icon: BoxesIcon, label: 'CRM', featureId: 'crm' }] }],
  }),
}));
vi.mock('../../featureToggles/FeatureAccessContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureBadge: () => () => null,
  useFeatureLocked: () => (id?: string) => !!id && id === lockedId,
  useFeatureAccess: () => ({ status: 'off' as const, enabled: false, isBeta: false, variant: null, entitled: true, locked: false, loading: false, resolutionFailed: false }),
}));
vi.mock('../../client/useEffectiveAccess.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../client/useEffectiveAccess.js')>()),
  useEffectiveAccess: () => ({ roles: [], scopes: [], basis: 'none' }),
}));
vi.mock('../../brand/BrandProvider.js', () => ({
  useBrand: () => ({
    productName: 'KickTodo',
    instanceName: 'KickTodo',
    markSrc: '/kicktodo-mark.svg',
    markSrcDark: '',
  }),
}));
import { Sidebar } from '../Sidebar.js';

// Mount at /crm so the group holding it is revealed (sections auto-reveal the
// group with the active route), rendering its items.
const mount = () => render(<MemoryRouter initialEntries={['/crm']}><Sidebar netOpen={false} onToggleNet={() => {}} /></MemoryRouter>);
afterEach(() => { lockedId = 'crm'; cleanup(); });

describe('Sidebar — locked feature (ADR 0419)', () => {
  it('renders the resolved product identity as one unbroken wordmark', () => {
    mount();
    const home = screen.getByRole('link', { name: 'KickTodo home' });
    // The whole visible text of the brand link is the product name, once.
    expect(home.textContent).toBe('KickTodo');
    // Logo artwork is decorative (alt=""), so it has no accessible role; read the src.
    expect(home.querySelector('img')?.getAttribute('src')).toBe('/kicktodo-mark.svg');
  });

  it('a locked feature links to the store for THAT feature (which opens its bundle), not its own page', () => {
    mount();
    const link = within(screen.getByLabelText('Primary')).getByRole('link', { name: /CRM/i });
    // ADR 0419 §8 — the store resolves `?feature=` to the bundle that sells it
    // (BundleShopPage.test); the entry-chunk Sidebar does no lookup of its own.
    expect(link.getAttribute('href')).toBe('/marketplace/bundles?feature=crm');
    expect(within(link).getByRole('img', { name: LOCKED_NAME })).toBeTruthy(); // the lock affordance
  });

  it('an UNlocked feature links to its own page (no lock)', () => {
    lockedId = null; // nothing locked (billing off / entitled)
    mount();
    const link = within(screen.getByLabelText('Primary')).getByRole('link', { name: /CRM/i });
    expect(link.getAttribute('href')).toBe('/crm');
    expect(within(link).queryByRole('img', { name: LOCKED_NAME })).toBeNull();
  });

  it('projects effective pinned destinations into mobile quick access and keeps More wired to the full drawer', () => {
    lockedId = null;
    mount();
    const quickAccess = screen.getByRole('navigation', { name: 'Workspace quick access' });
    const link = within(quickAccess).getByRole('link', { name: 'CRM' });
    expect(link.getAttribute('href')).toBe('/crm');
    expect(link.getAttribute('aria-current')).toBe('page');
    const more = within(quickAccess).getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-controls')).toBe('app-primary-navigation');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    more.focus();
    fireEvent.click(more);
    expect(screen.getByRole('dialog', { name: 'Primary' })).toBeTruthy();
    expect(more.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(more);
  });
});
