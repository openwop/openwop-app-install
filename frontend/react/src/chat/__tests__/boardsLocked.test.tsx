/**
 * ADR 0419 — `@@` on a plan that does not include Boards of Advisors.
 *
 * Seen live 2026-10-01: the picker fetched the board list, the server refused
 * with 403, and the composer showed "Couldn't load boards: Your plan (free)
 * does not include this feature.." — a paywall dressed as a failure, with a
 * doubled period. A locked feature is not a load error: it says so, links to
 * where it can be bought, and does not ask the server for a list it will refuse.
 *
 * Sabotage-witnessed (/grade-tests w12): fetching while locked, dropping the locked
 * branch or its bundle link, skipping the fetch when entitled, and dropping the
 * trailing-period trim each turn a case red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../featureToggles/__testing__/makeFeatureAccess.js';
import type { AdvisoryBoard } from '../../features/advisory-board/advisoryBoardClient.js';

const access = vi.hoisted(() => ({ locked: false }));
const listBoards = vi.hoisted(() => vi.fn<() => Promise<AdvisoryBoard[]>>());
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
    const titans: AdvisoryBoard = {
      boardId: 'b-titans', tenantId: 't', orgId: 'org-1', name: 'Living Titans', handle: 'titans',
      advisors: ['r-1', 'r-2'], visibility: 'shared', personaKind: 'historical',
      turnPolicy: { rounds: 1, order: 'declared', synthesize: true },
      createdBy: 'user:me', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', disclaimer: null,
    };
    listBoards.mockResolvedValue([titans]);
    render(picker());
    expect(await screen.findByText(/Living Titans/)).toBeTruthy();
    expect(screen.getByText(/2 advisors/)).toBeTruthy();
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
