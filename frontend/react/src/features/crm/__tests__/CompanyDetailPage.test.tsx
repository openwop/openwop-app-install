/**
 * CRMGAP-FE-9: CompanyDetailPage had no test at all. Mirrors
 * DealDetailPage.test.tsx's precedent — the org-context guard (?org= missing
 * → designed StateCard, no fetch) and the happy path (company loads, its
 * deals table + the activity timeline mount with the right fetch args) —
 * plus a save-failure path (rejected updateCompany → error toast, the form
 * stays editable with the typed value, no crash).
 *
 * Sabotage that turns it red (wave-4 /grade-tests probes): the `?org=` render
 * guard or fetch guard removed; the deals read losing its companyId filter;
 * the save catch swallowing the toast; the save `finally` that clears `busy`
 * dropped (Save stays disabled).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
// Type-only (erased at runtime, so it does not race `vi.mock`): the hoisted
// mocks are typed against the REAL client, so a drifting fixture is a type error.
import type * as OrgClient from '../crmOrgClient.js';
import type { Activity, Company, Deal } from '../crmOrgClient.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import i18n from '../../../i18n/index.js';

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: access.useFeatureAccess,
}));
const COMPANY: Company = { companyId: 'c1', name: 'Globex', domain: 'globex.test', tags: ['enterprise'] };
const DEALS: Deal[] = [{ dealId: 'd1', title: 'Globex expansion', pipelineId: 'p1', stageId: 's1', amount: 5000, status: 'open' }];
const ACTIVITIES: Activity[] = [{ activityId: 'a1', kind: 'note', body: 'Kickoff call scheduled', createdBy: 'u1', createdAt: '2026-07-01T10:00:00.000Z' }];
const api = vi.hoisted(() => ({
  getCompany: vi.fn<typeof OrgClient.getCompany>(),
  listDeals: vi.fn<typeof OrgClient.listDeals>(),
  listActivities: vi.fn<typeof OrgClient.listActivities>(),
  updateCompany: vi.fn<typeof OrgClient.updateCompany>(),
  createActivity: vi.fn<typeof OrgClient.createActivity>(),
}));
vi.mock('../crmOrgClient.js', () => ({
  ACTIVITY_KINDS: ['note', 'call', 'email', 'meeting'],
  ...api,
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../../ui/toast.js', async (orig) => {
  const actual = await orig<{ toast: Record<string, unknown> }>();
  return { ...actual, toast: { ...actual.toast, error: toastError } };
});

import { CompanyDetailPage } from '../CompanyDetailPage.js';

const renderAt = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/crm/companies/:companyId" element={<CompanyDetailPage />} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.resetAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess());
  api.getCompany.mockResolvedValue(COMPANY);
  api.listDeals.mockResolvedValue(DEALS);
  api.listActivities.mockResolvedValue(ACTIVITIES);
  api.updateCompany.mockResolvedValue({ ...COMPANY, tags: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('CompanyDetailPage', () => {
  it('guards a link without org context (designed state, no fetch)', () => {
    renderAt('/crm/companies/c1');
    expect(screen.getByText(/no organization in the link/i)).toBeTruthy();
    expect(api.getCompany).not.toHaveBeenCalled();
  });

  it('loads the company and renders its deals table + the activity timeline', async () => {
    renderAt('/crm/companies/c1?org=o1');
    await waitFor(() => expect(screen.getAllByText('Globex').length).toBeGreaterThan(0));
    expect(api.getCompany).toHaveBeenCalledWith('o1', 'c1');
    expect(api.listDeals).toHaveBeenCalledWith('o1', { companyId: 'c1' });
    await waitFor(() => expect(screen.getByText('Globex expansion')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Kickoff call scheduled')).toBeTruthy());
    expect(api.listActivities).toHaveBeenCalledWith('o1', { companyId: 'c1' });
  });

  it('a rejected save shows an error toast and keeps the form editable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.updateCompany.mockRejectedValueOnce(new Error('boom'));
    renderAt('/crm/companies/c1?org=o1');
    const nameInput = await screen.findByDisplayValue('Globex');
    fireEvent.change(nameInput, { target: { value: 'Globex Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // The localized fallback (CRM-UX-14), never the transport's 'boom'.
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(i18n.t('crm:saveFailed')));
    expect(api.updateCompany).toHaveBeenCalledWith('o1', 'c1', expect.objectContaining({ name: 'Globex Renamed' }));
    // The form stays editable with the typed value — no revert, no crash —
    // and Save is usable again (the `finally` that clears `busy` ran).
    expect((nameInput as HTMLInputElement).value).toBe('Globex Renamed');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false));
  });
});
