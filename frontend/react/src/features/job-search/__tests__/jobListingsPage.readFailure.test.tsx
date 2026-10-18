/**
 * EMPTY-ON-FAIL-6 (ADR 0779 D7, the RTP-EMPTY-1 class) — a failed listings read is
 * NOT "No listings yet".
 *
 * The catch set `listings` to [], so the table's empty state said "No listings yet
 * — Once a board search runs, matching postings collect here." beside the error:
 * a failed read presented as "there are none". The read now keeps its own flag and
 * the empty copy renders only after a successful read.
 *
 * Break it by dropping the `listingsFailed ?` branch in JobListingsPage (or by
 * restoring `setListings([])` in the catch with the flag ignored).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { JobListing } from '../jobSearchClient.js';
import type { Org } from '../../crm/crmOrgClient.js';

const listListings = vi.fn<(orgId: string) => Promise<JobListing[]>>();
const ORGS: Org[] = [{ orgId: 'org-1', name: 'Acme' }];

vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../jobSearchClient.js', () => ({
  listOrgs: vi.fn(async (): Promise<Org[]> => ORGS),
  listListings: (orgId: string) => listListings(orgId),
  getListingsVisibility: vi.fn(async (): Promise<{ public: boolean }> => ({ public: false })),
  setListingsVisibility: vi.fn(),
}));

const { JobListingsPage } = await import('../JobListingsPage.js');

const FAILED_TITLE = 'Could not load this';
const EMPTY_TITLE = 'No listings yet';
const EMPTY_BODY = 'Once a board search runs, matching postings collect here.';

beforeEach(() => { listListings.mockReset(); });
afterEach(cleanup);

describe('EMPTY-ON-FAIL-6 — a failed listings read is not an empty list', () => {
  it('a rejected read shows the failure, and NOT "No listings yet"', async () => {
    listListings.mockRejectedValue(new Error('listings_500'));
    render(<JobListingsPage />);
    expect(await screen.findByText(FAILED_TITLE)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
    expect(screen.queryByText(EMPTY_BODY)).toBeNull();
  });

  it('Retry re-reads, and a successful empty read then says there are none', async () => {
    listListings.mockRejectedValueOnce(new Error('listings_500')).mockResolvedValue([]);
    render(<JobListingsPage />);
    await screen.findByText(FAILED_TITLE);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(EMPTY_TITLE)).toBeTruthy();
    expect(screen.queryByText(FAILED_TITLE)).toBeNull();
  });

  it('a successful empty read still says "No listings yet" (positive control)', async () => {
    listListings.mockResolvedValue([]);
    render(<JobListingsPage />);
    expect(await screen.findByText(EMPTY_TITLE)).toBeTruthy();
    expect(screen.getByText(EMPTY_BODY)).toBeTruthy();
    expect(screen.queryByText(FAILED_TITLE)).toBeNull();
  });
});
