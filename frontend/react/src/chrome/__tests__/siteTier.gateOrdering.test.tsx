/**
 * ADR 0641 decision 3, pinned at the ONE place it can regress silently: the
 * ordering of App.tsx's site branch.
 *
 * The params fix (`siteTier.params.test.tsx`) gives a site-tier element a
 * <Route> match context. A fix can make params arrive AND move that wrapper
 * above the tier decision, and nothing about the page would look wrong — the
 * page renders. What would have changed is that an `auth:'required'`
 * participant surface no longer sits inside <AppGate>, or falls through into
 * <PublicShell>, which carries no nav and sits strictly above the gate. That is
 * not a styling bug; it is an ungated surface.
 *
 * Two assertions, at two levels:
 *  1. the composition — the real `siteWrapsAppGate` predicate, the REAL <AppGate>
 *     (sign-in mode, session mocked), and a <Routes><Route> wrapper composed in the
 *     branch's shape: `required` renders INSIDE the gate and still receives its
 *     params; `optional` renders with no gate at all. So gate and route context
 *     compose, and posture decides. (App's site branch is not an exported
 *     component and nothing renders <App/> in a test, so the branch itself is
 *     held by the source ratchet below — the honest ceiling for "behavioural".)
 *  2. the source ratchet — in App.tsx the <Route path={siteRoute.path}> wrapper
 *     sits INSIDE `if (siteRoute !== undefined)`, BEFORE the posture ternary that
 *     wraps <AppGate>, and the whole branch returns BEFORE `if (showPublic)`.
 *     Sabotage: hoist the <Routes> wrapper above the tier decision — this test
 *     reds while the params test stays green, which is the point of having both.
 *     Sabotage: INVERT the gate (`!siteWrapsAppGate(...)`) — every `required`
 *     route renders ungated. The old ratchet stayed green (w35 `go-invert-gate`);
 *     the exact-shape regex below reds it.
 *  3. GT-SITE-CHROME-1 — the site branch mounts none of the console chrome
 *     (Sidebar, VendorSetupPrompt, AutoSeedExampleData, InMemoryHostBanner):
 *     "a participant at /today must not receive a vendor-setup prompt".
 *
 * DEDUPE CANDIDATE (needs a human ask — protected authz): the composition block's
 * posture outcomes overlap siteTier.routing.test.ts (`required` wraps / `optional`
 * MUST NOT / omission fails CLOSED).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { siteWrapsAppGate } from '../tierShell.js';
import type { FeatureAuthPosture } from '../featureTypes.js';
import type { UseAuth } from '../../auth/useAuth.js';

const brandMock = vi.hoisted(() => ({
  productName: 'TestProduct',
  instanceName: 'TestInstance',
  appGate: { mode: 'sign-in' as 'password' | 'sign-in' | 'none', password: '' },
}));
const authMock = vi.hoisted(() => ({
  state: { user: null, loading: false, isConfigured: true } as Pick<UseAuth, 'user' | 'loading' | 'isConfigured'>,
}));
vi.mock('../../brand/brand.js', () => ({ brand: brandMock }));
vi.mock('../../auth/useAuth.js', () => ({ useAuth: () => authMock.state }));
vi.mock('../../auth/SignInButton.js', () => ({ SignInButton: () => null }));

import { AppGate } from '../AppGate.js';

const SIGNED_IN = { uid: 'u1', email: 'u1@example.test', displayName: 'U One', photoURL: null, providerIds: [] as string[] };
const WALL = 'Sign in to open this workspace.';

function Probe(): JSX.Element {
  const { challengeId = '' } = useParams();
  return <output data-testid="param">{challengeId || '(empty)'}</output>;
}

/** The branch's shape: the real posture predicate decides whether the REAL
 *  <AppGate> (sign-in mode) wraps the routed body. */
function SiteBranch({ auth, signedIn }: { auth: FeatureAuthPosture | undefined; signedIn: boolean }): JSX.Element {
  authMock.state = { user: signedIn ? SIGNED_IN : null, loading: false, isConfigured: true };
  const body = (
    <section data-testid="site-shell">
      <Routes><Route path="/leaderboard/:challengeId" element={<Probe />} /></Routes>
    </section>
  );
  return siteWrapsAppGate(auth) ? <AppGate>{body}</AppGate> : body;
}

beforeEach(() => {
  brandMock.appGate.mode = 'sign-in';
  authMock.state = { user: null, loading: false, isConfigured: true };
});
afterEach(cleanup);

