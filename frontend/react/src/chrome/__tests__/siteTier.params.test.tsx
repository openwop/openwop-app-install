/**
 * Measured on production 2026-09-15 (kicktodo-2, `00027-drb`): every `tier:'site'`
 * route with a `:param` rendered with an EMPTY `useParams()`, because App.tsx
 * rendered `siteRoute.element` as a bare child of the shell rather than through
 * a <Route> match context. `/discover/:challengeId` read `challengeId=''` for
 * every visitor and showed "Challenge not found".
 *
 * Two assertions, at the two levels where this can regress:
 *  1. the mechanism — a site route rendered through `<Routes><Route path={…} …/></Routes>`
 *     resolves its param and the bare form does not. This is react-router behaviour
 *     that App.tsx's fix relies on, pinned so a router upgrade that changed it reds
 *     here; it imports no product code. (The real `/discover/:challengeId` manifest
 *     case moved with KickTodo by ADR 1031 P2 and left the repo with it in P3,
 *     `96cf0ce05`: no in-tree site route has a `:param` today.)
 *  2. the source ratchet — App.tsx's site branch renders the matched element
 *     exactly once, through `<Routes><Route path={siteRoute.path} …/></Routes>`,
 *     never bare. A source scan, because nothing in this repo renders <App /> in a
 *     test and the regression is silent at request time.
 *
 * Sabotage that turns it red (case 2): render `{siteRoute.element}` bare in
 * App.tsx, on its own line or beside other markup; give the Route any pattern but
 * `siteRoute.path`; or drop the `<Routes>` around it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, matchPath, useParams } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function Probe(): JSX.Element {
  const { challengeId = '' } = useParams();
  return <output data-testid="param">{challengeId || '(empty)'}</output>;
}

afterEach(cleanup);

describe('site-tier routes receive their params', () => {
  it('through a <Route> whose pattern is the route path, useParams resolves; rendered bare, it is empty', () => {
    // A synthetic site route (router behaviour, no product code): the route that
    // broke, KickTodo's `/discover/:challengeId`, left the repo with KickTodo
    // (ADR 1031 P3).
    const path = '/item/:challengeId';
    const entry = `/item/${encodeURIComponent('chal:demo-deep-work')}`;
    expect(matchPath({ path, end: true }, '/item/chal%3Ademo-deep-work')).not.toBeNull();
    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes><Route path={path} element={<Probe />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('param').textContent).toBe('chal:demo-deep-work');
    cleanup();
    // The shape that shipped: the element as a bare child, outside any route match.
    render(<MemoryRouter initialEntries={[entry]}><Probe /></MemoryRouter>);
    expect(screen.getByTestId('param').textContent).toBe('(empty)');
  });

  it('source ratchet: App.tsx renders the matched site element through <Route path={siteRoute.path}>, never bare', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8');
    expect(src).toMatch(/<Routes>\s*<Route\s+path=\{siteRoute\.path\}\s+element=\{siteRoute\.element\}\s*\/>\s*<\/Routes>/);
    // No bare `{siteRoute.element}` child anywhere in the site branch: the Route's
    // `element={siteRoute.element}` is the ONLY place the expression appears, so a
    // bare child beside other markup on one line is caught too.
    expect(src.split('{siteRoute.element}').length - 1).toBe(1);
    expect(src).not.toMatch(/^\s*\{siteRoute\.element\}\s*$/m);
  });
});
