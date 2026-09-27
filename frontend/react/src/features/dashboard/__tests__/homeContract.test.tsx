/**
 * Root-route contracts (ADR 0487 — '/' is the public marketing home; the
 * Dashboard owns '/dashboard'):
 *  - the legacy chat deep links ('/?conversation=' / '?agent=' / '?new=')
 *    REDIRECT to /chat with the query intact (stored notification actionUrls
 *    must keep working — load-bearing);
 *  - a bare '/' reaching the app shell (a signed-in visitor) REDIRECTS to
 *    '/dashboard' (an anonymous visitor never reaches it — App.tsx shows the
 *    public home);
 *  - the todos tile classifies an auth-gated 401 as the quiet sign-in state,
 *    never the error state (the dashboard must not open broken for anons).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { RootRedirect } from '../routes.js';

const listAssignedToMe = vi.fn();
vi.mock('../../../kanban/kanbanClient.js', () => ({ listAssignedToMe: () => listAssignedToMe() }));

import TodosTile from '../tiles/TodosTile.js';

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

const renderAt = (url: string) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/chat" element={<LocationProbe />} />
      <Route path="/dashboard" element={<LocationProbe />} />
    </Routes>
  </MemoryRouter>,
);

describe('root route contract (ADR 0487)', () => {
  it.each([
    ['/?conversation=abc123', '/chat?conversation=abc123'],
    ['/?agent=iris', '/chat?agent=iris'],
    ['/?new=1', '/chat?new=1'],
  ])('legacy %s redirects to %s (query intact)', async (from, to) => {
    const { getByTestId } = renderAt(from);
    await waitFor(() => expect(getByTestId('loc').textContent).toBe(to));
  });

  it('a bare "/" (signed-in in the app shell) redirects to /dashboard', async () => {
    const { getByTestId } = renderAt('/?utm_source=news'); // unrelated params → still the dashboard
    await waitFor(() => expect(getByTestId('loc').textContent).toBe('/dashboard'));
  });
});

describe('todos auth-gated state', () => {
  it('a 401 renders the sign-in hint, not the error state', async () => {
    listAssignedToMe.mockRejectedValue(new Error('listAssignedToMe returned 401'));
    const { container } = render(<MemoryRouter><TodosTile compact /></MemoryRouter>);
    await waitFor(() => expect(container.querySelector('.dash-tile__state')).toBeTruthy());
    expect(container.textContent).toMatch(/sign in/i);
  });

  it('a non-auth failure still renders the error state', async () => {
    listAssignedToMe.mockRejectedValue(new Error('listAssignedToMe returned 500'));
    const { container } = render(<MemoryRouter><TodosTile compact /></MemoryRouter>);
    await waitFor(() => expect(container.querySelector('.dash-tile__state')).toBeTruthy());
    expect(container.textContent).not.toMatch(/sign in/i);
  });
});