describe('ADR 0641 decision 3 — the route context sits INSIDE the gate, and posture decides the gate', () => {
  const entry = '/leaderboard/chal%3Ademo';

  it('`required`, signed out: the wall, and NO site element renders behind it', () => {
    render(<MemoryRouter initialEntries={[entry]}><SiteBranch auth="required" signedIn={false} /></MemoryRouter>);
    expect(screen.getByText(WALL)).toBeTruthy();
    expect(screen.queryByTestId('site-shell')).toBeNull();
    expect(screen.queryByTestId('param')).toBeNull();
  });

  it('`required`, signed in: the element renders through the gate AND still receives its param', () => {
    render(<MemoryRouter initialEntries={[entry]}><SiteBranch auth="required" signedIn={true} /></MemoryRouter>);
    expect(screen.queryByText(WALL)).toBeNull();
    expect(screen.getByTestId('site-shell')).toBeTruthy();
    expect(screen.getByTestId('param').textContent).toBe('chal:demo');
  });

  it('`optional`, signed out: no gate, the element renders with its param', () => {
    render(<MemoryRouter initialEntries={[entry]}><SiteBranch auth="optional" signedIn={false} /></MemoryRouter>);
    expect(screen.queryByText(WALL)).toBeNull();
    expect(screen.getByTestId('param').textContent).toBe('chal:demo');
  });

  it('omitted posture fails closed: the wall', () => {
    render(<MemoryRouter initialEntries={[entry]}><SiteBranch auth={undefined} signedIn={false} /></MemoryRouter>);
    expect(screen.getByText(WALL)).toBeTruthy();
    expect(screen.queryByTestId('param')).toBeNull();
  });
});

describe('source ratchet — App.tsx keeps the <Routes> wrapper inside the tier decision and below the gate', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8');
  const at = (needle: string | RegExp): number => {
    const i = typeof needle === 'string' ? src.indexOf(needle) : src.search(needle);
    expect(i, `App.tsx must contain ${String(needle)}`).toBeGreaterThan(-1);
    return i;
  };

  it('the site-tier <Route> is rendered only inside `if (siteRoute !== undefined)`', () => {
    const branch = at('if (siteRoute !== undefined) {');
    const route = at(/<Route\s+path=\{siteRoute\.path\}/);
    const posture = at('siteWrapsAppGate(siteRoute.auth)');
    expect(route).toBeGreaterThan(branch);
    expect(route).toBeLessThan(posture);
    // Exactly one such <Route>: a second copy hoisted elsewhere would be the sabotage.
    expect(src.match(/<Route\s+path=\{siteRoute\.path\}/g)).toHaveLength(1);
  });

  it('the `required` arm wraps the routed body in <AppGate>, and the branch returns before the public branch', () => {
    const posture = at('siteWrapsAppGate(siteRoute.auth)');
    const publicBranch = at('if (showPublic) {');
    expect(posture).toBeLessThan(publicBranch);
    // Exact shape: the predicate, un-negated, selects the <AppGate> arm. A bare
    // substring search also matched `!siteWrapsAppGate(...)` (w35 go-invert-gate).
    expect(src).toMatch(/return\s+siteWrapsAppGate\(siteRoute\.auth\)\s*\?\s*\(\s*<AppGate>/);
    // Between the posture ternary and the public branch: the truthy arm opens
    // <AppGate> and renders {body}; the falsy arm never mentions AppGate.
    const arms = src.slice(posture, publicBranch);
    const gateOpen = arms.indexOf('<AppGate>');
    const gateClose = arms.indexOf('</AppGate>');
    expect(gateOpen).toBeGreaterThan(-1);
    expect(arms.slice(gateOpen, gateClose)).toContain('{body}');
    expect(arms.slice(gateClose)).not.toContain('<AppGate>');
    expect(arms.slice(gateClose)).toContain('{body}');
  });

  it('GT-SITE-CHROME-1: the site branch mounts no console chrome', () => {
    const branch = at('if (siteRoute !== undefined) {');
    const publicBranch = at('if (showPublic) {');
    const site = src.slice(branch, publicBranch);
    for (const chrome of ['<Sidebar', '<VendorSetupPrompt', '<AutoSeedExampleData', '<InMemoryHostBanner']) {
      // Positive control: the console shell does mount it, so the name is spelled right.
      expect(src.slice(publicBranch), `${chrome} must exist in the console shell`).toContain(chrome);
      expect(site, `${chrome} must not reach a site route`).not.toContain(chrome);
    }
  });

  it('nothing site-tier renders inside <PublicShell>', () => {
    const publicBranch = at('if (showPublic) {');
    const publicShell = src.indexOf('<PublicShell>', publicBranch);
    const publicShellEnd = src.indexOf('</PublicShell>', publicShell);
    expect(src.slice(publicShell, publicShellEnd)).not.toContain('siteRoute');
  });
});
