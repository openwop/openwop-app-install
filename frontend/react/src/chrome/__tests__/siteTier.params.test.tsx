/**
 * Measured on production 2026-09-15 (kicktodo-2, `00027-drb`): every `tier:'site'`
 * route with a `:param` rendered with an EMPTY `useParams()`, because App.tsx
 * rendered `siteRoute.element` as a bare child of the shell rather than through
 * a <Route> match context. `/discover/:challengeId` read `challengeId=''` for
 * every visitor and showed "Challenge not found".
 *
 * Two assertions, at the two levels where this can regress:
 *  1. the mechanism — a site-tier element rendered through
 *     `<Routes><Route path={pattern} element={…} /></Routes>` receives its params
 *     (and the bare form does not), so the fix is the right shape;
 *  2. the source ratchet — App.tsx's site branch never renders `{siteRoute.element}`
 *     bare again. A source scan, because nothing in this repo renders <App /> in
 *     a test and the regression is silent at request time.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function Probe(): JSX.Element {
  const { challengeId = '' } = useParams();
  return <output data-testid="param">{challengeId || '(empty)'}</output>;
}

afterEach(cleanup);

describe('site-tier routes receive their params', () => {
  it('through a <Route> whose pattern is the manifest path, useParams resolves; rendered bare, it is empty', () => {
    const pattern = '/discover/:challengeId';
    const entry = `/discover/${encodeURIComponent('chal:demo-kicktodo-deep-work')}`;
    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes><Route path={pattern} element={<Probe />} /></Routes>
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
