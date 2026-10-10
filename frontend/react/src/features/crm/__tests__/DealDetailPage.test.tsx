/**
 * DealDetailPage — the record detail page (gap-analysis §5 B1, CRMGAP-FE-9) and
 * its task loop (ADR 0837 D8 / ADR 0567 D4, CRM2UX-1/2/6).
 *
 * Pinned: the org-context guard (?org= missing → designed StateCard, no fetch);
 * the happy path (deal loads, status chip + stage select, the ADR 0261 owner
 * picker resolving a name, the timeline listing activities); a rejected save
 * (localized toast, typed value kept, Save usable again); closing the last open
 * task offers the next one and focuses its title (D8); closing one of two moves
 * focus to the next task's control (CRM2UX-1); a viewer gets no task controls
 * (CRM2UX-2); a WON deal is never offered a next step (CRM2UX-6).
 *
 * Sabotage that turns it red (wave-4 /grade-tests probes): the render guard on
 * `orgId` removed; the save catch swallowed; `setOfferNext(true)` dropped;
 * `focusNext` not set; the `canWrite` gate removed; `closed` forced false.
 *
 * Order matters for CRM2UX-6: `setTaskStatus` used to survive between cases, so
 * its `waitFor(called)` passed on an EARLIER case's call and the "no offer"
 * check ran before the click had resolved. `resetAllMocks` + waiting for the
 * post-PATCH reload close that (wave-4 g4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
// Type-only (erased at runtime, so it does not race `vi.mock`).
import type * as OrgClient from '../crmOrgClient.js';
import type * as AccessClient from '../../../client/accessClient.js';
import type * as OrgMembers from '../../../orgs/orgMembers.js';
import type { Activity, Deal } from '../crmOrgClient.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import i18n from '../../../i18n/index.js';

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: access.useFeatureAccess,
}));
const DEAL: Deal = {
  dealId: 'd1', title: 'Globex expansion', pipelineId: 'p1', stageId: 's1',
  amount: 5000, currency: 'USD', status: 'open', closeDate: '2026-09-30', owner: 'user:alice',
};
const ACTIVITIES: Activity[] = [
  { activityId: 'a1', kind: 'note', body: 'Kickoff call scheduled', createdBy: 'u1', createdAt: '2026-07-01T10:00:00.000Z' },
];
const api = vi.hoisted(() => ({
  getDeal: vi.fn<typeof OrgClient.getDeal>(),
  listActivities: vi.fn<typeof OrgClient.listActivities>(),
  listTasks: vi.fn<typeof OrgClient.listTasks>(),
  setTaskStatus: vi.fn<typeof OrgClient.setTaskStatus>(),
  updateDeal: vi.fn<typeof OrgClient.updateDeal>(),
  getCompany: vi.fn<typeof OrgClient.getCompany>(),
  listPipelines: vi.fn<typeof OrgClient.listPipelines>(),
  listDeals: vi.fn<typeof OrgClient.listDeals>(),
  createActivity: vi.fn<typeof OrgClient.createActivity>(),
  updateCompany: vi.fn<typeof OrgClient.updateCompany>(),
  createTask: vi.fn<typeof OrgClient.createTask>(),
}));
// The owner field is the shared UserPicker (ADR 0261); stub its member
// loader so the picker resolves without a live members fetch.
const members = vi.hoisted(() => ({
  loadOrgMembers: vi.fn<typeof OrgMembers.loadOrgMembers>(),
  invalidateOrgMembers: vi.fn<typeof OrgMembers.invalidateOrgMembers>(),
}));
vi.mock('../../../orgs/orgMembers.js', () => members);
// CRM2UX-2 — the task controls show only to a writer.
const getEffectiveAccess = vi.hoisted(() => vi.fn<typeof AccessClient.getEffectiveAccess>());
vi.mock('../../../client/accessClient.js', () => ({ getEffectiveAccess }));
vi.mock('../crmOrgClient.js', () => ({
  DEAL_STATUSES: ['open', 'won', 'lost'],
  ACTIVITY_KINDS: ['note', 'call', 'email', 'meeting'],
  ...api,
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../../ui/toast.js', async (orig) => {
  const actual = await orig<{ toast: Record<string, unknown> }>();
  return { ...actual, toast: { ...actual.toast, error: toastError } };
});

import { DealDetailPage } from '../DealDetailPage.js';

const renderAt = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/crm/deals/:dealId" element={<DealDetailPage />} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.resetAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess());
  api.getDeal.mockResolvedValue(DEAL);
  api.listActivities.mockResolvedValue(ACTIVITIES);
  api.listTasks.mockResolvedValue([]);
  api.setTaskStatus.mockImplementation(async (_o, taskId, status) => ({ taskId, title: 'Call back', status }));
  api.updateDeal.mockResolvedValue(DEAL);
  api.getCompany.mockResolvedValue({ companyId: 'c1', name: 'Globex', tags: [] });
  api.listPipelines.mockResolvedValue([{ pipelineId: 'p1', name: 'Sales', stages: [{ stageId: 's1', name: 'New', probability: 10 }] }]);
  api.listDeals.mockResolvedValue([]);
  members.loadOrgMembers.mockResolvedValue([
    { memberId: 'm1', orgId: 'o1', tenantId: 't1', subject: 'user:alice', displayName: 'Alice Ng', email: 'alice@x.io', roles: [], teamIds: [], createdAt: '', updatedAt: '' },
  ]);
  getEffectiveAccess.mockResolvedValue({ roles: ['editor'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('DealDetailPage', () => {
  it('guards a link without org context (designed state, no fetch)', () => {
    renderAt('/crm/deals/d1');
    expect(screen.getByText(/no organization in the link/i)).toBeTruthy();
    expect(api.getDeal).not.toHaveBeenCalled();
  });

  it('loads the deal and renders status, stage, fields, and the timeline', async () => {
    renderAt('/crm/deals/d1?org=o1');
    await waitFor(() => expect(screen.getAllByText('Globex expansion').length).toBeGreaterThan(0));
    expect(api.getDeal).toHaveBeenCalledWith('o1', 'd1');
    expect(screen.getAllByText('Open').length).toBeGreaterThan(0); // status chip + select option
    await waitFor(() => expect(screen.getByText('Kickoff call scheduled')).toBeTruthy());
    expect(api.listActivities).toHaveBeenCalledWith('o1', { dealId: 'd1' });
    // Owner renders as a name-resolving picker (ADR 0261), not a raw-id input:
    // the stored subject `user:alice` shows the member's display name.
    const owner = await screen.findByRole('combobox', { name: 'Owner' });
    expect((owner as HTMLSelectElement).value).toBe('user:alice');
    expect(screen.getByText('Alice Ng · alice@x.io')).toBeTruthy();
  });

  it('a rejected save shows an error toast and keeps the form editable (CRMGAP-FE-9)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.updateDeal.mockRejectedValueOnce(new Error('boom'));
    renderAt('/crm/deals/d1?org=o1');
    const titleInput = await screen.findByDisplayValue('Globex expansion');
    fireEvent.change(titleInput, { target: { value: 'Globex expansion v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // The localized fallback (CRM-UX-14), never the transport's 'boom'.
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(i18n.t('crm:saveFailed')));
    expect(api.updateDeal).toHaveBeenCalledWith('o1', 'd1', expect.objectContaining({ title: 'Globex expansion v2' }));
    // The form stays editable with the typed value — no revert, no crash —
    // and Save is usable again.
    expect((titleInput as HTMLInputElement).value).toBe('Globex expansion v2');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('ADR 0837 D8 — closing the deal\'s last open task offers the next one inline and focuses the title', async () => {
    api.listTasks.mockResolvedValueOnce([{ taskId: 't1', title: 'Call back', status: 'open', dealId: 'd1' }]);
    renderAt('/crm/deals/d1?org=o1');
    const done = await screen.findByRole('button', { name: /Mark “Call back” done/ });
    fireEvent.click(done);
    await waitFor(() => expect(api.setTaskStatus).toHaveBeenCalledWith('o1', 't1', 'done'));
    expect(await screen.findByText(/No next activity on this deal\. Schedule one\?/)).toBeTruthy();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Next step for this deal…'); // the add-task title field
  });

  it('CRM2UX-1 — completing one of two open tasks moves focus to the next task\'s control', async () => {
    api.listTasks
      .mockResolvedValueOnce([
        { taskId: 't1', title: 'Call back', status: 'open', dealId: 'd1' },
        { taskId: 't2', title: 'Send quote', status: 'open', dealId: 'd1' },
      ])
      .mockResolvedValueOnce([ // the reload after the PATCH
        { taskId: 't1', title: 'Call back', status: 'done', dealId: 'd1' },
        { taskId: 't2', title: 'Send quote', status: 'open', dealId: 'd1' },
      ]);
    renderAt('/crm/deals/d1?org=o1');
    fireEvent.click(await screen.findByRole('button', { name: /Mark “Call back” done/ }));
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Mark “Send quote” done'));
    expect(screen.queryByText(/Schedule one\?/)).toBeNull();
  });

  it('CRM2UX-2 — a viewer is offered neither Mark done nor the add-task form', async () => {
    getEffectiveAccess.mockResolvedValueOnce({ roles: ['viewer'], scopes: ['workspace:read'], basis: 'member' });
    api.listTasks.mockResolvedValueOnce([{ taskId: 't1', title: 'Call back', status: 'open', dealId: 'd1' }]);
    renderAt('/crm/deals/d1?org=o1');
    expect(await screen.findByText('Call back')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Mark “Call back” done/ })).toBeNull();
    expect(screen.queryByLabelText('Next step for this deal…')).toBeNull();
  });

  it('CRM2UX-6 — closing the last task on a WON deal offers nothing', async () => {
    api.getDeal.mockResolvedValueOnce({ ...DEAL, status: 'won' });
    api.listTasks.mockResolvedValueOnce([{ taskId: 't1', title: 'Call back', status: 'open', dealId: 'd1' }]);
    renderAt('/crm/deals/d1?org=o1');
    fireEvent.click(await screen.findByRole('button', { name: /Mark “Call back” done/ }));
    await waitFor(() => expect(api.setTaskStatus).toHaveBeenCalledWith('o1', 't1', 'done'));
    // Wait for the click to finish: `markDone` reloads the tasks after the
    // PATCH (2nd listTasks read), then let that read land.
    await waitFor(() => expect(api.listTasks).toHaveBeenCalledTimes(2));
    await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); });
    expect(screen.queryByText(/Schedule one\?/)).toBeNull();
    expect(screen.queryByLabelText('Next step for this deal…')).not.toBe(document.activeElement);
  });
});
