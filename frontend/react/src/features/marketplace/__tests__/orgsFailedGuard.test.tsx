/**
 * Marketplace reviews — a failed workspace read must not be rendered as "no
 * reviews for this pack".
 *
 * The reviews panel is ORG-scoped: `listReviews` is gated on the org selection,
 * so a failed workspace read means the reviews were never requested at all. The
 * page consumes `ui/useOrgSelection`'s `orgsFailed` correctly, but nothing
 * failed when the seam itself was sabotaged (`setOrgsFailed(true)` →
 * `setOrgs([])`) and the suite stayed green. This file is the guard that
 * measurement said was missing.
 *
 * It renders the REAL `MarketplacePage` (with the `?pack=` deep link that opens
 * the reviews panel) and forces the failure through the REAL client function the
 * page calls (`marketplaceClient.listOrgs`) — never the hook, never a replica.
 *
 * Both polarities, because an "absent" assertion alone is vacuous — a broken
 * render would satisfy it:
 *   - read FAILS  → the announced, retryable failure card; NEVER the
 *     "Be the first to rate this pack" empty state
 *   - read SUCCEEDS → the genuine "No reviews yet" empty state survives
 *
 * The empty-workspace arm used to be the weak one, and it is worth saying why.
 * With `orgs === []` the panel had no copy of its own (no org ⇒ no reviews
 * request ⇒ a skeleton with no terminal condition), so the arm could only assert
 * that no failure disclosure was invented — true, and satisfied equally by the
 * endless skeleton that was actually rendering. `HG-1` closed that: the arm now
 * pins the real zero-workspace state AND the absence of the skeleton, which is
 * the half that makes it a guard rather than a description.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const access = vi.hoisted(() => ({
  useFeatureAccess: vi.fn(() => makeFeatureAccess({ enabled: true, loading: false, status: 'on', isBeta: false, variant: null })),
}));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: access.useFeatureAccess }));

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(),
  listListings: vi.fn(),
  fetchDisabledPacks: vi.fn(),
  listReviews: vi.fn(),
  // The WRITE half (ORG-HON-2). Both are `(orgId, packName, …)` — an empty
  // `orgId` is a review row keyed on no organization.
  postReview: vi.fn(),
  deleteReview: vi.fn(),
}));
vi.mock('../marketplaceClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});

import { MarketplacePage } from '../MarketplacePage.js';

const PACK = 'community.demo.pack';

beforeEach(() => {
  vi.clearAllMocks();
  api.listListings.mockResolvedValue({
    listings: [{ packName: PACK, version: '1.0.0', title: 'Demo', category: 'node', installed: true }],
    pricingDegraded: false,
  });
  api.fetchDisabledPacks.mockResolvedValue([]);
  api.listReviews.mockResolvedValue({ reviews: [], summary: { packName: PACK, count: 0, average: null } });
});
afterEach(cleanup);

/**
 * Try as hard as a user could to post a review, and report nothing if there is
 * nothing to try. Written as an ATTEMPT rather than an absence check so the
 * write assertion that follows it is falsifiable: restore the old page (rating
 * form rendered with no organization, `!orgId` off the submit button) and this
 * helper actually fires `postReview('', …)`.
 */
const attemptReviewWrite = async (): Promise<void> => {
  const stars = screen.queryAllByRole('radio');
  if (stars.length > 0) fireEvent.click(stars[stars.length - 1] as HTMLElement);
  const submit = screen.queryByRole('button', { name: 'Submit review' });
  if (submit) await act(async () => { fireEvent.click(submit); });
};

const view = (): HTMLElement => {
  const { container } = render(
    <MemoryRouter initialEntries={[`/marketplace?pack=${PACK}`]}>
      <MarketplacePage />
    </MemoryRouter>,
  );
  return container;
};

