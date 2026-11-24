/** Real App site-shell lifecycle; each file owns its lazy-module gate. */
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate, useParams } from 'react-router-dom';
import type { UseAuth } from '../../auth/useAuth.js';
import type { FeatureRoute } from '../featureTypes.js';
import type { ResolvedAssignment } from '../../client/featureTogglesClient.js';
import type { MenuConfigBundle } from '../navConfig/types.js';

const h = vi.hoisted(() => {
  let release!: () => void;
  let reject!: (reason: Error) => void;
  const gate = new Promise<void>((yes, no) => { release = yes; reject = no; });
  const auth: UseAuth = {
    user: null, loading: false, isConfigured: true,
    signIn: { google: vi.fn(async () => {}), github: vi.fn(async () => {}) },
    signOut: vi.fn(async () => {}),
  };
  const unexpected: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    unexpected.push(String(input));
    throw new Error('Unadmitted site-shell fixture transport');
  });
  vi.stubGlobal('fetch', fetch);
  return {
    gate, release, reject, auth, unexpected, fetch,
    routes: [] as FeatureRoute[], entered: 0,
    connect: vi.fn(async () => {}), disconnect: vi.fn(),
    reviewConnect: vi.fn(async () => {}), reviewDisconnect: vi.fn(),
    prefetch: vi.fn(), reload: vi.fn(),
    assignments: vi.fn(async (): Promise<{ assignments: ResolvedAssignment[] }> => ({
      assignments: [{ id: 'fixture-site', enabled: true, status: 'beta', variant: 'fixture-variant' }],
    })),
    entitlements: vi.fn(async (): Promise<'*' | string[]> => '*'),
    menu: vi.fn(async (): Promise<MenuConfigBundle> => ({
      tenant: { items: {}, headers: [{ id: 'Fixture', tier: 'site', label: 'Loaded fixture menu' }] },
      user: { items: {}, headers: [] },
    })),
  };
});
vi.mock('../../auth/useAuth.js', () => ({ useAuth: () => h.auth }));
vi.mock('../../auth/SignInButton.js', () => ({
  SignInButton: () => <button type="button">Fixture sign-in affordance</button>,
}));
vi.mock('../../auth/reloadIntoSession.js', () => ({ reloadIntoSession: h.reload }));
vi.mock('../../notifications/notificationStore.js', () => ({
  useNotificationStore: <T,>(select: (state: {
    panelOpen: boolean; connect: () => Promise<void>; disconnect: () => void;
  }) => T): T => select({ panelOpen: false, connect: h.connect, disconnect: h.disconnect }),
}));
vi.mock('../../chat/reviews/reviewStatusStore.js', () => ({
  useReviewStatusStore: { getState: () => ({ connect: h.reviewConnect, disconnect: h.reviewDisconnect }) },
}));
vi.mock('../../walkthroughs/corePacks.js', () => ({ registerCoreWalkthroughPacks: vi.fn() }));
vi.mock('../../client/featureTogglesClient.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../client/featureTogglesClient.js')>(),
  fetchAssignments: h.assignments, fetchEntitlements: h.entitlements,
}));
vi.mock('../navConfig/menuConfigClient.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../navConfig/menuConfigClient.js')>(),
  getMenuConfig: h.menu,
}));
vi.mock('../features.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../features.js')>(),
  FEATURES: h.routes, prefetchChatTab: h.prefetch,
}));

vi.mock('../SiteShell.js', async (importOriginal) => {
  h.entered += 1;
  await h.gate;
  return importOriginal<typeof import('../SiteShell.js')>();
});

import { App } from '../../App.js';
import { brand } from '../../brand/brand.js';
import i18n from '../../i18n/index.js';

const originalGateMode = brand.appGate.mode;
afterEach(() => {
  cleanup();
  brand.appGate.mode = originalGateMode;
  vi.unstubAllGlobals();
});

import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { useNavConfig } from '../navConfig/NavConfigProvider.js';

