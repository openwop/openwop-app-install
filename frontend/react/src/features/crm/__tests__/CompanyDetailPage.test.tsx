/**
 * CRMGAP-FE-9: CompanyDetailPage had no test at all. Mirrors
 * DealDetailPage.test.tsx's precedent — the org-context guard (?org= missing
 * → designed StateCard, no fetch) and the happy path (company loads, its
 * deals table + the activity timeline mount with the right fetch args) —
 * plus a save-failure path (rejected updateCompany → error toast, the form
 * stays editable with the typed value, no crash).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const access = vi.hoisted(() => ({ value: { enabled: true, loading: false, variant: undefined as string | undefined } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => access.value,
}));
const getCompany = vi.hoisted(() => vi.fn(async () => ({
  companyId: 'c1', name: 'Globex', domain: 'globex.test', tags: ['enterprise'],
})));
const listDeals = vi.hoisted(() => vi.fn(async () => [
  { dealId: 'd1', title: 'Globex expansion', pipelineId: 'p1', stageId: 's1', amount: 5000, status: 'open' as const },
]));
const listActivities = vi.hoisted(() => vi.fn(async () => [
  { activityId: 'a1', kind: 'note' as const, body: 'Kickoff call scheduled', createdBy: 'u1', createdAt: '2026-07-01T10:00:00.000Z' },
]));
const updateCompany = vi.hoisted(() => vi.fn(async () => ({ companyId: 'c1', name: 'Globex', tags: [] })));
vi.mock('../crmOrgClient.js', () => ({
  ACTIVITY_KINDS: ['note', 'call', 'email', 'meeting'],
  getCompany,
  listDeals,
  updateCompany,
  listActivities,
  createActivity: vi.fn(),
}));

import { CompanyDetailPage } from '../CompanyDetailPage.js';

const renderAt = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/crm/companies/:companyId" element={<CompanyDetailPage />} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  getCompany.mockClear(); listDeals.mockClear(); listActivities.mockClear();
  updateCompany.mockReset();
  updateCompany.mockResolvedValue({ companyId: 'c1', name: 'Globex', tags: [] });
});
afterEach(cleanup);

describe('CompanyDetailPage', () => {
  it('guards a link without org context (designed state, no fetch)', () => {
    renderAt('/crm/companies/c1');
    expect(screen.getByText(/no organization in the link/i)).toBeTruthy();
    expect(getCompany).not.toHaveBeenCalled();
  });

  it('loads the company and renders its deals table + the activity timeline', async () => {
    renderAt('/crm/companies/c1?org=o1');
    await waitFor(() => expect(screen.getAllByText('Globex').length).toBeGreaterThan(0));
    expect(getCompany).toHaveBeenCalledWith('o1', 'c1');
    expect(listDeals).toHaveBeenCalledWith('o1', { companyId: 'c1' });
    await waitFor(() => expect(screen.getByText('Globex expansion')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Kickoff call scheduled')).toBeTruthy());
    expect(listActivities).toHaveBeenCalledWith('o1', { companyId: 'c1' });
  });

  it('a rejected save shows an error toast and keeps the form editable', async () => {
    updateCompany.mockRejectedValueOnce(new Error('boom'));
    const { toast } = await import('../../../ui/toast.js');
    const errSpy = vi.spyOn(toast, 'error');
    renderAt('/crm/companies/c1?org=o1');
    const nameInput = await screen.findByDisplayValue('Globex');
    fireEvent.change(nameInput, { target: { value: 'Globex Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    // The form stays editable with the typed value — no revert, no crash.
    expect((nameInput as HTMLInputElement).value).toBe('Globex Renamed');
  });
});
