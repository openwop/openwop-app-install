/**
 * CRM-UX-16 + CRM-UX-17 — what happens AROUND a delete.
 *
 * -16: a row delete unmounts the very button that had focus, so the browser
 * dropped focus to <body> and a keyboard / screen-reader user was left with
 * no position. A record delete navigated to the collection with only a toast.
 * Now: a row delete lands focus — AFTER the reload has committed — on the
 * first of: the filterbar search (mounted only above 3 rows), the table
 * caption (gone with the last row), then a target that exists in every state
 * (the filterbar group in the contacts grid view, the create form's first
 * input, the fields page's title). A record delete navigates with
 * `state.focusTitle`, and the landing page (`CrmPage`, tested in
 * CrmPage.test.tsx) focuses its title.
 *
 * -17: every delete confirm carries a consequence clause written from what the
 * backend actually does — related rows are KEPT and unlinked (the ADR 0580
 * `*-crm-unlink` seam consumers), never cascaded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import i18n from '../../../i18n/index.js';

const confirmSpy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmSpy }));

const org = vi.hoisted(() => ({
  listDeals: vi.fn(),
  listTasks: vi.fn(),
  deleteTask: vi.fn(),
  getCompany: vi.fn(),
  deleteCompany: vi.fn(),
  updateCompany: vi.fn(),
  getDeal: vi.fn(),
  deleteDeal: vi.fn(),
  updateDeal: vi.fn(),
  listPipelines: vi.fn(async () => []),
  listActivities: vi.fn(async () => []),
}));
vi.mock('../crmOrgClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...org };
});
const crm = vi.hoisted(() => ({
  listContacts: vi.fn(),
  deleteContact: vi.fn(),
  listSegments: vi.fn(),
  deleteSegment: vi.fn(),
  listSegmentMembers: vi.fn(async () => []),
  listContactFields: vi.fn(),
  deleteContactField: vi.fn(),
}));
vi.mock('../crmClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...crm };
});
vi.mock('../../../featureToggles/FeatureAccessContext.js', async () => {
  const { makeFeatureAccess } = await import('../../../featureToggles/__testing__/makeFeatureAccess.js');
  return {
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
  };
});
vi.mock('../../../orgs/orgMembers.js', () => ({
  loadOrgMembers: vi.fn(async () => []),
  invalidateOrgMembers: vi.fn(),
}));

import { ContactsTab } from '../ContactsTab.js';
import { TasksTab } from '../TasksTab.js';
import { ContactFieldsPage } from '../ContactFieldsPage.js';
import { CompanyDetailPage } from '../CompanyDetailPage.js';
import { DealDetailPage } from '../DealDetailPage.js';

const contact = (id: string, name: string) => ({ contactId: id, name, stage: 'lead' as const });
const task = (id: string, title: string) => ({ taskId: id, title, status: 'open' as const });

/** Renders where a record page's delete navigates to, exposing the router state. */
function LandingProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="landing">{loc.pathname}{loc.search}|{JSON.stringify(loc.state)}</div>;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  confirmSpy.mockResolvedValue(true);
  crm.listSegments.mockResolvedValue([]);
  crm.listContactFields.mockResolvedValue([]);
  crm.deleteContact.mockResolvedValue(undefined);
  crm.deleteSegment.mockResolvedValue(undefined);
  crm.deleteContactField.mockResolvedValue(undefined);
  org.listDeals.mockResolvedValue([]);
  // Defaults for the reads a page makes that a test does not itself script
  // (the deal page's tasks section). The row-delete tests layer their own
  // `mockResolvedValueOnce` pairs on top; those take precedence.
  org.listTasks.mockResolvedValue([]);
  crm.listContacts.mockResolvedValue([]);
  org.deleteTask.mockResolvedValue(true);
  org.deleteCompany.mockResolvedValue(true);
  org.deleteDeal.mockResolvedValue(true);
});
afterEach(cleanup);

