/**
 * ADR 0419 — `@@` on a plan that does not include Boards of Advisors.
 *
 * Seen live 2026-10-01: the picker fetched the board list, the server refused
 * with 403, and the composer showed "Couldn't load boards: Your plan (free)
 * does not include this feature.." — a paywall dressed as a failure, with a
 * doubled period. A locked feature is not a load error: it says so, links to
 * where it can be bought, and does not ask the server for a list it will refuse.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../featureToggles/__testing__/makeFeatureAccess.js';

const access = vi.hoisted(() => ({ locked: false }));
const listBoards = vi.hoisted(() => vi.fn());
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ locked: access.locked, entitled: !access.locked }),
}));
vi.mock('../../features/advisory-board/advisoryBoardClient.js', () => ({ listBoards }));
// ADR 0419 §8 follow-on — the bundle that sells boards comes from the catalog read.
vi.mock('../../features/marketplace/marketplaceClient.js', () => ({
  fetchFeatureBundles: async () => ({
    available: true,
    bundles: [{ id: 'leadership', label: 'Planning & Strategy', features: [{ id: 'advisory-board', registered: true, dependsOn: [] }] }],
    standalone: [],
    core: [],
  }),
  fetchBundleCommerce: async () => [],
  fetchPublicPricing: async () => [],
}));

import { BoardMentionAutocomplete } from '../BoardMentionAutocomplete.js';

const noop = (): void => undefined;
const picker = (): JSX.Element => (
  <MemoryRouter>
    <BoardMentionAutocomplete text="@@" cursorPos={2} onPick={noop} onDismiss={noop} />
  </MemoryRouter>
);

afterEach(() => { cleanup(); listBoards.mockReset(); access.locked = false; });

describe('the `@@` picker on a plan without boards', () => {
  it('shows the locked state with the way to unlock it, and never fetches', async () => {
    access.locked = true;
    render(picker());
    const link = await screen.findByRole('link');
    // The link opens the bundle that sells boards, once the catalog lands.
    await waitFor(() => expect(link.getAttribute('href')).toBe('/marketplace/bundles?bundle=leadership'));
    expect(link.closest('div')?.textContent).toMatch(/included in your plan/i);
    expect(screen.queryByText(/couldn.t load boards/i)).toBeNull();
    expect(listBoards).not.toHaveBeenCalled();
  });

  it('an entitled plan still loads and lists boards', async () => {
    listBoards.mockResolvedValue([{ handle: 'titans', name: 'Living Titans', advisors: [1, 2] }]);
    render(picker());
    expect(await screen.findByText(/Living Titans/)).toBeTruthy();
    expect(listBoards).toHaveBeenCalledTimes(1);
  });

  it('a real load failure reads as one sentence — no doubled period', async () => {
    listBoards.mockImplementation(() => Promise.reject(new Error('The server did not answer.')));
    render(picker());
    await waitFor(() => expect(screen.getByText(/couldn.t load boards/i)).toBeTruthy());
    const text = screen.getByText(/couldn.t load boards/i).textContent ?? '';
    expect(text).toMatch(/did not answer\.$/);
    expect(text).not.toMatch(/\.\./);
  });
});
