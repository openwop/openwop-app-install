/**
 * ADR 1036 D10 + the row-81 grade-ux pass — what the job-search pages offer must
 * match what the server will do.
 *
 *  - The Applications list is the WORKSPACE's (ADR 0546). Sharing a colleague's
 *    application only meets the server's "not yours" refusal, so their rows
 *    carry no Share button, only a plain statement of who can share.
 *  - A grant with every submission spent read "Active" and offered "Queue a run",
 *    which the server then refused. It reads "Used up" and offers only Revoke.
 *  - A failed attestation revoke said "Could not load your applications".
 *
 * Break it by rendering Share regardless of `mine` (case 1), dropping the
 * `exhausted` branch from `statusOf` (case 2), or restoring the old toast key
 * (case 3).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ApplyGrantView, AttestationRow, JobApplication } from '../jobSearchClient.js';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: toastError } }));

const APPS: JobApplication[] = [
  { dealId: 'deal:mine', title: 'My Role', companyName: 'Northwind', stage: 'Applied', appliedAt: '2026-03-02', mine: true },
  { dealId: 'deal:theirs', title: 'Their Role', companyName: 'Contoso', stage: 'Applied', appliedAt: '2026-03-05', mine: false },
];
const ISSUED: AttestationRow[] = [
  { attestationId: 'att:1', dealId: 'deal:mine', issuedAt: '2026-03-03' },
];
const FUTURE = '2999-01-01T00:00:00.000Z';
const grant = (over: Partial<ApplyGrantView>): ApplyGrantView => ({
  grantId: 'g1', subjectId: 'me', grantedBy: 'me', campaignId: 'c', maxSubmits: 5, submitsUsed: 0, maxPrepared: 5,
  preparedUsed: 0, ratePerHour: 4, tiers: ['A'], origins: ['boards.example.com'], expiresAt: FUTURE, revokedAt: null,
  createdAt: '2026-03-01', ...over,
});
let GRANTS: ApplyGrantView[] = [];
const revoke = vi.fn(async () => { throw new Error('revoke_500'); });

vi.mock('../jobSearchClient.js', () => ({
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listApplications: vi.fn(async (): Promise<JobApplication[]> => APPS),
  listIssuedAttestations: vi.fn(async () => ISSUED),
  previewAttestation: vi.fn(),
  issueAttestation: vi.fn(),
  revokeAttestation: () => revoke(),
  listGrants: vi.fn(async () => GRANTS),
  createGrant: vi.fn(),
  revokeGrant: vi.fn(),
  queueCampaign: vi.fn(),
}));

const { JobApplicationsPage } = await import('../JobApplicationsPage.js');
const { ApplyGrantPage } = await import('../ApplyGrantPage.js');

afterEach(() => { cleanup(); toastError.mockReset(); });

describe('Applications — only the applicant is offered Share', () => {
  it("a colleague's row has no Share button and says who can share", async () => {
    render(<JobApplicationsPage />);
    const theirs = (await screen.findByText('Their Role')).closest('tr')!;
    expect(within(theirs).queryByRole('button', { name: /share a verification link/i })).toBeNull();
    expect(within(theirs).getByText('Only the applicant can share')).toBeTruthy();
  });

  it('a failed revoke says the revoke failed, not that the list did not load', async () => {
    render(<JobApplicationsPage />);
    const mine = (await screen.findByText('My Role')).closest('tr')!;
    fireEvent.click(within(mine).getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /revoke/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not revoke the verification link.'));
  });
});

describe('Auto-apply authority — a used-up grant', () => {
  it('reads "Used up", offers Revoke, and offers no Queue', async () => {
    GRANTS = [grant({ submitsUsed: 5, maxSubmits: 5 })];
    render(<ApplyGrantPage />);
    expect(await screen.findByText('Used up')).toBeTruthy();
    expect(screen.queryByText('Active')).toBeNull();
    expect(screen.queryByRole('button', { name: /queue/i })).toBeNull();
    expect(screen.getByRole('button', { name: /revoke/i })).toBeTruthy();
  });

  it('a grant with submissions left is still Active and queueable (positive control)', async () => {
    GRANTS = [grant({ submitsUsed: 1 })];
    render(<ApplyGrantPage />);
    expect(await screen.findByText('Active')).toBeTruthy();
    expect(screen.getByRole('button', { name: /queue/i })).toBeTruthy();
  });
});
