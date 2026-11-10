/**
 * ADR 1054 — the page names the two new server outcomes in its own copy.
 *
 *  - D1: adding a Zoom webinar another organization of the workspace already tracks is a 409
 *    `event_in_other_org`; the webinar-id FIELD says so in the page's words (not the server's
 *    English, not only a toast).
 *  - D3: every queued reason has words (`zoom_no_registrant_id`, `zoom_429`), and a drain that
 *    found the queue empty is not "nothing was pushed: ".
 *  - Sync: a PARTIAL sync is reported as partial even with zero attendees (it used to read as
 *    "report still empty"); an upcoming webinar's sync reports the registrations it brought in.
 *
 * Sabotage-witnessed: see the ADR 1054 implementation record (one red per branch). Re-measured in
 * /grade-tests wave 98: each page branch below reds its case alone. The not-found leg used to assert
 * only the toast, so dropping the list's own re-read stayed green; it now asserts the refreshed list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WebinarsApiError, type MarketingEvent, type OrgRef, type PushResult, type SyncResult, type PendingRegistrant } from '../webinarsClient.js';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import { toast } from '../../../ui/toast.js';

const listWebinarEvents = vi.fn<(orgId: string) => Promise<MarketingEvent[]>>();
const createWebinarEvent = vi.fn<(orgId: string, input: { providerEventId: string; title?: string }) => Promise<MarketingEvent>>();
const pushWebinarRegistrants = vi.fn<(orgId: string, eventId: string) => Promise<PushResult>>();
const syncWebinarEvent = vi.fn<(orgId: string, eventId: string) => Promise<SyncResult>>();

const listOrgs = vi.fn<() => Promise<OrgRef[]>>();
const listPendingRegistrants = vi.fn<(orgId: string, eventId: string) => Promise<{ total: number; items: PendingRegistrant[] }>>();
const removePendingRegistrant = vi.fn<(orgId: string, eventId: string, pendingId: string) => Promise<void>>();
vi.mock('../webinarsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: () => listOrgs(),
  listPendingRegistrants: (orgId: string, eventId: string) => listPendingRegistrants(orgId, eventId),
  removePendingRegistrant: (orgId: string, eventId: string, pendingId: string) => removePendingRegistrant(orgId, eventId, pendingId),
  listWebinarEvents: (orgId: string) => listWebinarEvents(orgId),
  createWebinarEvent: (orgId: string, input: { providerEventId: string; title?: string }) => createWebinarEvent(orgId, input),
  pushWebinarRegistrants: (orgId: string, eventId: string) => pushWebinarRegistrants(orgId, eventId),
  syncWebinarEvent: (orgId: string, eventId: string) => syncWebinarEvent(orgId, eventId),
}));
vi.mock('../../forms/formsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), listForms: vi.fn(async () => []) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const confirmMock = vi.hoisted(() => vi.fn<(o: { title: string }) => Promise<boolean>>());
vi.mock('../../../ui/confirm.js', () => ({ confirm: (o: { title: string }) => confirmMock(o) }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => makeFeatureAccess() }));

import { WebinarsPage } from '../WebinarsPage.js';

const event = (over: Partial<MarketingEvent> = {}): MarketingEvent => ({
  eventId: 'ev-1', provider: 'zoom', providerEventId: 'z-1', title: 'Launch webinar',
  createdAt: '2026-07-01T00:00:00.000Z', counts: { registrantCount: 1, attendeeCount: 0, noShowCount: 0 }, ...over,
});

beforeEach(() => {
  listWebinarEvents.mockReset(); createWebinarEvent.mockReset(); pushWebinarRegistrants.mockReset(); syncWebinarEvent.mockReset();
  listOrgs.mockReset(); listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
  listPendingRegistrants.mockReset(); removePendingRegistrant.mockReset();
  confirmMock.mockReset(); confirmMock.mockResolvedValue(true);
  vi.mocked(toast.success).mockReset(); vi.mocked(toast.error).mockReset(); vi.mocked(toast.info).mockReset();
});
afterEach(cleanup);

describe('ADR 1054 — the page names the new outcomes', () => {
  it('D1: a webinar another organization tracks is refused ON THE FIELD, in the page\'s own words', async () => {
    listWebinarEvents.mockResolvedValue([]);
    createWebinarEvent.mockRejectedValue(new WebinarsApiError('This webinar is already tracked by another client in this workspace.', 'event_in_other_org'));
    render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
    await act(async () => {});
    const field = await screen.findByLabelText(/Zoom webinar ID/);
    fireEvent.change(field, { target: { value: '891' } });
    fireEvent.click(screen.getByRole('button', { name: 'Track webinar' }));
    await act(async () => {});
    expect(createWebinarEvent).toHaveBeenCalledWith('org-1', { providerEventId: '891' });
    expect(screen.getByRole('alert').textContent).toBe('Another organization in this workspace already tracks this Zoom webinar.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText(/tracked by another client/)).toBeNull();
    // On the field, not (only) a toast that disappears.
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it('D3: queued reasons have words, and an empty queue is not "nothing was pushed"', async () => {
    listWebinarEvents.mockResolvedValue([event({ pendingPushCount: 2 })]);
    pushWebinarRegistrants.mockResolvedValueOnce({ pushed: 0, failed: 1, failures: [{ email: 'a@x.test', reason: 'zoom_no_registrant_id' }] });
    render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
    await act(async () => {});
    fireEvent.click(await screen.findByRole('button', { name: /Push to Zoom/ }));
    await act(async () => {});
    expect(vi.mocked(toast.error)).toHaveBeenLastCalledWith('Nothing was pushed: Zoom did not confirm the registration. Everyone stays queued.');
    pushWebinarRegistrants.mockResolvedValueOnce({ pushed: 1, failed: 1, failures: [{ email: 'b@x.test', reason: 'zoom_429' }] });
    fireEvent.click(await screen.findByRole('button', { name: /Push to Zoom/ }));
    await act(async () => {});
    expect(vi.mocked(toast.info)).toHaveBeenLastCalledWith(expect.stringMatching(/1 still queued: Zoom is rate-limiting/));
    pushWebinarRegistrants.mockResolvedValueOnce({ pushed: 0, failed: 0, failures: [] });
    fireEvent.click(await screen.findByRole('button', { name: /Push to Zoom/ }));
    await act(async () => {});
    expect(vi.mocked(toast.info)).toHaveBeenLastCalledWith('Nothing was waiting to be pushed; the list is up to date.');
    pushWebinarRegistrants.mockResolvedValueOnce({ pushed: 0, failed: 1, failures: [{ email: 'c@x.test', reason: 'zoom_418' }] });
    fireEvent.click(await screen.findByRole('button', { name: /Push to Zoom/ }));
    await act(async () => {});
    expect(vi.mocked(toast.error)).toHaveBeenLastCalledWith('Nothing was pushed: Zoom returned an error (zoom_418). Everyone stays queued.');
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(2);
  });

  it('sync: a PARTIAL sync with no attendees says partial; an upcoming webinar reports its registrations', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    listWebinarEvents.mockResolvedValue([event(), event({ eventId: 'ev-2', providerEventId: 'z-2', title: 'Next week', startsAt: future })]);
    render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
    await act(async () => {});
    const syncButtons = await screen.findAllByRole('button', { name: /Sync attendance/ });
    syncWebinarEvent.mockResolvedValueOnce({ outcome: 'synced', attendees: 0, noShows: 0, registrants: 3, partial: true });
    fireEvent.click(syncButtons[0]!);
    await act(async () => {});
    expect(vi.mocked(toast.info)).toHaveBeenLastCalledWith(expect.stringMatching(/cut off mid-read/));
    syncWebinarEvent.mockResolvedValueOnce({ outcome: 'synced', attendees: 0, noShows: 0, registrants: 3 });
    fireEvent.click(syncButtons[1]!);
    await act(async () => {});
    expect(vi.mocked(toast.success)).toHaveBeenLastCalledWith('Synced 3 registrations from Zoom. Attendance appears after the webinar ends.');
  });

  it('a sync error never says "stays queued" (that clause belongs to a push), in every locale', async () => {
    // The reason sentences are shared by push, sync and the queue list; only the push
    // toasts add the queued clause. Checked on the tables, so all four locales are held.
    const queuedWord: Record<string, RegExp> = { en: /queued/i, es: /cola/i, fr: /file/i, 'pt-BR': /fila/i };
    for (const [loc, m] of Object.entries({ en, es, fr, 'pt-BR': ptBR })) {
      for (const k of ['reasonRateLimited', 'reasonZoomUnavailable', 'reasonGeneric', 'reasonNoRegistrantId', 'syncError'] as const) {
        expect(m[k], `${loc}.${k}`).not.toMatch(queuedWord[loc]!);
      }
      expect(m.pushFailed, `${loc}.pushFailed`).toMatch(queuedWord[loc]!);
    }
    listWebinarEvents.mockResolvedValue([event()]);
    syncWebinarEvent.mockResolvedValueOnce({ outcome: 'error', reason: 'zoom_429' });
    render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
    await act(async () => {});
    fireEvent.click(await screen.findByRole('button', { name: /Sync attendance/ }));
    await act(async () => {});
    expect(vi.mocked(toast.error)).toHaveBeenLastCalledWith('Could not sync attendance. Zoom is rate-limiting requests; try again in a few minutes.');
  });

  it('switching organization clears the other organization\'s 409 on the field', async () => {
    listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }, { orgId: 'org-2', name: 'Beta' }]);
    listWebinarEvents.mockResolvedValue([]);
    createWebinarEvent.mockRejectedValue(new WebinarsApiError('x', 'event_in_other_org'));
    render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
    await act(async () => {});
    fireEvent.change(await screen.findByLabelText(/Zoom webinar ID/), { target: { value: '891' } });
    fireEvent.click(screen.getByRole('button', { name: 'Track webinar' }));
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toBe('Another organization in this workspace already tracks this Zoom webinar.');
    fireEvent.change(screen.getByRole('combobox', { name: /organization/i }), { target: { value: 'org-2' } });
    await act(async () => {});
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the queue list names who is waiting and why, and removes one only after a confirm', async () => {
    listWebinarEvents.mockResolvedValue([event({ pendingPushCount: 2 })]);
    const ada: PendingRegistrant = { pendingId: 'p1', email: 'ad…@x.test', name: 'Ada Lovelace', queuedAt: '2026-11-01T00:00:00.000Z', attempts: 3, lastError: 'zoom_400:300' };
    const anon: PendingRegistrant = { pendingId: 'p2', email: 'bo…@x.test', queuedAt: '2026-11-02T00:00:00.000Z', attempts: 0 };
    listPendingRegistrants.mockResolvedValue({ total: 2, items: [ada, anon] });
    removePendingRegistrant.mockResolvedValue(undefined);
    render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
    await act(async () => {});
    fireEvent.click(await screen.findByRole('button', { name: 'Show who is waiting' }));
    await act(async () => {});
    expect(listPendingRegistrants).toHaveBeenCalledWith('org-1', 'ev-1');
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText(/3 failed attempts · Zoom returned an error \(zoom_400:300\)\./)).toBeTruthy();
    expect(screen.getByText('Not tried yet')).toBeTruthy();

    // Cancelled confirm: nothing is removed.
    confirmMock.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ada Lovelace (ad…@x.test) from the Zoom queue' }));
    await act(async () => {});
    expect(confirmMock).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Remove Ada Lovelace (ad…@x.test) from the Zoom queue?', danger: true }));
    expect(removePendingRegistrant).not.toHaveBeenCalled();

    listPendingRegistrants.mockResolvedValue({ total: 1, items: [anon] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ada Lovelace (ad…@x.test) from the Zoom queue' }));
    await act(async () => {});
    expect(removePendingRegistrant).toHaveBeenCalledWith('org-1', 'ev-1', 'p1');
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Removed from the queue. They stay registered in your CRM.');
    expect(screen.queryByText('Ada Lovelace')).toBeNull();

    // A row someone else already removed: the page's words, and the list refreshes.
    removePendingRegistrant.mockRejectedValueOnce(new WebinarsApiError('That registrant is no longer queued.', undefined, 'not_found'));
    listPendingRegistrants.mockResolvedValue({ total: 0, items: [] });
    const readsBefore = listPendingRegistrants.mock.calls.length;
    expect(screen.getByText('Not tried yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove bo…@x.test from the Zoom queue' }));
    await act(async () => {});
    expect(vi.mocked(toast.info)).toHaveBeenLastCalledWith('That registrant is no longer queued. The list is refreshed.');
    // ... and the list IS refreshed: it read again, and the gone row is no longer shown.
    expect(listPendingRegistrants.mock.calls.length).toBe(readsBefore + 1);
    expect(screen.queryByText('Not tried yet')).toBeNull();
  });

  it('an open queue list re-reads after a push (WEB86-18)', async () => {
    listWebinarEvents.mockResolvedValue([event({ pendingPushCount: 1 })]);
    listPendingRegistrants.mockResolvedValue({ total: 1, items: [{ pendingId: 'p1', email: 'ad…@x.test', queuedAt: '2026-11-01T00:00:00.000Z', attempts: 0 }] });
    pushWebinarRegistrants.mockResolvedValue({ pushed: 0, failed: 1, failures: [{ email: 'a@x.test', reason: 'zoom_429' }] });
    render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
    await act(async () => {});
    fireEvent.click(await screen.findByRole('button', { name: 'Show who is waiting' }));
    await act(async () => {});
    expect(listPendingRegistrants).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Push to Zoom/ }));
    await act(async () => {});
    expect(listPendingRegistrants).toHaveBeenCalledTimes(2);
  });
});
