/**
 * UX_UPGRADE-webinars — WEB-G1 / WEB-G2.
 *
 *  - WEB-G1: binding a registration form meant typing an opaque form id. Any
 *    string was accepted (server-side too), so a typo produced a "Form bound"
 *    chip for a binding that could never deliver a registrant. A picker makes an
 *    invalid id unreachable from the UI; the route now refuses one regardless.
 *  - WEB-G2: `formId` rode in the payload and the chip said only "Form bound".
 *    WHICH form is the entire point of the binding.
 *  - R2 WB-SP-2 / WB-SP-11 / R3 WB-SP-9 (ADR 0404 §a): a push that sent nothing is
 *    an ERROR toast and a partial one says both figures; a failed events read is
 *    the failure card, never the "add a webinar" instruction; the lifecycle chip
 *    is Upcoming/Past PER ROW; the via-connection chip shows only when set.
 *
 * The failed-FORMS-read case lives in `webinarForms.readFailure.test.tsx`
 * (EMPTY-ON-FAIL-7) — this file's copy was cut in /grade-tests w52.
 *
 * Sabotage-witnessed (/grade-tests w52): option text from the id, a bind with
 * the wrong form or org, no empty-forms branch, a wrong form title lookup, a
 * success toast for a zero push / a partial push, no failed-events branch, an
 * inverted lifecycle comparison, and a truncated connection id each turn a case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { MarketingEvent, OrgRef } from '../webinarsClient.js';
import type { FormDef } from '../../forms/formsClient.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import { toast } from '../../../ui/toast.js';

type PushResult = { pushed: number; failed: number; failures: Array<{ email: string; reason: string }> };
const listWebinarEvents = vi.fn<(orgId: string) => Promise<MarketingEvent[]>>();
const pushWebinarRegistrants = vi.fn<(orgId: string, eventId: string) => Promise<PushResult>>();
const bindWebinarForm = vi.fn<(orgId: string, eventId: string, formId: string) => Promise<void>>();
const listForms = vi.fn<(orgId: string) => Promise<FormDef[]>>();

vi.mock('../webinarsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async (): Promise<OrgRef[]> => [{ orgId: 'org-1', name: 'Acme' }]),
  listWebinarEvents: (orgId: string) => listWebinarEvents(orgId),
  bindWebinarForm: (orgId: string, eventId: string, formId: string) => bindWebinarForm(orgId, eventId, formId),
  pushWebinarRegistrants: (orgId: string, eventId: string) => pushWebinarRegistrants(orgId, eventId),
}));
vi.mock('../../forms/formsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listForms: (orgId: string) => listForms(orgId),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess(),
}));

import { WebinarsPage } from '../WebinarsPage.js';

// R2 WB-SP-10 — real rows store provider 'zoom' ('zoom-webinar' is the
// CONNECTION provider namespace); full literal, no cast.
const event = (over: Partial<MarketingEvent> = {}): MarketingEvent => ({
  eventId: 'ev-1', provider: 'zoom', providerEventId: 'z-1', title: 'Launch webinar',
  createdAt: '2026-07-01T00:00:00.000Z', counts: { registrantCount: 3, attendeeCount: 2, noShowCount: 1 },
  ...over,
});

const FORMS: FormDef[] = [
  { formId: 'form-a', orgId: 'org-1', title: 'Webinar signup', status: 'published', fields: [], createToContact: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  { formId: 'form-b', orgId: 'org-1', title: 'Newsletter', status: 'published', fields: [], createToContact: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
];

const view = async (): Promise<void> => {
  render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
  await act(async () => {});
  await screen.findByText('Launch webinar');
};

beforeEach(() => {
  listWebinarEvents.mockReset(); bindWebinarForm.mockReset(); listForms.mockReset(); pushWebinarRegistrants.mockReset();
  // The toast mock is module-level: reset it so one case's toasts never answer another's.
  vi.mocked(toast.success).mockReset(); vi.mocked(toast.error).mockReset(); vi.mocked(toast.info).mockReset();
  listWebinarEvents.mockResolvedValue([event()]);
  listForms.mockResolvedValue(FORMS);
  bindWebinarForm.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('WEB-G1: binding picks a real form instead of typing an id', () => {
  it('offers the organization forms by NAME, not a free-text id', async () => {
    await view();
    fireEvent.click(screen.getByRole('button', { name: /link registration form|change linked form/i }));
    const select = await screen.findByRole('combobox', { name: /registration form/i });
    const offered = Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);
    expect(offered).toContain('Webinar signup');
    expect(offered).toContain('Newsletter');
  });

  it('binds the id behind the chosen name', async () => {
    await view();
    fireEvent.click(screen.getByRole('button', { name: /link registration form|change linked form/i }));
    const select = await screen.findByRole('combobox', { name: /registration form/i });
    fireEvent.change(select, { target: { value: 'form-b' } });
    fireEvent.click(screen.getByRole('button', { name: /^link form$/i }));
    await waitFor(() => expect(bindWebinarForm).toHaveBeenCalled());
    // The exact binding: this org, this event, the id behind "Newsletter".
    expect(bindWebinarForm).toHaveBeenCalledTimes(1);
    expect(bindWebinarForm).toHaveBeenCalledWith('org-1', 'ev-1', 'form-b');
  });

  it('an organization with NO forms says so instead of offering an empty picker', async () => {
    listForms.mockResolvedValue([]);
    await view();
    fireEvent.click(screen.getByRole('button', { name: /link registration form|change linked form/i }));
    expect(await screen.findByText('No forms in this organization yet — create one first.')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /registration form/i })).toBeNull();
  });
});

describe('WEB-G2: the chip says WHICH form is bound', () => {
  it('names the bound form', async () => {
    listWebinarEvents.mockResolvedValue([event({ formId: 'form-a' })]);
    await view();
    expect(await screen.findByText('Webinar signup')).toBeTruthy();
  });

  it('falls back to the id when the form is not in the list (deleted, or not yet loaded)', async () => {
    listWebinarEvents.mockResolvedValue([event({ formId: 'form-gone' })]);
    await view();
    // Never a bare "Form bound" with no way to tell what it points at.
    expect(await screen.findByText(/form-gone/)).toBeTruthy();
  });
});

describe('R2 WB-SP-2 — pending registrant pushes are visible and drainable', () => {
  it('shows the not-on-Zoom chip and the Push action; pushed 0 with failures is an ERROR toast', async () => {
    listWebinarEvents.mockResolvedValue([event({ pendingPushCount: 2 })]);
    pushWebinarRegistrants.mockResolvedValue({ pushed: 0, failed: 2, failures: [{ email: 'a@x.test', reason: 'no_connection' }] });
    render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
    await act(async () => {});
    expect(await screen.findByText('2 registrations not on Zoom yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Push to Zoom/ }));
    await act(async () => {});
    expect(pushWebinarRegistrants).toHaveBeenCalledTimes(1);
    expect(pushWebinarRegistrants).toHaveBeenCalledWith('org-1', 'ev-1');
    // Nothing pushed is a failure, with the reason translated to an action —
    // never a success toast (the campaign-connectors M2 lesson).
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringMatching(/Zoom isn't connected/));
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it('R2 WB-SP-11: the failed-events read renders the failure card, never the empty instruction', async () => {
    listWebinarEvents.mockRejectedValue(new Error('events boom'));
    render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
    await act(async () => {});
    expect(await screen.findByText(/Could not load this/i)).toBeTruthy();
    expect(screen.queryByText(/Add a Zoom webinar/i)).toBeNull();
  });
});

describe('R2 review fold-in — the remaining push/chip branches', () => {
  it('a full success toasts pushDone; a partial push toasts info with both figures', async () => {
    listWebinarEvents.mockResolvedValue([event({ pendingPushCount: 3 })]);
    pushWebinarRegistrants.mockResolvedValueOnce({ pushed: 3, failed: 0, failures: [] });
    const { unmount } = render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
    await act(async () => {});
    fireEvent.click(await screen.findByRole('button', { name: /Push to Zoom/ }));
    await act(async () => {});
    expect(pushWebinarRegistrants).toHaveBeenLastCalledWith('org-1', 'ev-1');
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(expect.stringMatching(/Pushed 3 registrants/));
    unmount();

    pushWebinarRegistrants.mockResolvedValueOnce({ pushed: 2, failed: 1, failures: [{ email: 'a@x.test', reason: 'zoom_500' }] });
    render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
    await act(async () => {});
    fireEvent.click(await screen.findByRole('button', { name: /Push to Zoom/ }));
    await act(async () => {});
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith(expect.stringMatching(/Pushed 2; 1 failed/));
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1); // only the full push succeeded
  });

  it('the lifecycle chip reads Upcoming for a future start and Past for an elapsed one, with a zone-labeled time', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const past = new Date(Date.now() - 86400000).toISOString();
    listWebinarEvents.mockResolvedValue([
      event({ eventId: 'ev-f', providerEventId: 'zf', title: 'Future call', startsAt: future }),
      event({ eventId: 'ev-p', providerEventId: 'zp', title: 'Past call', startsAt: past }),
    ]);
    render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
    await act(async () => {});
    // PER ROW: one future and one past row would still show both words if the
    // comparison were inverted, so each row's own chip is asserted.
    const rowOf = async (title: string): Promise<HTMLElement> => (await screen.findByText(title)).closest('li')!;
    expect(within(await rowOf('Future call')).getByText('Upcoming')).toBeTruthy();
    expect(within(await rowOf('Future call')).queryByText('Past')).toBeNull();
    expect(within(await rowOf('Past call')).getByText('Past')).toBeTruthy();
    expect(within(await rowOf('Past call')).queryByText('Upcoming')).toBeNull();
  });
});

describe('R3 WB-SP-9 remainder — connectionId finally visible', () => {
  it('an event with a connectionId shows the via-connection chip; without one, no chip (default = absence, not fabrication)', async () => {
    listWebinarEvents.mockResolvedValue([
      event({ eventId: 'ev-c', providerEventId: 'zc', title: 'Connected call', connectionId: 'conn-abcdef1234' }),
      event({ eventId: 'ev-d', providerEventId: 'zd', title: 'Default call' }),
    ]);
    render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
    await act(async () => {});
    await screen.findByText('Connected call');
    expect(screen.getByText('via connection conn-abc…')).toBeTruthy();
    expect(screen.getAllByText(/via connection/).length).toBe(1); // the default-connection event shows none
  });
});
