/** Real App site-shell lifecycle; each file owns its lazy-module gate. */
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

vi.mock('../SiteShell.js', async () => {
  h.entered += 1;
  await h.gate;
  throw new Error('Fixture gate unexpectedly fulfilled');
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

it('replaces a rejected cold shell with one focused trusted main and a fresh attached live announcement', async () => {
  brand.appGate.mode = 'sign-in';
  h.routes.push({
    path: '/__fixture-optional/:slug', tier: 'site', auth: 'optional', archetype: 'detail',
    element: <div data-testid="unreached-route">Unreached route body</div>,
  });
  render(<MemoryRouter initialEntries={['/__fixture-optional/alpha']}><App /></MemoryRouter>);
  await waitFor(() => expect(h.entered).toBe(1));
  const loadingMain = screen.getByRole('main');
  expect(loadingMain.id).toBe('site-main');
  expect(within(loadingMain).getByRole('status', { name: i18n.t('common:loading') })
    .getAttribute('aria-busy')).toBe('true');
  expect(screen.getAllByRole('main')).toHaveLength(1);
  expect(document.querySelectorAll('[data-owp-live="polite"]')).toHaveLength(0);
  expect(h.reload).not.toHaveBeenCalled();

  const changedInsideAttachedRegion: string[] = [];
  const observer = new MutationObserver((records) => {
    const region = document.querySelector('[data-owp-live="polite"]');
    if (!region?.isConnected) return;
    if (records.some((record) => record.target === region || region.contains(record.target))) {
      changedInsideAttachedRegion.push(region.textContent ?? '');
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  try {
    const sentinel = 'PRIVATE_SITE_SHELL_IMPORT_SENTINEL';
    await act(async () => {
      h.reject(new Error(sentinel));
      await h.gate.catch(() => {});
    });
    const title = i18n.t('ui:errorTitle');
    await waitFor(() => expect(within(screen.getByRole('main')).getByText(title)).toBeTruthy());
    const failureMain = screen.getByRole('main');
    expect(failureMain.id).toBe('site-main');
    expect(failureMain.tabIndex).toBe(-1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(within(failureMain).getByText(title)).toBeTruthy();
    expect(failureMain.textContent).toContain(i18n.t('ui:errorBodyGeneric'));
    expect(failureMain.textContent).toContain(i18n.t('ui:errorBodyRecover'));
    expect(screen.queryByTestId('unreached-route')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(failureMain));
    expect(document.querySelectorAll('[data-owp-live="polite"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-owp-live="assertive"]')).toHaveLength(1);
    const polite = document.querySelector('[data-owp-live="polite"]');
    if (!polite) throw new Error('The real failure host did not mount');
    await waitFor(() => {
      expect(polite.textContent).toContain(title);
      expect(changedInsideAttachedRegion).toContain(polite.textContent);
    });
    // Require a write inside the attached host, not insertion of retained text.
    expect(changedInsideAttachedRegion.some((text) => text.includes(title))).toBe(true);
    expect(document.body.textContent).not.toContain(sentinel);
    expect(document.querySelector('[data-owp-live="assertive"]')?.textContent).not.toContain(sentinel);
    fireEvent.click(within(failureMain).getByRole('button', { name: i18n.t('ui:errorReload') }));
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.entered).toBe(1);
    expect(h.unexpected).toEqual([]);
  } finally {
    observer.disconnect();
  }
});
