/**
 * ADR 0820 §7 — the public /pricing store CTAs for each kind of visitor.
 *
 * The store is an authed admin page; an anonymous visitor sent there sees
 * "Bundles could not be loaded". So:
 *  - ANONYMOUS: "Choose Pro" / "Add to a workspace" open the EXISTING header
 *    sign-in dialog (the real `SignInButton` is mounted here, so this pins the
 *    `.signin-trigger` contract the pricing page relies on) and remember the
 *    store path, which is followed once the visitor is signed in;
 *  - SIGNED IN: plain links straight to the store, as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const h = vi.hoisted(() => ({
  user: null as null | { displayName: string; email: string; uid: string; photoURL: null },
}));

vi.mock('../../../auth/useAuth.js', () => ({
  useAuth: () => ({ user: h.user, loading: false, isConfigured: true, signIn: { google: vi.fn(), github: vi.fn() }, signOut: vi.fn(async () => undefined) }),
}));
vi.mock('../../../auth/firebase.js', async (orig) => {
  const actual = await orig<typeof import('../../../auth/firebase.js')>();
  return {
    ...actual,
    getRedirectState: () => Promise.resolve({ kind: 'none' }),
    signInWithGoogle: vi.fn(), signInWithGithub: vi.fn(), signInWithMicrosoft: vi.fn(),
    microsoftSignInEnabled: () => false,
  };
});
vi.mock('../../../auth/backendSession.js', () => ({
  useBackendSession: () => ({ user: null }),
  refreshBackendSession: vi.fn(async () => undefined),
  setBackendSessionUser: vi.fn(),
}));
vi.mock('../../../client/useDemoMode.js', () => ({ useDemoMode: () => false }));
vi.mock('../../../auth/finalizeSession.js', () => ({ finalizeFirebaseSession: vi.fn(async () => ({ ok: false })) }));
vi.mock('../../users/usersClient.js', () => ({ logout: vi.fn(async () => undefined) }));

import { SignInButton } from '../../../auth/SignInButton.js';
import { PricingSection, takeReturn } from '../PricingSection.js';

const RETURN_KEY = 'openwop.pricing.returnTo';
const PRICING = {
  tiers: [
    { tier: 'free', name: 'Free', features: ['docs'], display: { price: '$0' } },
    { tier: 'pro', name: 'Pro', features: ['docs', 'advisory-board'], display: { price: '$39', cadence: '/mo', highlighted: true } },
  ],
  featureLabels: { docs: 'Docs', 'advisory-board': 'Advisory board' },
  creditPacks: [],
};
const BUNDLES = [{ bundleId: 'agents', label: 'Agents', features: ['advisory-board'], priceDisplay: { price: '$29', cadence: '/mo' } }];

function Where(): JSX.Element { const l = useLocation(); return <p data-testid="where">{l.pathname + l.search}</p>; }
function mount(): void {
  render(
    <MemoryRouter initialEntries={['/pricing']}>
      <SignInButton />
      <Routes>
        <Route path="/pricing" element={<PricingSection tierFilter={[]} />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  h.user = null;
  window.sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/public/pricing')) return new Response(JSON.stringify(PRICING), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('/public/bundle-pricing')) return new Response(JSON.stringify({ bundles: BUNDLES }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe('public pricing store CTAs — anonymous visitor', () => {
  it('“Choose Pro” opens the header sign-in dialog and remembers the store', async () => {
    mount();
    const choose = await screen.findByRole('button', { name: 'Choose Pro' });
    expect(screen.queryByRole('link', { name: 'Choose Pro' })).toBeNull(); // never a link into a page they cannot use
    fireEvent.click(choose);
    expect(await screen.findByRole('dialog')).toBeTruthy(); // the REAL SignInButton dialog
    expect(JSON.parse(window.sessionStorage.getItem(RETURN_KEY)!).url).toBe('/marketplace/bundles');
  });

  it('“Add to a workspace” remembers the bundle deep link the store understands', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Add the Agents bundle to a workspace' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(JSON.parse(window.sessionStorage.getItem(RETURN_KEY)!).url).toBe('/marketplace/bundles?bundle=agents');
  });

  it('“Start free” stays a plain link (no sign-in needed to try the app)', async () => {
    mount();
    expect((await screen.findByRole('link', { name: 'Start free' })).getAttribute('href')).toBe('/chat');
  });
});

describe('public pricing store CTAs — signed-in visitor', () => {
  it('links straight to the store and the bundle deep link', async () => {
    h.user = { displayName: 'Ada', email: 'ada@example.test', uid: 'u1', photoURL: null };
    mount();
    expect((await screen.findByRole('link', { name: 'Choose Pro' })).getAttribute('href')).toBe('/marketplace/bundles');
    expect(screen.getByRole('link', { name: 'Add the Agents bundle to a workspace' }).getAttribute('href')).toBe('/marketplace/bundles?bundle=agents');
    expect(screen.queryByRole('button', { name: 'Choose Pro' })).toBeNull();
  });

  it('back from sign-in, follows the remembered store path once, then forgets it', async () => {
    window.sessionStorage.setItem(RETURN_KEY, JSON.stringify({ url: '/marketplace/bundles?bundle=agents', at: Date.now() }));
    h.user = { displayName: 'Ada', email: 'ada@example.test', uid: 'u1', photoURL: null };
    mount();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/marketplace/bundles?bundle=agents'));
    expect(window.sessionStorage.getItem(RETURN_KEY)).toBeNull();
  });

  it('ignores an expired or non-store return path', () => {
    window.sessionStorage.setItem(RETURN_KEY, JSON.stringify({ url: '/marketplace/bundles', at: Date.now() - 31 * 60 * 1000 }));
    expect(takeReturn()).toBeNull();
    window.sessionStorage.setItem(RETURN_KEY, JSON.stringify({ url: 'https://evil.example/', at: Date.now() }));
    expect(takeReturn()).toBeNull();
    window.sessionStorage.setItem(RETURN_KEY, JSON.stringify({ url: '/marketplace/bundles', at: Date.now() }));
    expect(takeReturn()).toBe('/marketplace/bundles'); // positive control
  });
});
