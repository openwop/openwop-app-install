/**
 * Strategy §8 — the entry-chunk Sidebar carries NO funnel code: the lazy beacon
 * reads its locked links from the DOM and counts clicks on them by delegation.
 * This pins that contract against the REAL Sidebar markup, so a class or href
 * change cannot silently blind the funnel. (Same harness as Sidebar.lock.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BoxesIcon } from '../../ui/icons/index.js';

let lockedId: string | null = 'crm';
// This test waits for effects, so the chrome that fetches on mount is stubbed.
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
import { view, notePaywall, __resetPaywallBeacon } from '../../featureToggles/paywallBeacon.js';

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 202 }));
const posts = (suffix: string) => fetchMock.mock.calls.filter(([url]) => url.endsWith(suffix));
const events = () => posts('/analytics/paywall')
  .flatMap(([, init]) => (JSON.parse(String(init?.body)) as { events: Array<{ metric: string; featureId: string; surface: string }> }).events);
const mount = () => render(<MemoryRouter initialEntries={['/crm']}><Sidebar netOpen={false} onToggleNet={() => {}} /></MemoryRouter>);
afterEach(() => { lockedId = 'crm'; __resetPaywallBeacon(); fetchMock.mockClear(); vi.unstubAllGlobals(); cleanup(); });

describe('Sidebar — paywall funnel contract (strategy §8)', () => {
  it('the beacon sees a rendered lock as a sidebar impression, and counts its click', async () => {
    vi.stubGlobal('fetch', fetchMock);
    mount();
    view('/crm', 'deep-link');
    await waitFor(() => expect(events()).toContainEqual({ metric: 'impression', featureId: 'crm', surface: 'sidebar' }));
    fireEvent.click(within(screen.getByLabelText('Primary')).getByRole('link', { name: /CRM/i }));
    await waitFor(() => expect(events()).toContainEqual({ metric: 'click', featureId: 'crm', surface: 'sidebar' }));
  });

  it('an unlocked item is neither an impression nor a click', async () => {
    vi.stubGlobal('fetch', fetchMock);
    lockedId = null;
    mount();
    view('/crm', 'deep-link');
    // Positive control: view() ran and the stubbed fetch is the one recording.
    expect(posts('/analytics/nav')).toHaveLength(1);
    fireEvent.click(within(screen.getByLabelText('Primary')).getByRole('link', { name: /CRM/i }));
    // Sentinel instead of a sleep: one shared queue, flushed in order, so once the
    // sentinel has been posted any click on the CRM link would have been too.
    notePaywall('click', 'sentinel', 'palette');
    await waitFor(() => expect(events()).toContainEqual({ metric: 'click', featureId: 'sentinel', surface: 'palette' }));
    expect(events().filter((e) => e.featureId === 'crm')).toEqual([]);
  });
});