function Probe(): JSX.Element {
  const { slug } = useParams();
  const access = useFeatureAccess('fixture-site');
  const nav = useNavConfig();
  return (
    <output data-testid="site-probe" data-slug={slug}
      data-access-loading={String(access.loading)} data-enabled={String(access.enabled)}
      data-status={access.status} data-variant={access.variant ?? ''}
      data-access-failed={String(access.resolutionFailed)}
      data-menu-loading={String(nav.loading)} data-menu-failed={String(nav.failed)}
      data-menu-label={nav.bundle.tenant.headers[0]?.label ?? ''}>
      Fixture route body
    </output>
  );
}
const Icon = (): JSX.Element => <svg aria-hidden="true" />;
function Harness(): JSX.Element {
  const navigate = useNavigate();
  return <>
    <button type="button" onClick={() => navigate('/__fixture-required/beta')}>Visit required fixture</button>
    <App />
  </>;
}
function tree(): JSX.Element {
  return <MemoryRouter initialEntries={['/__fixture-optional/alpha']}><Harness /></MemoryRouter>;
}
function expectLoadedProbe(slug: string): void {
  const probe = screen.getByTestId('site-probe');
  expect(probe.getAttribute('data-slug')).toBe(slug);
  expect(probe.getAttribute('data-access-loading')).toBe('false');
  expect(probe.getAttribute('data-enabled')).toBe('true');
  expect(probe.getAttribute('data-status')).toBe('beta');
  expect(probe.getAttribute('data-variant')).toBe('fixture-variant');
  expect(probe.getAttribute('data-access-failed')).toBe('false');
  expect(probe.getAttribute('data-menu-loading')).toBe('false');
  expect(probe.getAttribute('data-menu-failed')).toBe('false');
  expect(probe.getAttribute('data-menu-label')).toBe('Loaded fixture menu');
}

it('keeps a cold optional site in the real loading landmark, resolves params/providers, and gates a required route', async () => {
  brand.appGate.mode = 'sign-in';
  h.routes.push(
    { path: '/__fixture-optional/:slug', tier: 'site', auth: 'optional', archetype: 'detail',
      element: <Probe />, nav: { group: 'Fixture', label: 'Optional fixture', icon: Icon, featureId: 'fixture-site' } },
    { path: '/__fixture-required/:slug', tier: 'site', auth: 'required', archetype: 'detail',
      element: <Probe />, nav: { group: 'Fixture', label: 'Required fixture', icon: Icon, featureId: 'fixture-site' } },
  );
  const view = render(tree());
  await waitFor(() => expect(h.entered).toBe(1));
  const pendingMain = screen.getByRole('main');
  expect(pendingMain.id).toBe('site-main');
  expect(pendingMain.tabIndex).toBe(-1);
  const loading = within(pendingMain).getByRole('status', { name: i18n.t('common:loading') });
  expect(loading.getAttribute('aria-busy')).toBe('true');
  expect(screen.getAllByRole('main')).toHaveLength(1);
  expect(screen.queryByTestId('site-probe')).toBeNull();
  expect(document.querySelector('.site-shell')).toBeNull();

  await act(async () => { h.release(); await h.gate; });
  await waitFor(() => expectLoadedProbe('alpha'));
  const siteMain = screen.getByRole('main');
  expect(siteMain.id).toBe('site-main');
  expect(siteMain.closest('.site-shell')).not.toBeNull();
  expect(screen.getAllByRole('main')).toHaveLength(1);
  expect(screen.getByRole('link', { name: i18n.t('common:skipToContent') }).getAttribute('href')).toBe('#site-main');
  expect(screen.getAllByRole('link', { name: 'Optional fixture' }).some((link) =>
    link.getAttribute('href') === '/__fixture-optional/:slug')).toBe(true);
  expect(document.querySelectorAll('[data-owp-live="polite"]')).toHaveLength(1);
  expect(document.querySelectorAll('[data-owp-live="assertive"]')).toHaveLength(1);
  expect(h.assignments).toHaveBeenCalled();
  expect(h.entitlements).toHaveBeenCalled();
  expect(h.menu).toHaveBeenCalled();
  expect(h.connect).toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Visit required fixture' }));
  expect(screen.getByRole('heading', { name: i18n.t('chrome:signIn') })).toBeTruthy();
  expect(screen.getByRole('main').classList.contains('app-gate')).toBe(true);
  expect(screen.queryByTestId('site-probe')).toBeNull();
  expect(document.querySelector('.site-shell')).toBeNull();
  expect(h.entered).toBe(1);

  h.auth.user = {
    uid: 'fixture-user', email: 'fixture@example.test', displayName: 'Fixture User',
    photoURL: null, providerIds: ['google.com'],
  };
  view.rerender(tree());
  await waitFor(() => expectLoadedProbe('beta'));
  expect(screen.queryByRole('heading', { name: i18n.t('chrome:signIn') })).toBeNull();
  expect(screen.getByRole('main').closest('.site-shell')).not.toBeNull();
  expect(screen.getAllByRole('main')).toHaveLength(1);
  expect(h.entered).toBe(1);
  expect(h.reload).not.toHaveBeenCalled();
  // Unknown transport is a failed fixture admission, never a blanket successful backend.
  expect(h.unexpected).toEqual([]);
});
