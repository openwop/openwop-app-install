/**
 * UX_UPGRADE-webinars — WEB-G1 / WEB-G2.
 *
 *  - WEB-G1: binding a registration form meant typing an opaque form id. Any
 *    string was accepted (server-side too), so a typo produced a "Form bound"
 *    chip for a binding that could never deliver a registrant. A picker makes an
 *    invalid id unreachable from the UI; the route now refuses one regardless.
 *  - WEB-G2: `formId` rode in the payload and the chip said only "Form bound".
 *    WHICH form is the entire point of the binding.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { MarketingEvent } from '../webinarsClient.js';

const listWebinarEvents = vi.fn();
const pushWebinarRegistrants = vi.fn();
const bindWebinarForm = vi.fn();
const listForms = vi.fn();

vi.mock('../webinarsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listWebinarEvents: () => listWebinarEvents(),
  bindWebinarForm: (...a: unknown[]) => bindWebinarForm(...a),
  createWebinarEvent: vi.fn(async () => ({})),
  syncWebinarEvent: vi.fn(async () => ({ outcome: 'synced' })),
  pushWebinarRegistrants: (...a: unknown[]) => pushWebinarRegistrants(...a),
}));
vi.mock('../../forms/formsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listForms: (...a: unknown[]) => listForms(...a),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { WebinarsPage } from '../WebinarsPage.js';

// R2 WB-SP-10 — real rows store provider 'zoom' ('zoom-webinar' is the
// CONNECTION provider namespace); full literal, no cast.
const event = (over: Partial<MarketingEvent> = {}): MarketingEvent => ({
  eventId: 'ev-1', provider: 'zoom', providerEventId: 'z-1', title: 'Launch webinar',
  createdAt: '2026-07-01T00:00:00.000Z', counts: { registrantCount: 3, attendeeCount: 2, noShowCount: 1 },
  ...over,
});

const FORMS = [
  { formId: 'form-a', orgId: 'org-1', title: 'Webinar signup', status: 'published', fields: [], createToContact: true, createdAt: '2026-01-01T00:00:00.000Z' },
  { formId: 'form-b', orgId: 'org-1', title: 'Newsletter', status: 'published', fields: [], createToContact: true, createdAt: '2026-01-01T00:00:00.000Z' },
];

const view = async (): Promise<void> => {
  render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
  await act(async () => {});
  await screen.findByText('Launch webinar');
};

beforeEach(() => {
  listWebinarEvents.mockReset(); bindWebinarForm.mockReset(); listForms.mockReset(); pushWebinarRegistrants.mockReset();
  listWebinarEvents.mockResolvedValue([event()]);
  listForms.mockResolvedValue(FORMS);
  bindWebinarForm.mockResolvedValue({});
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
    const args = bindWebinarForm.mock.calls[0];
    expect(args).toContain('form-b');
  });

  it('an organization with NO forms says so instead of offering an empty picker', async () => {
    listForms.mockResolvedValue([]);
    await view();
    fireEvent.click(screen.getByRole('button', { name: /link registration form|change linked form/i }));
    expect(await screen.findByText('No forms in this organization yet — create one first.')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /registration form/i })).toBeNull();
  });

  it('a failed forms read degrades to the empty message, not a broken dashboard', async () => {
    listForms.mockRejectedValue(new Error('forms down'));
    await view();
    // The events list still renders — the binding affordance is what degrades.
    expect(screen.getByText('Launch webinar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /link registration form|change linked form/i }));
    expect(await screen.findByText('No forms in this organization yet — create one first.')).toBeTruthy();
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
    expect(pushWebinarRegistrants).toHaveBeenCalled();
    // Nothing pushed is a failure, with the reason translated to an action —
    // never a success toast (the campaign-connectors M2 lesson).
    const { toast } = await import('../../../ui/toast.js');
    expect((toast.error as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.stringMatching(/Zoom isn't connected/));
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
    const { toast } = await import('../../../ui/toast.js');
    expect((toast.success as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.stringMatching(/Pushed 3 registrants/));
    unmount();

    pushWebinarRegistrants.mockResolvedValueOnce({ pushed: 2, failed: 1, failures: [{ email: 'a@x.test', reason: 'zoom_500' }] });
    render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
    await act(async () => {});
    fireEvent.click(await screen.findByRole('button', { name: /Push to Zoom/ }));
    await act(async () => {});
    expect((toast.info as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.stringMatching(/Pushed 2; 1 failed/));
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
    expect(await screen.findByText('Upcoming')).toBeTruthy();
    expect(screen.getByText('Past')).toBeTruthy();
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
