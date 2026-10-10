/**
 * ADR 0837 CRM2UX-3 / N1 — after Triage, the Last-triage column follows the run it
 * started: "Scoring…" while it runs, the recorded result once it completes, and
 * "Triage failed" when it does not — without the user reloading the page. One
 * stable poller: a run already being read is not read twice.
 *
 * Sabotage-witnessed (wave-4 /grade-tests, w4g5-tr-*): the poller not
 * re-reading the list once a run settles, a `failed` run not marked failed,
 * and the poller re-issuing a status read that is still in flight each turn a
 * case red. (The in-flight half had no case before wave 4.)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Contact } from '../crmClient.js';

type CrmApi = typeof import('../crmClient.js');
const listContacts = vi.fn<CrmApi['listContacts']>();
const triageContact = vi.fn<CrmApi['triageContact']>();
const getCrmRunStatus = vi.fn<CrmApi['getCrmRunStatus']>();
vi.mock('../crmClient.js', async (importOriginal) => ({
  ...(await importOriginal<CrmApi>()),
  listContacts: (...a: Parameters<CrmApi['listContacts']>) => listContacts(...a),
  triageContact: (...a: Parameters<CrmApi['triageContact']>) => triageContact(...a),
  getCrmRunStatus: (...a: Parameters<CrmApi['getCrmRunStatus']>) => getCrmRunStatus(...a),
  listSegments: vi.fn<CrmApi['listSegments']>(async () => []),
  listContactFields: vi.fn<CrmApi['listContactFields']>(async () => []),
}));

const { ContactsTab } = await import('../ContactsTab.js');
const contact = (over: { lastTriage?: NonNullable<Contact['lastTriage']> } = {}): Contact => ({
  contactId: 'c1', tenantId: 't1', name: 'Ada', stage: 'qualified',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
});
const stamped = (extra: Partial<NonNullable<Contact['lastTriage']>> = {}): Contact =>
  contact({ lastTriage: { variant: 'enriched', runId: 'run-1', at: new Date().toISOString(), ...extra } });

beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe('Triage follow-up', () => {
  it('shows Scoring…, then the recorded result, with no manual reload', async () => {
    listContacts.mockResolvedValueOnce([contact()]).mockResolvedValueOnce([stamped()]).mockResolvedValue([stamped({ score: 55, priority: 'normal' })]);
    triageContact.mockResolvedValue({ runId: 'run-1', variant: 'A', bindings: null, workflowId: 'crm-ops.triage' });
    getCrmRunStatus.mockResolvedValueOnce({ runId: 'run-1', status: 'running' }).mockResolvedValue({ runId: 'run-1', status: 'completed' });
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Triage' }))[0]!);
    expect(await screen.findByText('Scoring…')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await waitFor(() => expect(screen.getByText('Normal priority · score 55')).toBeTruthy());
  });

  it('a run that does not complete reads "Triage failed"', async () => {
    listContacts.mockResolvedValueOnce([contact()]).mockResolvedValue([stamped()]);
    triageContact.mockResolvedValue({ runId: 'run-1', variant: 'A', bindings: null, workflowId: 'crm-ops.triage' });
    getCrmRunStatus.mockResolvedValue({ runId: 'run-1', status: 'failed' });
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Triage' }))[0]!);
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await waitFor(() => expect(screen.getAllByText('Triage failed').length).toBeGreaterThan(0), { timeout: 3000 });
    // settled ⇒ the poller stops: two more ticks' worth of time, still one read.
    await act(async () => { await vi.advanceTimersByTimeAsync(4200); });
    expect(getCrmRunStatus).toHaveBeenCalledTimes(1);
  });

  it('a status read still in flight is not issued again on the next tick', async () => {
    listContacts.mockResolvedValueOnce([contact()]).mockResolvedValue([stamped()]);
    triageContact.mockResolvedValue({ runId: 'run-1', variant: 'A', bindings: null, workflowId: 'crm-ops.triage' });
    getCrmRunStatus.mockReturnValue(new Promise(() => {})); // never answers
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Triage' }))[0]!);
    expect(await screen.findByText('Scoring…')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(getCrmRunStatus).toHaveBeenCalledTimes(1);
  });
});
