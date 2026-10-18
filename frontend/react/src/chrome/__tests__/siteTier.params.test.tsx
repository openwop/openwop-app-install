/**
 * Measured on production 2026-09-15 (kicktodo-2, `00027-drb`): every `tier:'site'`
 * route with a `:param` rendered with an EMPTY `useParams()`, because App.tsx
 * rendered `siteRoute.element` as a bare child of the shell rather than through
 * a <Route> match context. `/discover/:challengeId` read `challengeId=''` for
 * every visitor and showed "Challenge not found".
 *
 * Two assertions, at the two levels where this can regress:
 *  1. the mechanism — the REAL manifest route for `/discover/:challengeId`
 *     (`features/kicktodo/routes.tsx`, selected by the same `matchPath(..., end:true)`
 *     App.tsx uses) rendered through `<Routes><Route path={siteRoute.path} …/></Routes>`
 *     hands `ChallengeDetailPage` the `challengeId` it reads (and the bare form does
 *     not), so the fix is the right shape for the route that broke. The bare half is
 *     react-router behaviour, kept as the illustration of the shipped shape;
 *  2. the source ratchet — App.tsx's site branch never renders `{siteRoute.element}`
 *     bare again. A source scan, because nothing in this repo renders <App /> in
 *     a test and the regression is silent at request time.
 *
 * Sabotage that turns it red: render `{siteRoute.element}` bare in App.tsx (case 2);
 * rename the manifest param (`/discover/:slug`) away from the `challengeId` the page
 * reads (case 1).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, matchPath, useParams } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kicktodoFeature } from '../../features/kicktodo/routes.js';

function Probe(): JSX.Element {
  const { challengeId = '' } = useParams();
  return <output data-testid="param">{challengeId || '(empty)'}</output>;
}

afterEach(cleanup);

describe('site-tier routes receive their params', () => {
  it('through a <Route> whose pattern is the manifest path, useParams resolves; rendered bare, it is empty', () => {
    const entry = `/discover/${encodeURIComponent('chal:demo-kicktodo-deep-work')}`;
    // Select the site route exactly as App.tsx does (tier + matchPath end:true).
    const siteRoute = kicktodoFeature.routes.find((f) => f.tier === 'site' && matchPath({ path: f.path, end: true }, '/discover/chal%3Ademo-kicktodo-deep-work') !== null);
    expect(siteRoute, 'the manifest must route the challenge detail URL').toBeDefined();
    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes><Route path={siteRoute!.path} element={<Probe />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('param').textContent).toBe('chal:demo-kicktodo-deep-work');
    cleanup();
    // The shape that shipped: the element as a bare child, outside any route match.
    render(<MemoryRouter initialEntries={[entry]}><Probe /></MemoryRouter>);
    expect(screen.getByTestId('param').textContent).toBe('(empty)');
  });

  it('source ratchet: App.tsx renders the matched site element through <Route path={siteRoute.path}>, never bare', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8');
    expect(src).toMatch(/<Route\s+path=\{siteRoute\.path\}\s+element=\{siteRoute\.element\}\s*\/>/);
    // No bare `{siteRoute.element}` child anywhere in the site branch.
    expect(src).not.toMatch(/^\s*\{siteRoute\.element\}\s*$/m);
  });
});
