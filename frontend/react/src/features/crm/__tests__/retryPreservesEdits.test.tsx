/**
 * CRM-UX-9 — a Retry must not discard the edit the user is in the middle of.
 *
 * `CompanyDetailPage`'s deals-panel Retry called the whole-page `load()`, which
 * re-fetches the COMPANY and re-hydrates `name`/`domain`/`size`/`revenue` from
 * the server. So retrying a failed *deals* read silently reverted an unsaved
 * company edit — the user's typing vanished on a button that promised only to
 * re-read a table beside it. `DealDetailPage` had already fixed exactly this
 * class for its stages Retry ("the stages Retry must re-fetch PIPELINES only",
 * its Review F9 note); this pins the same property for the company page.
 *
 * WHAT WOULD FALSIFY EACH TEST (the tests are only worth what they discriminate):
 *  - "preserves the edit": reverting `loadDeals` back into `load()` fails it —
 *    the input snaps back to the server's 'Acme Co'.
 *  - "re-reads the deals": a Retry wired to nothing at all would still pass the
 *    first test, so the second asserts the read actually re-issues.
 *  - "the page-level Retry DOES re-read the company": the split must not leave
 *    the failed-COMPANY card retrying nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const api = vi.hoisted(() => ({ getCompany: vi.fn(), listDeals: vi.fn(), listActivities: vi.fn() }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../crmOrgClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, getCompany: api.getCompany, listDeals: api.listDeals, listActivities: api.listActivities };
});

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: access.useFeatureAccess,
}));

import { CompanyDetailPage } from '../CompanyDetailPage.js';

const COMPANY = { companyId: 'c1', orgId: 'o1', name: 'Acme Co', tags: [] };

beforeEach(() => {
  vi.clearAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.getCompany.mockResolvedValue(COMPANY);
  api.listActivities.mockResolvedValue([]);
});
afterEach(cleanup);

function view(): void {
  render(
    <MemoryRouter initialEntries={['/crm/companies/c1?org=o1']}>
      <Routes><Route path="/crm/companies/:companyId" element={<CompanyDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe('CRM-UX-9 — the deals Retry does not reset the company form', () => {
  it('preserves an unsaved name edit across the deals-panel Retry', async () => {
    api.listDeals.mockRejectedValue(new Error('deals_500'));
    view();
    await screen.findByText(/deals couldn.t be loaded/i);

    const nameInput = await screen.findByDisplayValue('Acme Co') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Acme Corporation' } });
    expect(nameInput.value).toBe('Acme Corporation');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // Give the (re-rejecting) read a turn to land before asserting.
    await waitFor(() => expect(api.listDeals.mock.calls.length).toBeGreaterThan(1));
    expect(nameInput.value).toBe('Acme Corporation');
  });

  it('still re-issues the deals read (the Retry is not inert)', async () => {
    api.listDeals.mockRejectedValue(new Error('deals_500'));
    view();
    await screen.findByText(/deals couldn.t be loaded/i);
    const before = api.listDeals.mock.calls.length;
    const companyReadsBefore = api.getCompany.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.listDeals.mock.calls.length).toBeGreaterThan(before));
    // …and does NOT re-read the company, which is what used to clobber the form.
    expect(api.getCompany.mock.calls.length).toBe(companyReadsBefore);
  });

  it('HIGH-1 — the deals panel never claims "no deals" while the read is still in flight', async () => {
    // `deals` starts `null` and the empty slot only branched on `dealsFailed`,
    // so this record page asserted "No deals reference this company yet" — a
    // false SALES claim — on FIRST load, and again for the whole retry window
    // (the retry clears `dealsFailed` synchronously). Held here by a promise
    // the test settles.
    let land!: (v: unknown[]) => void;
    api.listDeals.mockReturnValueOnce(new Promise((res) => { land = res; }));
    view();
    await screen.findByDisplayValue('Acme Co');
    expect(screen.queryByText('No deals reference this company yet.')).toBeNull();
    land([]);
    // …and a SETTLED empty read really does say it (the discriminator).
    expect(await screen.findByText('No deals reference this company yet.')).toBeTruthy();
  });

  it('the page-level failed-read card retries the COMPANY (CRM-UX-4)', async () => {
    api.getCompany.mockRejectedValue(new Error('company_500'));
    api.listDeals.mockResolvedValue([]);
    view();
    // The canonical announced card on the shared `common:` copy — not the raw
    // server string the bare Notice used to render.
    expect(await screen.findByText('Could not load this')).toBeTruthy();
    expect(screen.queryByText('company_500')).toBeNull();

    const before = api.getCompany.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.getCompany.mock.calls.length).toBeGreaterThan(before));
  });
});
