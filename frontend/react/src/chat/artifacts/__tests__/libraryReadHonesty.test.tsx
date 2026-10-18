/**
 * UX_UPGRADE-library P1 — "don't lie 'empty'" has to cover the failed read too.
 *
 * `LibraryPage`'s own comment states the rule it was half-keeping:
 *   "A filtered tab (Images/Files) may have no matches on the loaded page while
 *    more exist server-side — say so and keep 'Load more' reachable, DON'T LIE
 *    'empty'."
 * It delivered that for the PAGINATION case (`cursor`) and the SEARCH case
 * (`query`) — and missed the FAILED READ. The warning Notice above the panel does
 * fire, but the card still read "No assets yet. Generate a document, deck, image,
 * or design and it'll appear here.", telling someone whose library just failed to
 * load to go regenerate work they already own.
 *
 * Same shape as UX-BRD-1 on /boards: an error notice beside a false claim is
 * still a false claim.
 *
 * Both arms asserted, plus the precedence case — with BOTH `error` and `cursor`
 * truthy the error body must win, because a later conditional spread of the same
 * key silently overwrites an earlier one (a bug I introduced and caught here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../artifactClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../artifactClient.js')>()),
  listArtifacts: vi.fn(),
}));

import { listArtifacts, type ArtifactPage } from '../artifactClient.js';
import { LibraryPage } from '../LibraryPage.js';

const mockList = vi.mocked(listArtifacts);
const EMPTY: ArtifactPage = { artifacts: [] };

function view(): void {
  render(<MemoryRouter><LibraryPage /></MemoryRouter>);
}

beforeEach(() => {
  mockList.mockReset();
  mockList.mockResolvedValue(EMPTY);
});
afterEach(cleanup);

describe("UX-LIB-1 — a failed library read never says \"No assets yet\"", () => {
  it('FAILURE: says it could not load, NOT "generate something"', async () => {
    mockList.mockRejectedValue(new Error('artifacts_500'));
    view();
    expect(await screen.findByText(/Couldn't load your library/i)).toBeTruthy();
    expect(screen.queryByText(/No assets yet/i)).toBeNull();
  });

  it('EMPTY: a genuinely empty library still invites generating one', async () => {
    // The other arm — without it, "always unavailable" would pass the test above
    // while destroying real first-run onboarding.
    view();
    expect(await screen.findByText(/No assets yet/i)).toBeTruthy();
    expect(screen.queryByText(/Couldn't load your library/i)).toBeNull();
  });

  it('PRECEDENCE: with a cursor AND an error, the error title and body win', async () => {
    // A later conditional spread of `body` would silently overwrite the earlier
    // one — the exact bug I introduced writing this fix. The state needs BOTH
    // truthy at once: a successful first page that leaves a cursor and no rows
    // (the "more pages" card), then a failed "Load more" (error set, cursor kept).
    // (Grade-tests w45: the first version failed the FIRST load, so the cursor was
    // never set, and its negative matched no copy in the app — it could not fail.)
    mockList
      .mockResolvedValueOnce({ artifacts: [], nextCursor: 'c1' })
      .mockRejectedValueOnce(new Error('artifacts_500'));
    view();
    // Positive control: the cursor arm is live before the failure.
    expect(await screen.findByText('No matches on this page')).toBeTruthy();
    expect(screen.getByText('None of the loaded items match this filter — load more to keep looking.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText("Couldn't load your library")).toBeTruthy();
    expect(screen.getByText('A loading problem, not an empty library — anything you have generated is still there. Reload before regenerating.')).toBeTruthy();
    expect(screen.queryByText('No matches on this page')).toBeNull();
    expect(screen.queryByText('None of the loaded items match this filter — load more to keep looking.')).toBeNull();
    expect(mockList).toHaveBeenLastCalledWith({ limit: 100, cursor: 'c1' });
  });
});
