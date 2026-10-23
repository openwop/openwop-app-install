/**
 * CM-2 + CS-4 + POLISH-KT-1 — the coach console's designed states.
 *
 *  - signed out (site tier): the visitor sees what the console is and a sign-in
 *    action, and the page makes NO caseload read (the CirclesPage precedent);
 *  - a caseload load failure carries a Retry that re-reads and recovers;
 *  - a refused dry run names its REASON in localized copy keyed on the server's
 *    status + envelope code — an incomplete command by position, a lost coach
 *    grant, a rate limit — and never renders the server's English text; "outside
 *    the lanes" appears only for the 422 that means it;
 *
 * Breaks it: dropping the `anonymous` branch (no sign-in card, a caseload read
 * fires); dropping the Retry button from the load-failure Notice; reverting
 * `previewFailureMessage` to the raw message / the single "outside the lanes"
 * string.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CaseloadRow } from '../../../client/kicktodoCirclesClient.js';
import type * as CirclesClient from '../../../client/kicktodoCirclesClient.js';
import type { UseAuth } from '../../../auth/useAuth.js';
import type { AuthUser } from '../../../auth/firebase.js';

const SIGNED_OUT: UseAuth = {
  user: null, loading: false, isConfigured: true,
  signIn: { google: async () => {}, github: async () => {} }, signOut: async () => {},
};
const COACH: AuthUser = { uid: 'u1', email: 'coach@example.com', displayName: 'Coach', photoURL: null, providerIds: [] };
const auth = vi.hoisted(() => ({ value: null as UseAuth | null }));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => auth.value ?? SIGNED_OUT }));
vi.mock('../../../auth/SignInButton.js', () => ({
  SignInButton: () => <button type="button">Sign in to KickTodo</button>,
}));

const { getCaseload, dryRunProposal } = vi.hoisted(() => ({
  getCaseload: vi.fn<typeof CirclesClient.getCaseload>(),
  dryRunProposal: vi.fn<typeof CirclesClient.dryRunProposal>(),
}));
vi.mock('../../../client/kicktodoCirclesClient.js', async (orig) => {
  const actual = await orig<typeof import('../../../client/kicktodoCirclesClient.js')>();
  return { CoachRequestError: actual.CoachRequestError, getCaseload, dryRunProposal, createProposal: vi.fn<typeof CirclesClient.createProposal>() };
});

import { CoachConsolePage } from '../CoachConsolePage.js';
import { CoachRequestError } from '../../../client/kicktodoCirclesClient.js';
import { messages as en } from '../i18n/en.js';
import { messages as common } from '../../../i18n/locales/en/common.js';

const row: CaseloadRow = {
  circleId: 'circ:1', circleName: 'March Cohort', enrollmentId: 'enr:1',
  summary: null, flagged: false, proposals: [],
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  auth.value = null;
});
const signIn = () => { auth.value = { ...SIGNED_OUT, user: COACH }; };

function mount() {
  return render(<MemoryRouter><CoachConsolePage /></MemoryRouter>);
}

async function openComposerAndPreview() {
  mount();
  fireEvent.click(await screen.findByText('March Cohort'));
  fireEvent.click(screen.getByRole('button', { name: en.coachAddCommand }));
  fireEvent.click(screen.getByRole('button', { name: en.coachPreviewCta }));
}

describe('CoachConsolePage states', () => {
  it('signed out: shows the sign-in card and never reads the caseload', () => {
    mount();
    expect(screen.getByText(en.coachSignedOutTitle)).toBeTruthy();
    expect(screen.getByText(en.coachSignedOutBody)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in to KickTodo' })).toBeTruthy();
    expect(getCaseload).not.toHaveBeenCalled();
  });

  it('a caseload load failure offers Retry, which re-reads and recovers', async () => {
    signIn();
    getCaseload.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([row]);
    mount();
    expect(await screen.findByText(en.coachLoadError)).toBeTruthy();
    // A failed read is not "no one invited you yet".
    expect(screen.queryByText(en.coachEmptyTitle)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: common.retry }));
    expect(await screen.findByText('March Cohort')).toBeTruthy();
    expect(screen.queryByText(en.coachLoadError)).toBeNull();
    expect(getCaseload).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an incomplete command, named by position', new CoachRequestError(400, 'validation_error', 'Command 0 (move) must carry exactly …', 0), 'Command 1 is incomplete. Check its fields and preview again.', 0],
    ['a list-level validation failure', new CoachRequestError(400, 'validation_error', 'A revision carries at most 5 commands.', null), en.coachPreviewInvalid, 0],
    ['a lost coach grant', new CoachRequestError(404, 'not_found', 'Circle not found.', null), en.coachPreviewNoAccess, 0],
    ['a command outside the coach lanes', new CoachRequestError(422, 'validation_error', 'off lane', null), en.coachPreviewOffLane, 1],
    ['a rate limit', new CoachRequestError(429, 'rate_limited', 'slow down', null), common['error_rate-limited'], 0],
  ] as const)('a refused dry run shows its reason: %s', async (_label, err, expected, offLaneCount) => {
    signIn();
    getCaseload.mockResolvedValue([row]);
    dryRunProposal.mockRejectedValueOnce(err);
    await openComposerAndPreview();
    const alert = await screen.findByText(expected);
    expect(alert).toBeTruthy();
    // Never the server's English text, and "outside the lanes" only when it is.
    expect(document.body.textContent).not.toContain(err.message);
    expect(screen.queryAllByText(en.coachPreviewOffLane)).toHaveLength(offLaneCount);
  });
});
