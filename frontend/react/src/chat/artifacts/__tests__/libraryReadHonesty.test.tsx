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
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ listArtifacts: vi.fn() }));
vi.mock('../artifactClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listArtifacts: api.listArtifacts };
});

import { LibraryPage } from '../LibraryPage.js';

function view(): void {
  render(<MemoryRouter><LibraryPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listArtifacts.mockResolvedValue({ artifacts: [], nextCursor: null });
});
afterEach(cleanup);

describe("UX-LIB-1 — a failed library read never says \"No assets yet\"", () => {
  it('FAILURE: says it could not load, NOT "generate something"', async () => {
    api.listArtifacts.mockRejectedValue(new Error('artifacts_500'));
    view();
    expect(await screen.findByText(/Couldn't load your library/i)).toBeTruthy();
    expect(screen.queryByText(/No assets yet/i)).toBeNull();
  });

  it('EMPTY: a genuinely empty library still invites generating one', async () => {
    // The other arm — without it, "always unavailable" would pass the test above
    // while destroying real first-run onboarding.
    api.listArtifacts.mockResolvedValue({ artifacts: [], nextCursor: null });
    view();
    expect(await screen.findByText(/No assets yet/i)).toBeTruthy();
    expect(screen.queryByText(/Couldn't load your library/i)).toBeNull();
  });

  it('PRECEDENCE: with a cursor AND an error, the error body wins', async () => {
    // A later conditional spread of `body` would silently overwrite the earlier
    // one — the exact bug I introduced writing this fix.
    api.listArtifacts.mockRejectedValue(new Error('artifacts_500'));
    view();
    await screen.findByText(/Couldn't load your library/i);
    expect(screen.queryByText(/more pages/i)).toBeNull();
  });
});
