/**
 * ADR 0542 P5 — the publish control, after `/ux-review`.
 *
 * This control makes a workspace's listings readable by anyone with no sign-in,
 * so the review judged it as a consequential-action surface. Two findings, both
 * pinned here:
 *
 *  1. the confirm never said HOW MANY listings become public — agreement to an
 *     unread list, the same gap ADR 0541 P4 fixed on the grant;
 *  2. "make them private again at any time" overstated reversibility: it does
 *     not un-read what was copied while they were public.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const listings = [
  { listingId: 'a', title: 'Staff Backend Engineer', companyName: 'Northwind', location: 'Austin, TX', remote: false, sourceBoard: 'greenhouse', sourceUrl: null },
  { listingId: 'b', title: 'Platform Engineer', companyName: 'Harbor', location: null, remote: true, sourceBoard: 'lever', sourceUrl: null },
  { listingId: 'c', title: 'Principal Engineer', companyName: 'Meridian', location: 'Chicago, IL', remote: false, sourceBoard: 'ashby', sourceUrl: null },
];
const setVisibility = vi.fn(async () => undefined);

vi.mock('../jobSearchClient.js', () => ({
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listListings: vi.fn(async () => listings),
  getListingsVisibility: vi.fn(async () => ({ public: false })),
  setListingsVisibility: (...args: unknown[]) => setVisibility(...(args as [])),
}));

import { JobListingsPage } from '../JobListingsPage.js';

describe('the publish gate', () => {
  beforeEach(() => { setVisibility.mockClear(); render(<JobListingsPage />); });
  afterEach(cleanup);

  it('shows the CURRENT state before offering the control that changes it', async () => {
    expect(await screen.findByText(/private to this workspace/i)).toBeTruthy();
  });

  it('does not publish on a single click — the consequential direction confirms', async () => {
    fireEvent.click(await screen.findByRole('button', { name: /publish listings/i }));
    expect(setVisibility, 'publishing must not happen before the confirm').not.toHaveBeenCalled();
    expect(screen.getByText(/publish this workspace/i)).toBeTruthy();
  });

  it('states HOW MANY listings become public — a decision, not agreement to an unread list', async () => {
    fireEvent.click(await screen.findByRole('button', { name: /publish listings/i }));
    // The count is the finding: "publish listings" hides the size of what is
    // being exposed; "all 3 listings" is checkable against the table above it.
    expect(screen.getByText(/all 3 listings/i)).toBeTruthy();
  });

  it('names WHAT becomes public and what does not', async () => {
    fireEvent.click(await screen.findByRole('button', { name: /publish listings/i }));
    const body = screen.getByText(/role, company, location/i);
    expect(body.textContent).toMatch(/no applications, notes or personal details/i);
  });

  it('is HONEST about reversibility — un-publishing does not un-read', async () => {
    fireEvent.click(await screen.findByRole('button', { name: /publish listings/i }));
    expect(screen.getByText(/not un-read anything already copied/i)).toBeTruthy();
  });

  it('publishes only after the confirm is accepted', async () => {
    fireEvent.click(await screen.findByRole('button', { name: /publish listings/i }));
    fireEvent.click(screen.getByRole('button', { name: /^publish$/i }));
    await waitFor(() => expect(setVisibility).toHaveBeenCalledWith('org-1', true));
  });

  it('cancelling leaves the workspace private', async () => {
    fireEvent.click(await screen.findByRole('button', { name: /publish listings/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(setVisibility).not.toHaveBeenCalled();
    expect(screen.getByText(/private to this workspace/i)).toBeTruthy();
  });
});
