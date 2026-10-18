/**
 * ADR 0544 P4 — the consent surface.
 *
 * Matrix row 10's requirement is one sentence: "the number is shown before
 * consent, because consenting to disclose an unseen number is not consent." The
 * assertions below are what makes that sentence checkable rather than aspirational:
 *
 *  1. the concrete numbers are on screen BEFORE the confirming control is pressed;
 *  2. nothing is issued by the click that opens the dialog;
 *  3. the dialog states what is NOT shared, and states the limit of revocation
 *     honestly (the ADR 0542 P5 finding: "revoke any time" overstates it);
 *  4. a refusal never opens a confirm box — a "Create the link" button above an
 *     explanation of why no link can exist is a button that must not be pressed.
 *
 * w52: TWO applications, and the share is started on the SECOND, so the link
 * issued is asserted to be for the deal whose numbers were shown (round 1 had one
 * application and never read `issue`'s arguments — sc-binding was vacuous). The
 * revoke leg now also confirms and asserts what was revoked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { AttestationPreview, AttestationRow, JobApplication } from '../jobSearchClient.js';
import type { VerifierClaim } from '../attestationVerifyClient.js';

vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const APPS: JobApplication[] = [
  { dealId: 'deal:1', title: 'Staff Backend Engineer', companyName: 'Northwind', stage: 'Applied', appliedAt: '2026-03-02' },
  { dealId: 'deal:2', title: 'Platform Engineer', companyName: 'Contoso', stage: 'Applied', appliedAt: '2026-03-05' },
];

const PREVIEW: VerifierClaim[] = [
  { type: 'authorised-by-person', facts: { authorisedByNamedPerson: true, maxSubmits: 40 }, sourceDigest: 'a'.repeat(32) },
  { type: 'applications-in-window', facts: { count: 12, windowStart: '2026-02-01', windowEnd: '2026-02-28' }, sourceDigest: 'b'.repeat(32) },
];

type Client = typeof import('../jobSearchClient.js');
const { preview, issue, revoke, listIssued } = vi.hoisted(() => ({
  preview: vi.fn<Client['previewAttestation']>(),
  issue: vi.fn<Client['issueAttestation']>(),
  revoke: vi.fn<Client['revokeAttestation']>(),
  listIssued: vi.fn<Client['listIssuedAttestations']>(),
}));
const OK: AttestationPreview = { kind: 'ok', claims: PREVIEW };

vi.mock('../jobSearchClient.js', () => ({
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listApplications: vi.fn(async (): Promise<JobApplication[]> => APPS),
  listIssuedAttestations: listIssued,
  previewAttestation: preview,
  issueAttestation: issue,
  revokeAttestation: revoke,
}));

import { JobApplicationsPage } from '../JobApplicationsPage.js';

/** The table row of one application. */
const rowOf = async (title: string): Promise<HTMLElement> => (await screen.findByText(title)).closest('tr')!;

/** Share on the SECOND application (deal:2), so the deal the link is for is checkable. */
const openShare = async () => {
  fireEvent.click(within(await rowOf('Platform Engineer')).getByRole('button', { name: /share a verification link/i }));
};

function resetMocks(issued: AttestationRow[] = []): void {
  preview.mockReset(); issue.mockReset(); revoke.mockReset(); listIssued.mockReset();
  preview.mockResolvedValue(OK);
  issue.mockResolvedValue({ token: 'owatt_tok', attestationId: 'att:2' });
  revoke.mockResolvedValue(undefined);
  listIssued.mockResolvedValue(issued);
}

describe('the share-a-link consent', () => {
  beforeEach(() => {
    resetMocks();
    render(<JobApplicationsPage />);
  });
  afterEach(cleanup);

  it('shows the ACTUAL numbers before the confirming control exists', async () => {
    await openShare();
    // The concrete figures, not a description of them.
    expect(await screen.findByText(/12 applications sent/i)).toBeTruthy();
    expect(screen.getByText(/40 automatic applications/i)).toBeTruthy();
    // …and only now is there something to press.
    expect(screen.getByRole('button', { name: /create the link/i })).toBeTruthy();
  });

  it('issues NOTHING until the applicant confirms', async () => {
    await openShare();
    await screen.findByText(/12 applications sent/i);
    expect(issue, 'opening the dialog must not disclose anything').not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /create the link/i }));
    await waitFor(() => expect(issue).toHaveBeenCalledTimes(1));
    // The link is for the application whose numbers were previewed — deal:2.
    expect(preview).toHaveBeenCalledWith('org-1', 'deal:2');
    expect(issue).toHaveBeenCalledWith('org-1', 'deal:2');
  });

  it('cancelling issues nothing', async () => {
    await openShare();
    await screen.findByText(/12 applications sent/i);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByText(/12 applications sent/i)).toBeNull());
    expect(issue).not.toHaveBeenCalled();
  });

  it('says what is NOT shared, and does not overstate revocation', async () => {
    await openShare();
    // Without this line the dialog reads as "we send them everything we know".
    expect(await screen.findByText(/will not see your name/i)).toBeTruthy();
    // ADR 0542 P5's finding applied here: revoking cannot un-read.
    expect(screen.getByText(/cannot un-read/i)).toBeTruthy();
  });

  it('shows the link once, and says that it is once', async () => {
    await openShare();
    await screen.findByText(/12 applications sent/i);
    fireEvent.click(screen.getByRole('button', { name: /create the link/i }));
    expect(await screen.findByText(/\/verify\/owatt_tok/)).toBeTruthy();
    expect(screen.getByText(/shown once and cannot be retrieved/i)).toBeTruthy();
  });
});

describe('when there is nothing to attest', () => {
  beforeEach(() => { resetMocks(); });
  afterEach(cleanup);

  it('explains, and never offers a confirm button', async () => {
    preview.mockResolvedValue({ kind: 'not-attestable' });
    render(<JobApplicationsPage />);
    await openShare();
    expect(await screen.findByText(/no record of sending this application/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /create the link/i }), 'a button that must not be pressed').toBeNull();
    expect(issue).not.toHaveBeenCalled();
  });

  it('a failed READ is not reported as "nothing to verify"', async () => {
    // The two are different facts and only one is about the applicant.
    preview.mockResolvedValue({ kind: 'failed' });
    render(<JobApplicationsPage />);
    await openShare();
    expect(await screen.findByText(/nothing has been shared/i)).toBeTruthy();
    expect(screen.queryByText(/no record of sending/i)).toBeNull();
  });
});

describe('revoking', () => {
  beforeEach(() => {
    resetMocks([{ attestationId: 'att:1', dealId: 'deal:1', issuedAt: '2026-03-02' }]);
    render(<JobApplicationsPage />);
  });
  afterEach(cleanup);

  it('confirms first, and states what revoking cannot undo', async () => {
    fireEvent.click(within(await rowOf('Staff Backend Engineer')).getByRole('button', { name: /revoke/i }));
    expect(await screen.findByText(/cannot un-read what has already been read/i)).toBeTruthy();
    expect(revoke, 'the consequential direction confirms').not.toHaveBeenCalled();
    // Confirming revokes exactly the live attestation.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^revoke$/i }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('org-1', 'att:1'));
  });

  it('offers no second share while one is live', async () => {
    const live = await rowOf('Staff Backend Engineer');
    await within(live).findByRole('button', { name: /revoke/i });
    expect(within(live).queryByRole('button', { name: /share a verification link/i })).toBeNull();
    // Positive control: the OTHER application, with nothing live, can still share.
    expect(within(await rowOf('Platform Engineer')).getByRole('button', { name: /share a verification link/i })).toBeTruthy();
  });
});
