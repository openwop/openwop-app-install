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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const apps = [
  { deal: { dealId: 'deal:1', title: 'Staff Backend Engineer', stageName: 'Applied', customFields: { appliedAt: '2026-03-02' } }, digest: { title: 'Staff Backend Engineer', companyName: 'Northwind' } },
];

const PREVIEW = [
  { type: 'authorised-by-person', facts: { authorisedByNamedPerson: true, maxSubmits: 40 }, sourceDigest: 'a'.repeat(32) },
  { type: 'applications-in-window', facts: { count: 12, windowStart: '2026-02-01', windowEnd: '2026-02-28' }, sourceDigest: 'b'.repeat(32) },
];

const preview = vi.fn(async () => ({ kind: 'ok' as const, claims: PREVIEW }));
const issue = vi.fn(async () => ({ token: 'owatt_tok', attestationId: 'att:1' }));
const revoke = vi.fn(async () => undefined);
const listIssued = vi.fn(async () => [] as unknown[]);

vi.mock('../jobSearchClient.js', () => ({
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listApplications: vi.fn(async () => apps.map(({ deal, digest }) => ({
    dealId: String(deal.dealId), title: String(digest.title), companyName: digest.companyName,
    stage: deal.stageName, appliedAt: deal.customFields.appliedAt,
  }))),
  listIssuedAttestations: (...a: unknown[]) => listIssued(...(a as [])),
  previewAttestation: (...a: unknown[]) => preview(...(a as [])),
  issueAttestation: (...a: unknown[]) => issue(...(a as [])),
  revokeAttestation: (...a: unknown[]) => revoke(...(a as [])),
}));

import { JobApplicationsPage } from '../JobApplicationsPage.js';

const openShare = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /share a verification link/i }));
};

describe('the share-a-link consent', () => {
  beforeEach(() => {
    preview.mockClear(); issue.mockClear(); revoke.mockClear();
    listIssued.mockImplementation(async () => []);
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
  beforeEach(() => { preview.mockClear(); issue.mockClear(); listIssued.mockImplementation(async () => []); });
  afterEach(cleanup);

  it('explains, and never offers a confirm button', async () => {
    preview.mockImplementation(async () => ({ kind: 'not-attestable' }) as never);
    render(<JobApplicationsPage />);
    await openShare();
    expect(await screen.findByText(/no record of sending this application/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /create the link/i }), 'a button that must not be pressed').toBeNull();
    expect(issue).not.toHaveBeenCalled();
  });

  it('a failed READ is not reported as "nothing to verify"', async () => {
    // The two are different facts and only one is about the applicant.
    preview.mockImplementation(async () => ({ kind: 'failed' }) as never);
    render(<JobApplicationsPage />);
    await openShare();
    expect(await screen.findByText(/nothing has been shared/i)).toBeTruthy();
    expect(screen.queryByText(/no record of sending/i)).toBeNull();
  });
});

describe('revoking', () => {
  beforeEach(() => {
    revoke.mockClear();
    listIssued.mockImplementation(async () => [{ attestationId: 'att:1', dealId: 'deal:1', issuedAt: '2026-03-02' }]);
    render(<JobApplicationsPage />);
  });
  afterEach(cleanup);

  it('confirms first, and states what revoking cannot undo', async () => {
    fireEvent.click(await screen.findByRole('button', { name: /revoke/i }));
    expect(await screen.findByText(/cannot un-read what has already been read/i)).toBeTruthy();
    expect(revoke, 'the consequential direction confirms').not.toHaveBeenCalled();
  });

  it('offers no second share while one is live', async () => {
    await screen.findByRole('button', { name: /revoke/i });
    expect(screen.queryByRole('button', { name: /share a verification link/i })).toBeNull();
  });
});
