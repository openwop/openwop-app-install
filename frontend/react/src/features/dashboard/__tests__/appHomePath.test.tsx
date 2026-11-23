/**
 * `VITE_BRAND_APP_HOME_PATH` — where a signed-in visitor lands (DeckTalk upstream
 * request, decktalk/docs/upstream/app-home-path-brand-key.md).
 *
 * Claims:
 *  1. The value is accepted only as a plain in-app path. `//host`, a backslash
 *     anywhere, whitespace or control characters, a scheme, a query or fragment
 *     all fall back to `/dashboard`, so the key cannot become an open redirect.
 *  2. Unset, nothing changes: "Open app" and the app shell's `/` go straight to
 *     `/dashboard` (homeContract.test.tsx is the unchanged route test).
 *  3. Set to a registered, enabled route (`/decktalk` here), "Open app" goes
 *     through the `/open-app` entry and both it and `/` land there. A feature
 *     route at `/app` (DeckTalk's product path) is an ordinary target.
 *  5. A key naming the hop itself (`/open-app`) falls back: it would loop.
 *  4. Set to a path the manifest does not register, or to a feature that is off,
 *     locked, or whose toggle read failed, both land on `/dashboard`, never on an
 *     empty or access-denied page. Legacy chat deep links still go to `/chat`.
 *
 * The manifest lookup and the toggle answers are mocked so the cases can name a
 * DeckTalk-shaped route the starter does not ship.
 *
 * Sabotage-witnessed: dropping the backslash, `//`, whitespace or query check in
 * `appHomePath`, the `!route` / tier / toggle-off / locked / resolutionFailed
 * checks in `resolveAppHome`, the `loading` wait in `AppHomeRedirect`, or the
 * `/open-app` hop in `appHomeHref`, or the hop refusal in `resolveAppHome` /
 * `appHomeHref`, each turns a named case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { UseAuth } from '../../../auth/useAuth.js';
import type { FeatureRoute } from '../../../chrome/featureTypes.js';
import { appHomePath, resolveBrandFromEnv } from '../../../brand/defaults.js';
import { appHomeHref, resolveAppHome, type AppHomeAccess } from '../../../chrome/appHome.js';

const auth = vi.hoisted(() => ({ useAuth: vi.fn<() => UseAuth>() }));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: auth.useAuth }));

const manifest = vi.hoisted(() => ({ routes: new Map<string, unknown>() }));
vi.mock('../../../chrome/features.js', () => ({
  featureFor: (pathname: string) => manifest.routes.get(pathname) ?? null,
}));

const access = vi.hoisted(() => ({
  state: { byId: {} as Record<string, { enabled: boolean }>, loading: false, resolutionFailed: false },
  locked: new Set<string>(),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useAllFeatureAccess: () => access.state,
  useFeatureLocked: () => (id?: string) => !!id && access.locked.has(id),
}));

import { RootRedirect, AppHomeEntry } from '../routes.js';
import { OpenAppLink } from '../../site/OpenAppLink.js';

const CORE_PAGE: FeatureRoute = { path: '/inbox', element: <div />, tier: 'workspace', archetype: 'standard-index' };
const DECKTALK: FeatureRoute = { ...CORE_PAGE, path: '/decktalk', ownerFeatureId: 'decktalk' };
const ADMIN_PAGE: FeatureRoute = { path: '/admin/things', element: <div />, tier: 'admin', archetype: 'admin' };

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

const renderAt = (url: string, home: string) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path="/" element={<RootRedirect home={home} />} />
      <Route path="/open-app" element={<AppHomeEntry home={home} />} />
      <Route path="/app" element={<LocationProbe />} />
      <Route path="/chat" element={<LocationProbe />} />
      <Route path="/dashboard" element={<LocationProbe />} />
      <Route path="/decktalk" element={<LocationProbe />} />
      <Route path="/admin/things" element={<LocationProbe />} />
    </Routes>
  </MemoryRouter>,
);
const landsOn = async (path: string) => waitFor(() => expect(screen.getByTestId('loc').textContent).toBe(path));

beforeEach(() => {
  manifest.routes = new Map<string, unknown>([['/decktalk', DECKTALK], ['/admin/things', ADMIN_PAGE]]);
  access.state = { byId: { decktalk: { enabled: true } }, loading: false, resolutionFailed: false };
  access.locked = new Set();
  auth.useAuth.mockReturnValue({ user: { uid: 'u1' }, loading: false } as unknown as UseAuth);
});
afterEach(cleanup);

describe('appHomePath: only a plain in-app path is accepted', () => {
  it.each([
    [undefined, '/dashboard'],
    ['', '/dashboard'],
    ['   ', '/dashboard'],
    ['/decktalk', '/decktalk'],
    [' /decktalk ', '/decktalk'],
    ['/decktalk/studio', '/decktalk/studio'],
  ])('%j → %s', (raw, want) => expect(appHomePath(raw)).toBe(want));

  it.each([
    '//x.com',
    '/\\x.com',
    '/decktalk\\..\\x',
    'https://x.com',
    'javascript:alert(1)',
    'decktalk',
    '/\t/x.com',
    '/\n/x.com',
    '/deck talk',
    '/decktalk?next=//x.com',
    '/decktalk#x',
  ])('%j falls back to /dashboard', (raw) => expect(appHomePath(raw)).toBe('/dashboard'));

  it('the Vite resolver reads VITE_BRAND_APP_HOME_PATH through the same check', () => {
    expect(resolveBrandFromEnv({}).appHomePath).toBe('/dashboard');
    expect(resolveBrandFromEnv({ VITE_BRAND_APP_HOME_PATH: '/decktalk' }).appHomePath).toBe('/decktalk');
    expect(resolveBrandFromEnv({ VITE_BRAND_APP_HOME_PATH: '//x.com' }).appHomePath).toBe('/dashboard');
  });
});

describe('resolveAppHome: a configured path is used only when the visitor can use it', () => {
  const on: AppHomeAccess = { enabled: () => true, locked: () => false, resolutionFailed: false };
  it('registered workspace route, toggle on → the path', () => {
    expect(resolveAppHome('/decktalk', DECKTALK, on)).toBe('/decktalk');
  });
  it('a feature route at /app (DeckTalk) → /app', () => {
    expect(resolveAppHome('/app', { ...DECKTALK, path: '/app' } as FeatureRoute, on)).toBe('/app');
  });
  it('core route with no toggle → the path', () => {
    expect(resolveAppHome('/inbox', CORE_PAGE, { ...on, enabled: () => undefined })).toBe('/inbox');
  });
  it.each<[string, string, FeatureRoute | null, AppHomeAccess]>([
    ['not registered', '/nope', null, on],
    ['admin tier', '/admin/things', ADMIN_PAGE, on],
    ['the shell root (would loop)', '/', { ...DECKTALK, path: '/' } as FeatureRoute, on],
    ['the hop itself, registered (would loop)', '/open-app', { ...DECKTALK, path: '/open-app' } as FeatureRoute, on],
    ['the hop itself, unregistered (would loop)', '/open-app', null, on],
    ['feature off', '/decktalk', DECKTALK, { ...on, enabled: () => false }],
    ['feature locked', '/decktalk', DECKTALK, { ...on, locked: () => true }],
    ['toggle read failed', '/decktalk', DECKTALK, { ...on, resolutionFailed: true }],
  ])('%s → /dashboard', (_name, configured, route, acc) => {
    expect(resolveAppHome(configured, route, acc)).toBe('/dashboard');
  });
});

describe('Open app', () => {
  const href = (home?: string) => {
    render(<MemoryRouter>{home === undefined ? <OpenAppLink /> : <OpenAppLink home={home} />}</MemoryRouter>);
    return screen.getByTestId('open-app-link').getAttribute('href');
  };
  it('unset → /dashboard, directly (no hop), with zero requests', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(href()).toBe('/dashboard');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it('set → still zero requests from the public page (the check runs at /app)', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(href('/decktalk')).toBe('/open-app');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it('/decktalk → the checked /open-app entry', () => expect(href('/decktalk')).toBe('/open-app'));
  it('/app (DeckTalk) → the checked /open-app entry', () => expect(href('/app')).toBe('/open-app'));
  it('a key naming the hop → /dashboard directly, never a self-link', () => expect(href('/open-app')).toBe('/dashboard'));
  it('the canvas exit uses the same href', () => {
    expect(appHomeHref('/dashboard')).toBe('/dashboard');
    expect(appHomeHref('/decktalk')).toBe('/open-app');
  });
});

describe('/ and /open-app with VITE_BRAND_APP_HOME_PATH=/decktalk', () => {
  it.each(['/', '/open-app'])('%s lands on /decktalk', async (from) => {
    renderAt(from, '/decktalk');
    await landsOn('/decktalk');
  });

  it('waits for the toggle read instead of guessing', async () => {
    access.state = { ...access.state, loading: true };
    renderAt('/', '/decktalk');
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(screen.queryByTestId('loc')).toBeNull();
  });

  it('a legacy chat deep link still goes to /chat', async () => {
    renderAt('/?agent=iris', '/decktalk');
    await landsOn('/chat?agent=iris');
  });

  it.each<[string, () => void]>([
    ['the path is not registered', () => { manifest.routes.delete('/decktalk'); }],
    ['the feature is off', () => { access.state = { ...access.state, byId: { decktalk: { enabled: false } } }; }],
    ['the feature is locked', () => { access.locked.add('decktalk'); }],
    ['the toggle read failed', () => { access.state = { ...access.state, resolutionFailed: true }; }],
  ])('falls back to /dashboard when %s', async (_name, arrange) => {
    arrange();
    renderAt('/open-app', '/decktalk');
    await landsOn('/dashboard');
  });

  it.each(['/', '/open-app'])('a feature route at /app (DeckTalk) is a valid home: %s lands on /app, no loop', async (from) => {
    manifest.routes.set('/app', { ...DECKTALK, path: '/app' });
    renderAt(from, '/app');
    await landsOn('/app');
  });

  it.each(['/', '/open-app'])('a key naming the hop itself falls back: %s lands on /dashboard', async (from) => {
    manifest.routes.set('/open-app', { ...DECKTALK, path: '/open-app' });
    renderAt(from, '/open-app');
    await landsOn('/dashboard');
  });

  it('an admin-tier path falls back to /dashboard', async () => {
    renderAt('/', '/admin/things');
    await landsOn('/dashboard');
  });
});
