/**
 * Measured on production 2026-09-15 (kicktodo-2, `00027-drb`): every `tier:'site'`
 * route with a `:param` rendered with an EMPTY `useParams()`, because App.tsx
 * rendered `siteRoute.element` as a bare child of the shell rather than through
 * a <Route> match context. `/discover/:challengeId` read `challengeId=''` for
 * every visitor and showed "Challenge not found".
 *
 * Two assertions, at the two levels where this can regress:
 *  1. the mechanism — a site route rendered through `<Routes><Route path={…} …/></Routes>`
 *     resolves its param and the bare form does not (the real `/discover/:challengeId`
 *     manifest case moved with its feature by ADR 1031 P2:
 *     features/kicktodo/__tests__/siteTierParams.test.tsx);
 *  2. the source ratchet — App.tsx's site branch never renders `{siteRoute.element}`
 *     bare again. A source scan, because nothing in this repo renders <App /> in
 *     a test and the regression is silent at request time.
 *
 * Sabotage that turns it red: render `{siteRoute.element}` bare in App.tsx (case 2).
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
    // ADR 1031 P2 — a synthetic site route; the real manifest case for the route
    // that broke (KickTodo's `/discover/:challengeId`) lives with its feature,
    // features/kicktodo/__tests__/siteTierParams.test.tsx.
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
    expect(src).toMatch(/<Route\s+path=\{siteRoute\.path\}\s+element=\{siteRoute\.element\}\s*\/>/);
    // No bare `{siteRoute.element}` child anywhere in the site branch.
    expect(src).not.toMatch(/^\s*\{siteRoute\.element\}\s*$/m);
  });
});
