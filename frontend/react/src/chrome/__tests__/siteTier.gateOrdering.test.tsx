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
 *  1. the composition — the real `siteWrapsAppGate` predicate, a gate, and a
 *     <Routes><Route> wrapper composed in the branch's shape: `required` renders
 *     INSIDE the gate and still receives its params; `optional` renders with no
 *     gate at all. So gate and route context compose, and posture decides.
 *  2. the source ratchet — in App.tsx the <Route path={siteRoute.path}> wrapper
 *     sits INSIDE `if (siteRoute !== undefined)`, BEFORE the posture ternary that
 *     wraps <AppGate>, and the whole branch returns BEFORE `if (showPublic)`.
 *     Sabotage: hoist the <Routes> wrapper above the tier decision — this test
 *     reds while the params test stays green, which is the point of having both.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { siteWrapsAppGate } from '../tierShell.js';
import type { FeatureAuthPosture } from '../featureTypes.js';

function Probe(): JSX.Element {
  const { challengeId = '' } = useParams();
  return <output data-testid="param">{challengeId || '(empty)'}</output>;
}

/** Stand-in for <AppGate>: a signed-out visitor sees the wall, never the child. */
function Gate({ signedIn, children }: { signedIn: boolean; children: React.ReactNode }): JSX.Element {
  return signedIn ? <div data-testid="gate">{children}</div> : <div data-testid="wall">Sign in</div>;
}

/** The branch's shape, with the real posture predicate deciding the gate. */
function SiteBranch({ auth, signedIn }: { auth: FeatureAuthPosture | undefined; signedIn: boolean }): JSX.Element {
  const body = (
    <section data-testid="site-shell">
      <Routes><Route path="/leaderboard/:challengeId" element={<Probe />} /></Routes>
    </section>
  );
  return siteWrapsAppGate(auth) ? <Gate signedIn={signedIn}>{body}</Gate> : body;
}

afterEach(cleanup);

describe('ADR 0641 decision 3 — the route context sits INSIDE the gate, and posture decides the gate', () => {
  const entry = '/leaderboard/chal%3Ademo';

  it('`required`, signed out: the wall, and NO site element renders behind it', () => {
    render(<MemoryRouter initialEntries={[entry]}><SiteBranch auth="required" signedIn={false} /></MemoryRouter>);
    expect(screen.getByTestId('wall')).toBeTruthy();
    expect(screen.queryByTestId('site-shell')).toBeNull();
    expect(screen.queryByTestId('param')).toBeNull();
  });

  it('`required`, signed in: the element renders inside the gate AND still receives its param', () => {
    render(<MemoryRouter initialEntries={[entry]}><SiteBranch auth="required" signedIn={true} /></MemoryRouter>);
    const gate = screen.getByTestId('gate');
    expect(gate.querySelector('[data-testid="site-shell"]')).not.toBeNull();
    expect(screen.getByTestId('param').textContent).toBe('chal:demo');
  });

  it('`optional`, signed out: no gate, the element renders with its param', () => {
    render(<MemoryRouter initialEntries={[entry]}><SiteBranch auth="optional" signedIn={false} /></MemoryRouter>);
    expect(screen.queryByTestId('wall')).toBeNull();
    expect(screen.queryByTestId('gate')).toBeNull();
    expect(screen.getByTestId('param').textContent).toBe('chal:demo');
  });

  it('omitted posture fails closed: the wall', () => {
    render(<MemoryRouter initialEntries={[entry]}><SiteBranch auth={undefined} signedIn={false} /></MemoryRouter>);
    expect(screen.getByTestId('wall')).toBeTruthy();
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

  it('nothing site-tier renders inside <PublicShell>', () => {
    const publicBranch = at('if (showPublic) {');
    const publicShell = src.indexOf('<PublicShell>', publicBranch);
    const publicShellEnd = src.indexOf('</PublicShell>', publicShell);
    expect(src.slice(publicShell, publicShellEnd)).not.toContain('siteRoute');
  });
});
