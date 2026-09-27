/**
 * `/my-work` is a compatibility shim, and nothing protected it.
 *
 * ADR 0049 folded the standalone page into the personal board's "Assigned to
 * me" rail, keeping the path as a redirect so assignment notifications ALREADY
 * SENT — carrying `/my-work?card=<id>` — still land somewhere useful. Those
 * links are in people's inboxes; they cannot be reissued.
 *
 * So the failure is silent and delayed: drop the `search` passthrough or change
 * the target, and every historical notification quietly stops opening its card.
 * Nothing else in the app would go red.
 *
 * These drive the element registered in `FEATURES`, not a locally imported
 * component, so they fail if the ROUTE is rewired — the actual risk — rather
 * than only if the helper's body changes.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

import { FEATURES } from '../features.js';

const entry = FEATURES.find((f) => f.path === '/my-work');

/** Renders where we landed, so an assertion can read path + query. */
function Landing(): JSX.Element {
  const { pathname, search } = useLocation();
  return <div data-testid="landing">{`${pathname}${search}`}</div>;
}

function go(initial: string): HTMLElement {
  const { getByTestId } = render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/my-work" element={entry?.element} />
        <Route path="/boards" element={<Landing />} />
      </Routes>
    </MemoryRouter>,
  );
  return getByTestId('landing');
}

describe('/my-work redirect (ADR 0049 compatibility shim)', () => {
  it('is still registered as a route', () => {
    expect(entry).toBeDefined();
    expect(entry?.element).toBeDefined();
  });

  it('sends a bare /my-work to the boards page', () => {
    expect(go('/my-work').textContent).toBe('/boards');
  });

  // THE POINT. `?card=<id>` is what an already-sent assignment notification
  // carries, and the board rail honours it. Dropping it strands every one of
  // those links on a generic board — no error, nothing to notice.
  it('preserves the query string notification deep-links carry', () => {
    expect(go('/my-work?card=abc123').textContent).toBe('/boards?card=abc123');
  });

  it('preserves every param, not just the first', () => {
    expect(go('/my-work?card=abc123&focus=note').textContent).toBe('/boards?card=abc123&focus=note');
  });
});