describe('contacts — row delete (CRM-UX-16 / -17)', () => {
  // Every fixture answers the mount read with the row PRESENT and the
  // post-delete read with it GONE (`mockResolvedValueOnce` ×2). A single
  // `mockResolvedValue` returned the same list twice, so the deleted row was
  // still rendered and a focus target the delete had unmounted looked intact.
  const c = { c1: contact('c1', 'Ada Devine'), c2: contact('c2', 'Bob'), c3: contact('c3', 'Cy'), c4: contact('c4', 'Di'), c5: contact('c5', 'Ed') };

  it('≤3 contacts (no search mounted): focus lands on the table CAPTION; the confirm names the consequence', async () => {
    crm.listContacts.mockResolvedValueOnce([c.c1, c.c2]).mockResolvedValueOnce([c.c2]);
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Ada Devine' }));
    await waitFor(() => expect(crm.deleteContact).toHaveBeenCalledWith('c1'));
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Delete "Ada Devine"?',
      body: i18n.t('crm:deleteContactBody'),
      danger: true,
    }));
    expect(i18n.t('crm:deleteContactBody')).toMatch(/kept and unlinked/);
    await waitFor(() => expect(screen.queryByText('Ada Devine')).toBeNull());
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.tagName).toBe('CAPTION');
      expect(active?.textContent).toBe('Contacts');
    });
  });

  it('5 → 4 contacts: the search stays mounted, so focus lands on the filterbar SEARCH', async () => {
    crm.listContacts.mockResolvedValueOnce([c.c1, c.c2, c.c3, c.c4, c.c5]).mockResolvedValueOnce([c.c2, c.c3, c.c4, c.c5]);
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Ada Devine' }));
    await waitFor(() => expect(crm.deleteContact).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Ada Devine')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('searchbox')));
  });

  it('4 → 3 contacts: the delete UNMOUNTS the search (gated on >3), so focus lands on the CAPTION, not <body>', async () => {
    crm.listContacts.mockResolvedValueOnce([c.c1, c.c2, c.c3, c.c4]).mockResolvedValueOnce([c.c2, c.c3, c.c4]);
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    await screen.findByRole('searchbox');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Ada Devine' }));
    await waitFor(() => expect(crm.deleteContact).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('searchbox')).toBeNull());
    await waitFor(() => expect((document.activeElement as HTMLElement)?.tagName).toBe('CAPTION'));
  });

  it('1 → 0 (the last row): the table swaps for the empty card and the caption goes — focus lands on the create form\'s NAME input', async () => {
    crm.listContacts.mockResolvedValueOnce([c.c1]).mockResolvedValueOnce([]);
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Ada Devine' }));
    await waitFor(() => expect(crm.deleteContact).toHaveBeenCalled());
    await screen.findByText('No contacts yet');
    expect(document.querySelector('caption')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/^name$/i)));
  });

  it('GRID view, ≤3 contacts: no caption and no search exist — focus lands on the filterbar GROUP', async () => {
    window.localStorage.setItem('openwop:view:crm-contacts', 'grid');
    crm.listContacts.mockResolvedValueOnce([c.c1, c.c2]).mockResolvedValueOnce([c.c2]);
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Ada Devine' }));
    await waitFor(() => expect(crm.deleteContact).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Ada Devine')).toBeNull());
    expect(document.querySelector('caption')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Filters' })));
  });

  it('segment delete: the confirm says no contact goes with it; focus lands on the segment picker', async () => {
    crm.listContacts.mockResolvedValue([c.c1]);
    crm.listSegments.mockResolvedValue([{ segmentId: 'sg1', name: 'VIPs', filters: [] }]);
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    const picker = await screen.findByLabelText('Segment');
    await screen.findByRole('option', { name: 'VIPs' });
    fireEvent.change(picker, { target: { value: 'sg1' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete segment' }));
    await waitFor(() => expect(crm.deleteSegment).toHaveBeenCalledWith('sg1'));
    expect(confirmSpy).toHaveBeenLastCalledWith(expect.objectContaining({ body: i18n.t('crm:deleteSegmentBody') }));
    expect(i18n.t('crm:deleteSegmentBody')).toMatch(/no contact is deleted/i);
    await waitFor(() => expect(document.activeElement).toBe(picker));
  });
});

describe('tasks — row delete (CRM-UX-16 / -17)', () => {
  const tk = { t1: task('t1', 'Call Ada'), t2: task('t2', 'Email Bob'), t3: task('t3', 'Ping Cy'), t4: task('t4', 'Meet Di'), t5: task('t5', 'Call Ed') };

  it('2 → 1: focus lands on the caption; the confirm says only the task goes', async () => {
    org.listTasks.mockResolvedValueOnce([tk.t1, tk.t2]).mockResolvedValueOnce([tk.t2]);
    render(<MemoryRouter><TasksTab orgId="org:1" /></MemoryRouter>);
    await screen.findByText('Call Ada');
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    await waitFor(() => expect(org.deleteTask).toHaveBeenCalledWith('org:1', 't1'));
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({ body: i18n.t('crm:deleteTaskBody') }));
    expect(i18n.t('crm:deleteTaskBody')).toMatch(/only this task/i);
    await waitFor(() => expect(screen.queryByText('Call Ada')).toBeNull());
    await waitFor(() => expect((document.activeElement as HTMLElement)?.tagName).toBe('CAPTION'));
  });

  it('5 → 4: the search stays mounted, so focus lands on the SEARCH', async () => {
    org.listTasks.mockResolvedValueOnce([tk.t1, tk.t2, tk.t3, tk.t4, tk.t5]).mockResolvedValueOnce([tk.t2, tk.t3, tk.t4, tk.t5]);
    render(<MemoryRouter><TasksTab orgId="org:1" /></MemoryRouter>);
    await screen.findByText('Call Ada');
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    await waitFor(() => expect(org.deleteTask).toHaveBeenCalledWith('org:1', 't1'));
    await waitFor(() => expect(screen.queryByText('Call Ada')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('searchbox')));
  });

  it('1 → 0 (the last row): the caption goes with the table — focus lands on the create form\'s TITLE input', async () => {
    org.listTasks.mockResolvedValueOnce([tk.t1]).mockResolvedValueOnce([]);
    render(<MemoryRouter><TasksTab orgId="org:1" /></MemoryRouter>);
    await screen.findByText('Call Ada');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(org.deleteTask).toHaveBeenCalledWith('org:1', 't1'));
    await screen.findByText('No tasks yet');
    expect(document.querySelector('caption')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Title')));
  });
});

describe('contact fields — row delete (CRM-UX-16)', () => {
  const def = (defId: string, key: string, label: string) => ({ defId, key, label, type: 'string' as const, required: false, createdAt: '2026-01-01T00:00:00Z' });

  it('2 → 1: focus lands on the caption after the definition is deleted', async () => {
    crm.listContactFields.mockResolvedValueOnce([def('f1', 'tier', 'Tier'), def('f2', 'region', 'Region')]).mockResolvedValueOnce([def('f2', 'region', 'Region')]);
    render(<MemoryRouter><ContactFieldsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete the Tier field' }));
    await waitFor(() => expect(crm.deleteContactField).toHaveBeenCalledWith('f1'));
    await waitFor(() => expect(screen.queryByText('Tier')).toBeNull());
    await waitFor(() => expect((document.activeElement as HTMLElement)?.tagName).toBe('CAPTION'));
  });

  it('1 → 0 (the last definition): the caption goes with the table — focus lands on the page TITLE', async () => {
    crm.listContactFields.mockResolvedValueOnce([def('f1', 'tier', 'Tier')]).mockResolvedValueOnce([]);
    render(<MemoryRouter><ContactFieldsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete the Tier field' }));
    await waitFor(() => expect(crm.deleteContactField).toHaveBeenCalledWith('f1'));
    await screen.findByText(i18n.t('crm:contactFieldsEmptyTitle'));
    expect(document.querySelector('caption')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Contact fields' })));
  });
});

describe('record pages — delete navigates with focusTitle and names the consequence (CRM-UX-16 / -17)', () => {
  it('company: confirm body says deals/tasks/activities are KEPT and unlinked; navigation carries state.focusTitle', async () => {
    org.getCompany.mockResolvedValue({ companyId: 'c1', name: 'Globex', tags: [] });
    render(
      <MemoryRouter initialEntries={['/crm/companies/c1?org=o1']}>
        <Routes>
          <Route path="/crm/companies/:companyId" element={<CompanyDetailPage />} />
          <Route path="/crm" element={<LandingProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(org.deleteCompany).toHaveBeenCalledWith('o1', 'c1'));
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({ body: i18n.t('crm:deleteCompanyBody') }));
    expect(i18n.t('crm:deleteCompanyBody')).toMatch(/deals, tasks and activities are kept and unlinked/);
    expect(i18n.t('crm:deleteCompanyBody')).not.toMatch(/deleted/);
    const landing = await screen.findByTestId('landing');
    expect(landing.textContent).toBe('/crm?tab=companies|{"focusTitle":true}');
  });

  it('deal: confirm body says tasks/activities are KEPT and unlinked; navigation carries state.focusTitle', async () => {
    org.getDeal.mockResolvedValue({ dealId: 'd1', title: 'Globex expansion', pipelineId: 'p1', stageId: 's1', status: 'open' });
    render(
      <MemoryRouter initialEntries={['/crm/deals/d1?org=o1']}>
        <Routes>
          <Route path="/crm/deals/:dealId" element={<DealDetailPage />} />
          <Route path="/crm" element={<LandingProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(org.deleteDeal).toHaveBeenCalledWith('o1', 'd1'));
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({ body: i18n.t('crm:deleteDealBody') }));
    expect(i18n.t('crm:deleteDealBody')).toMatch(/tasks and activities are kept and unlinked/);
    const landing = await screen.findByTestId('landing');
    expect(landing.textContent).toBe('/crm?tab=deals|{"focusTitle":true}');
  });
});
