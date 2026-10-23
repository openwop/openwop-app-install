/**
 * CM-3 + CS-4 + POLISH-KT-1 — the community page's action and failure states.
 *
 *  - a failed profile SAVE says so beside the save action in its own copy (not
 *    the page-load "Could not load community"), and the editor keeps the edits;
 *  - a successful save / submit / review is announced;
 *  - each review composer has its own busy flag: one review in flight does not
 *    disable another challenge's submit;
 *  - a non-403 review failure gets its own copy in that row, and a 403 stays the
 *    proof-gate copy (KTUX-2) — each case asserts the other's copy is absent;
 *  - a page-load failure carries a Retry that re-reads and recovers;
 *  - the rating aggregate uses no text glyph as an icon and gives screen
 *    readers the rating as a sentence.
 *
 * Breaks it: routing a save/review failure back to the page-load error; a failed
 * save that reloads the profile over the edits; collapsing any review failure
 * into the proof-gate copy (or a 403 into the generic one); one
 * shared busy across reviews; dropping the success Notices or their
 * `announce`; dropping the Retry button; restoring the `★` glyph or dropping
 * the sr-only sentence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ChallengeSummary, Enrollment } from '../../../client/kicktodoClient.js';
import type { CreatorProfile } from '../../../client/kicktodoCommunityClient.js';
import type * as CommunityClient from '../../../client/kicktodoCommunityClient.js';
import type * as Announce from '../../../ui/announce.js';

const PROFILE: CreatorProfile = { handle: 'ada', displayName: 'Ada', bio: '', links: [], state: 'draft' };
const ENROLLMENTS: Enrollment[] = [
  { id: 'enr:1', challengeId: 'ch:1', challengeVersion: 1, state: 'active', goalId: 'g:1', planRevision: 1, timezone: 'UTC', startDateLocal: '2026-01-01' },
  { id: 'enr:2', challengeId: 'ch:2', challengeVersion: 1, state: 'active', goalId: 'g:2', planRevision: 1, timezone: 'UTC', startDateLocal: '2026-01-01' },
];
const CHALLENGES: ChallengeSummary[] = [
  { id: 'ch:1', version: 1, status: 'published', title: 'Focus Sprint', summary: 's', outcome: 'o', durationDays: 14, activities: [] },
  { id: 'ch:2', version: 1, status: 'published', title: 'Walk Daily', summary: 's', outcome: 'o', durationDays: 7, activities: [] },
];

const m = vi.hoisted(() => ({
  getMyProfile: vi.fn<typeof CommunityClient.getMyProfile>(),
  saveProfile: vi.fn<typeof CommunityClient.saveProfile>(),
  submitMyProfile: vi.fn<typeof CommunityClient.submitMyProfile>(),
  getReviews: vi.fn<typeof CommunityClient.getReviews>(),
  writeReview: vi.fn<typeof CommunityClient.writeReview>(),
  announce: vi.fn<typeof Announce.announce>(),
}));

vi.mock('../../../client/kicktodoClient.js', () => ({
  listEnrollments: vi.fn<() => Promise<Enrollment[]>>(() => Promise.resolve(ENROLLMENTS)),
  listChallenges: vi.fn<() => Promise<ChallengeSummary[]>>(() => Promise.resolve(CHALLENGES)),
}));
vi.mock('../../../client/kicktodoCommunityClient.js', async (orig) => ({
  getMyProfile: m.getMyProfile,
  saveProfile: m.saveProfile,
  submitMyProfile: m.submitMyProfile,
  getReviews: m.getReviews,
  writeReview: m.writeReview,
  CommunityRequestError: (await orig<typeof import('../../../client/kicktodoCommunityClient.js')>()).CommunityRequestError,
}));
vi.mock('../../../ui/announce.js', () => ({ announce: m.announce }));

import { CommunityPage } from '../CommunityPage.js';
import { CommunityRequestError } from '../../../client/kicktodoCommunityClient.js';
import { messages as en } from '../i18n/en.js';
import { messages as common } from '../../../i18n/locales/en/common.js';

beforeEach(() => {
  m.getMyProfile.mockResolvedValue(PROFILE);
  m.getReviews.mockResolvedValue({ reviews: [], aggregate: { count: 0, average: null } });
  m.saveProfile.mockResolvedValue(PROFILE);
  m.submitMyProfile.mockResolvedValue({ ...PROFILE, state: 'pending' });
  m.writeReview.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const profileSection = () => screen.getByRole('region', { name: en.profileHeading });
const reviewRow = (title: string) => screen.getByText(title).closest('li') as HTMLElement;

function openComposerAndRate(title: string) {
  const row = reviewRow(title);
  fireEvent.click(within(row).getByRole('button', { name: en.writeReviewCta }));
  fireEvent.click(within(row).getByRole('radio', { name: en.starAria.replace('{{n}}', '4') }));
  return row;
}

describe('CommunityPage actions', () => {
  it('a failed save shows its own copy beside the action and keeps the editor', async () => {
    m.saveProfile.mockRejectedValueOnce(new CommunityRequestError(500));
    render(<CommunityPage />);
    const handle = await screen.findByRole('textbox', { name: en.handleLabel });
    fireEvent.change(handle, { target: { value: 'ada-new' } });
    fireEvent.click(within(profileSection()).getByRole('button', { name: en.saveDraftCta }));
    expect(await within(profileSection()).findByText(en.saveError)).toBeTruthy();
    await waitFor(() => expect(m.announce).toHaveBeenCalledWith(en.saveError, expect.anything()));
    expect(screen.queryByText(en.loadError)).toBeNull();
    expect(m.saveProfile).toHaveBeenCalledWith({ handle: 'ada-new', displayName: 'Ada', bio: '' });
    // The edit survives the failed save (the stored handle is still 'ada').
    expect((screen.getByRole('textbox', { name: en.handleLabel }) as HTMLInputElement).value).toBe('ada-new');
  });

  it('a successful save and submit are announced', async () => {
    render(<CommunityPage />);
    await screen.findByRole('textbox', { name: en.handleLabel });
    fireEvent.click(within(profileSection()).getByRole('button', { name: en.saveDraftCta }));
    expect(await within(profileSection()).findByText(en.savedNotice)).toBeTruthy();
    await waitFor(() => expect(m.announce).toHaveBeenCalledWith(en.savedNotice, expect.anything()));
    expect(m.saveProfile).toHaveBeenCalledWith({ handle: 'ada', displayName: 'Ada', bio: '' });
    expect(m.submitMyProfile).not.toHaveBeenCalled();
    fireEvent.click(within(profileSection()).getByRole('button', { name: en.submitCta }));
    expect(await within(profileSection()).findByText(en.submittedNotice)).toBeTruthy();
    await waitFor(() => expect(m.announce).toHaveBeenCalledWith(en.submittedNotice, expect.anything()));
    expect(m.saveProfile).toHaveBeenCalledTimes(2);
    expect(m.submitMyProfile).toHaveBeenCalledTimes(1);
  });

  it('one review in flight does not disable another challenge’s submit', async () => {
    m.writeReview.mockImplementation(() => new Promise(() => {})); // never settles
    render(<CommunityPage />);
    await screen.findByText('Walk Daily');
    const first = openComposerAndRate('Focus Sprint');
    const second = openComposerAndRate('Walk Daily');
    const firstSubmit = within(first).getByRole('button', { name: en.submitReviewCta }) as HTMLButtonElement;
    fireEvent.click(firstSubmit);
    await waitFor(() => expect(firstSubmit.disabled).toBe(true));
    expect((within(second).getByRole('button', { name: en.submitReviewCta }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a non-403 review failure gets its own copy in that row; a success is announced', async () => {
    m.writeReview.mockRejectedValueOnce(new CommunityRequestError(500)).mockResolvedValueOnce(undefined);
    render(<CommunityPage />);
    await screen.findByText('Walk Daily');
    const row = openComposerAndRate('Focus Sprint');
    fireEvent.click(within(row).getByRole('button', { name: en.submitReviewCta }));
    expect(await within(row).findByText(en.reviewSubmitError)).toBeTruthy();
    expect(screen.queryByText(en.loadError)).toBeNull();
    expect(screen.queryByText(en.proofDenied)).toBeNull();
    fireEvent.click(within(reviewRow('Focus Sprint')).getByRole('button', { name: en.submitReviewCta }));
    expect(await within(reviewRow('Focus Sprint')).findByText(en.reviewPosted)).toBeTruthy();
    await waitFor(() => expect(m.announce).toHaveBeenCalledWith(en.reviewPosted, expect.anything()));
    expect(screen.queryByText(en.reviewSubmitError)).toBeNull();
    // The rating survived the failure and was re-sent as-is.
    expect(m.writeReview).toHaveBeenCalledTimes(2);
    expect(m.writeReview).toHaveBeenLastCalledWith({ challengeId: 'ch:1', challengeVersion: 1, rating: 4 });
  });

  it('a 403 review failure is the proof-gate copy, not the generic one', async () => {
    m.writeReview.mockRejectedValueOnce(new CommunityRequestError(403));
    render(<CommunityPage />);
    await screen.findByText('Walk Daily');
    const row = openComposerAndRate('Focus Sprint');
    fireEvent.click(within(row).getByRole('button', { name: en.submitReviewCta }));
    expect(await within(reviewRow('Focus Sprint')).findByText(en.proofDenied)).toBeTruthy();
    expect(screen.queryByText(en.reviewSubmitError)).toBeNull();
    expect(screen.queryByText(en.reviewPosted)).toBeNull();
    // Only the row that was refused says so.
    expect(within(reviewRow('Walk Daily')).queryByText(en.proofDenied)).toBeNull();
  });

  it('a page-load failure offers Retry, which re-reads and recovers', async () => {
    m.getMyProfile.mockReset();
    m.getMyProfile.mockRejectedValueOnce(new CommunityRequestError(500)).mockResolvedValue(PROFILE);
    render(<CommunityPage />);
    const retry = await screen.findByRole('button', { name: common.retry });
    // KTUX-3: no profile editor (blank fields) over a profile that was never read.
    expect(screen.queryByRole('textbox', { name: en.handleLabel })).toBeNull();
    fireEvent.click(retry);
    const handle = await screen.findByRole('textbox', { name: en.handleLabel });
    expect((handle as HTMLInputElement).value).toBe('ada');
    expect(screen.queryByRole('button', { name: common.retry })).toBeNull();
    expect(m.getMyProfile).toHaveBeenCalledTimes(2);
  });

  it('the rating aggregate uses an icon, not a text glyph, and reads as a sentence', async () => {
    m.getReviews.mockResolvedValue({ reviews: [], aggregate: { count: 12, average: 4.5 } });
    render(<CommunityPage />);
    await screen.findByText('Focus Sprint');
    const row = reviewRow('Focus Sprint');
    expect(row.textContent).not.toContain('★');
    expect(within(row).getByText('Rated 4.5 out of 5 from 12 reviews')).toBeTruthy();
  });
});
