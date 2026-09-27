/**
 * Smoke coverage for the Phase-B record detail pages (gap-analysis §5 B1):
 * the org-context guard (?org= missing → designed StateCard, no fetch) and
 * the happy path (deal loads, status chip + stage select render, timeline
 * mounts and lists activities).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const access = vi.hoisted(() => ({ value: { enabled: true, loading: false, variant: undefined as string | undefined } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => access.value,
}));
const getDeal = vi.hoisted(() => vi.fn(async () => ({
  dealId: 'd1', title: 'Globex expansion', pipelineId: 'p1', stageId: 's1',
  amount: 5000, currency: 'USD', status: 'open' as const, closeDate: '2026-09-30', owner: 'user:alice',
})));
const listActivities = vi.hoisted(() => vi.fn(async () => [
  { activityId: 'a1', kind: 'note' as const, body: 'Kickoff call scheduled', createdBy: 'u1', createdAt: '2026-07-01T10:00:00.000Z' },
]));
const updateDeal = vi.hoisted(() => vi.fn(async () => ({
  dealId: 'd1', title: 'Globex expansion', pipelineId: 'p1', stageId: 's1',
  amount: 5000, currency: 'USD', status: 'open' as const, closeDate: '2026-09-30', owner: 'user:alice',
})));
// The owner field is now the shared UserPicker (ADR 0261); stub its member
// loader so the picker resolves without a live members fetch.
vi.mock('../../../orgs/orgMembers.js', () => ({
  loadOrgMembers: vi.fn(async () => [
    { memberId: 'm1', orgId: 'o1', tenantId: 't1', subject: 'user:alice', displayName: 'Alice Ng', email: 'alice@x.io', roles: [], teamIds: [], createdAt: '', updatedAt: '' },
  ]),
  invalidateOrgMembers: vi.fn(),
}));
vi.mock('../crmOrgClient.js', () => ({
  DEAL_STATUSES: ['open', 'won', 'lost'],
  ACTIVITY_KINDS: ['note', 'call', 'email', 'meeting'],
  getDeal,
  getCompany: vi.fn(async () => ({ companyId: 'c1', name: 'Globex', tags: [] })),
  listPipelines: vi.fn(async () => [{ pipelineId: 'p1', name: 'Sales', stages: [{ stageId: 's1', name: 'New', probability: 10 }] }]),
  updateDeal,
  listActivities,
  createActivity: vi.fn(),
  listDeals: vi.fn(async () => []),
  updateCompany: vi.fn(),
  listTasks: vi.fn(async () => []),
  createTask: vi.fn(),
}));

import { DealDetailPage } from '../DealDetailPage.js';

const renderAt = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/crm/deals/:dealId" element={<DealDetailPage />} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  getDeal.mockClear(); listActivities.mockClear();
  updateDeal.mockReset();
  updateDeal.mockResolvedValue({
    dealId: 'd1', title: 'Globex expansion', pipelineId: 'p1', stageId: 's1',
    amount: 5000, currency: 'USD', status: 'open' as const, closeDate: '2026-09-30', owner: 'user:alice',
  });
});
afterEach(cleanup);

describe('DealDetailPage', () => {
  it('guards a link without org context (designed state, no fetch)', () => {
    renderAt('/crm/deals/d1');
    expect(screen.getByText(/no organization in the link/i)).toBeTruthy();
    expect(getDeal).not.toHaveBeenCalled();
  });

  it('loads the deal and renders status, stage, fields, and the timeline', async () => {
    renderAt('/crm/deals/d1?org=o1');
    await waitFor(() => expect(screen.getAllByText('Globex expansion').length).toBeGreaterThan(0));
    expect(getDeal).toHaveBeenCalledWith('o1', 'd1');
    expect(screen.getAllByText('Open').length).toBeGreaterThan(0); // status chip + select option
    await waitFor(() => expect(screen.getByText('Kickoff call scheduled')).toBeTruthy());
    expect(listActivities).toHaveBeenCalledWith('o1', { dealId: 'd1' });
    // Owner renders as a name-resolving picker (ADR 0261), not a raw-id input:
    // the stored subject `user:alice` shows the member's display name.
    const owner = await screen.findByRole('combobox', { name: 'Owner' });
    expect((owner as HTMLSelectElement).value).toBe('user:alice');
    expect(screen.getByText('Alice Ng · alice@x.io')).toBeTruthy();
  });

  it('a rejected save shows an error toast and keeps the form editable (CRMGAP-FE-9)', async () => {
    updateDeal.mockRejectedValueOnce(new Error('boom'));
    const { toast } = await import('../../../ui/toast.js');
    const errSpy = vi.spyOn(toast, 'error');
    renderAt('/crm/deals/d1?org=o1');
    const titleInput = await screen.findByDisplayValue('Globex expansion');
    fireEvent.change(titleInput, { target: { value: 'Globex expansion v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    // The form stays editable with the typed value — no revert, no crash.
    expect((titleInput as HTMLInputElement).value).toBe('Globex expansion v2');
  });
});