describe('marketplace reviews — failed workspace read is not "no reviews"', () => {
  it('read FAILS: the honest, retryable card — and NEVER the empty-reviews instruction', async () => {
    api.listOrgs.mockRejectedValue(new Error('boom'));
    view();
    // HG-4 — the SHARED copy, rendered by `ui/OrgSelectionState` in its INLINE
    // variant (this is a panel, not a page), so title and body share one text
    // node. Matched as substrings of that node, not as a looser pattern that
    // would also accept the old per-feature "workspaces" wording.
    await waitFor(() => expect(screen.getByText(/Could not load your organizations/)).toBeTruthy());
    expect(screen.getByText(
      'Could not load your organizations. The reviews were never requested. This is a failed read, not an empty organization list.',
    )).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // The false claim must be absent: the reviews empty state is a statement
    // about the PACK, and no request about the pack was ever made. That covers
    // the panel HEAD too — it rendered `noReviewsInline` on every null summary,
    // and a summary that was never read is not a summary of zero.
    expect(screen.queryByText('No reviews yet')).toBeNull();
    expect(screen.queryByText('Be the first to rate this pack with the form above.')).toBeNull();
    expect(api.listReviews).not.toHaveBeenCalled();
  });

  it('read SUCCEEDS with []: the zero-ORGANIZATION state — not a failure, not an endless skeleton', async () => {
    api.listOrgs.mockResolvedValue([]);
    const container = view();
    // The panel is open (the deep-linked pack resolved) …
    await waitFor(() => expect(screen.getByText(`Reviews — ${PACK}`)).toBeTruthy());
    // … the server answered "none", so the screen says "none" and stops.
    await waitFor(() => expect(screen.getByText(/No organizations/)).toBeTruthy());
    expect(screen.getByText('No organizations. Pack reviews belong to an organization.')).toBeTruthy();
    // The half that makes this a guard: the loading state had no terminal
    // condition, and a bare <Skeleton> is aria-hidden, so the named region
    // ("Reviews for <pack>") contained literally nothing for a screen reader.
    expect(container.querySelector('.skeleton')).toBeNull();
    // Nothing failed, so nothing may say it did …
    expect(screen.queryByText(/Could not load your organizations/)).toBeNull();
    // … and no request about the PACK was made, so no claim about the pack —
    // including the one in the panel HEAD. `summary` is null here because it was
    // never read, and the head rendered `noReviewsInline` on every null summary,
    // so the panel said "No organizations" and "No reviews yet" at once.
    expect(screen.queryByText('No reviews yet')).toBeNull();
    expect(screen.queryByText('Be the first to rate this pack with the form above.')).toBeNull();
    expect(api.listReviews).not.toHaveBeenCalled();
    // The write affordance is gone with its target: submitting fired
    // `postReview('', …)` — an actionable control with no workspace to write to.
    expect(screen.queryByRole('button', { name: 'Submit review' })).toBeNull();
    // ORG-HON-2 — the regression pin for the bug this page already had. The
    // control's ABSENCE is the current fix, but the fix that matters is that no
    // review is ever posted against an empty organization id, and that survives a
    // refactor which brings the control back under a different label. There is
    // nothing to click, so the whole rating form is checked for absence and the
    // client function is asserted un-called.
    expect(screen.queryByRole('radiogroup', { name: 'Your rating' })).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    await attemptReviewWrite();
    expect(api.postReview).not.toHaveBeenCalled();
    // The delete write is per-review and no reviews were read, so it is
    // unreachable for the same reason — pinned because it is the same
    // `(orgId, …)` shape.
    expect(api.deleteReview).not.toHaveBeenCalled();
  });

  it('read FAILS: the rating form is GONE too, not merely inert', async () => {
    // The other orgless state, and the one the page-local `noOrgs ? null :`
    // guard did NOT cover: `noOrgs` is false for a FAILED read, so the stars and
    // the comment box rendered over the failure card with `!orgId` quietly
    // disabling the submit. A control that accepts a rating and a paragraph of
    // prose and then discards them is a worse account of the failure than no
    // control. The form is a CHILD of `OrgSelectionState` now, so all three
    // orgless states are answered by one branch instead of two flags.
    api.listOrgs.mockRejectedValue(new Error('boom'));
    view();
    await waitFor(() => expect(screen.getByText(/Could not load your organizations/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Submit review' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Your rating' })).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    // The handler guard survives a refactor that brings the control back.
    await attemptReviewWrite();
    expect(api.postReview).not.toHaveBeenCalled();
  });

  it('healthy read with no reviews: the genuine "No reviews yet" empty state still shows', async () => {
    api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
    view();
    await waitFor(() => expect(screen.getByText('Be the first to rate this pack with the form above.')).toBeTruthy());
    expect(screen.queryByText(/Could not load your organizations/)).toBeNull();
  });

  it('positive control: with an organization the SAME gestures do post a review', async () => {
    // Without this, the two `postReview` assertions above could pass because the
    // rating form is broken for every user, which is a different bug wearing the
    // same green.
    // DELIBERATELY SLOW: the org read resolves a tick late, so the gap between "the
    // Submit button exists" and "an org is selected" is always open rather than open
    // only on a loaded machine. That turns an order-dependent flake into a deterministic
    // guard — MEASURED: with the old button-only wait this delay fails the leg every
    // run; with the wait below it passes every run.
    api.listOrgs.mockImplementation(() => new Promise((r) => setTimeout(() => r([{ orgId: 'o1', name: 'Acme' }]), 40)));
    api.postReview.mockResolvedValue({ reviewId: 'r1', authorId: 'u1', rating: 5, createdAt: '2026-01-01T00:00:00Z' });
    view();
    // Wait for the ORG-RESOLVED state, not merely for the button. `postReview` is called
    // with the selected org (`calls[0][0] === 'o1'`), so the gesture depends on
    // `listOrgs` having resolved — but the Submit button renders BEFORE that. Waiting on
    // the button alone let the click land on an unselected org, and the handler then
    // posted nothing: an intermittent red that blocked two consecutive CI runs while
    // passing in isolation every time. The empty-state copy below is the same signal the
    // healthy-read test above waits for, and it appears only after a SUCCESSFUL org read
    // (reviews are org-gated), so it proves the precondition the gesture actually needs.
    await waitFor(() => expect(screen.getByText('Be the first to rate this pack with the form above.')).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit review' })).toBeTruthy());
    fireEvent.click(screen.getByRole('radio', { name: '5 stars' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Submit review' })); });
    expect(api.postReview).toHaveBeenCalledTimes(1);
    expect(api.postReview.mock.calls[0]?.[0]).toBe('o1');
  });
});
