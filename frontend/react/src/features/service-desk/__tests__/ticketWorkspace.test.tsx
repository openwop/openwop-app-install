/**
 * ADR 0878 D7 — the agent workspace: queue views, assignment, priority, and
 * what happened to each reply. Before ADR 0878 a reply was stored and sent
 * nowhere while the thread read as answered; these pin that the page now says so.
 *
 * PROTECTED (delivery honesty, ADR 0878 D7 — cited at docs/adr/0878 §D7).
 * Sabotage-witnessed (round 1/2): the delivery chip states + reason copy, the
 * Retry apply + its `canRetry` gate (outside_window), "No delivery record",
 * the no-channel option + hint + Save label, the WhatsApp option, the requester
 * phone in the meta row, the view request, assign-self + the "You" label,
 * priority save, the overdue chip, the other-org intake notice, focus on open.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
import type { Ticket, TicketDetail, Delivery, IntakeStatus, QueueView, Assignee } from '../serviceDeskClient.js';
import type { Organization } from '../../../client/accessClient.js';

vi.mock('../../../chat/ChatPocket.js', () => ({ ChatPocket: () => null }));

const m = vi.hoisted(() => ({
  listSupportTickets: vi.fn<(orgId: string, status?: string, view?: QueueView) => Promise<Ticket[]>>(),
  getSupportTicket: vi.fn<(orgId: string, ticketId: string) => Promise<TicketDetail>>(),
  getIntakeConfig: vi.fn<(orgId: string) => Promise<IntakeStatus>>(),
  postTicketMessage: vi.fn<(orgId: string, ticketId: string, body: string, direction: 'outbound' | 'internal', idempotencyKey?: string) => Promise<TicketDetail>>(),
  retryDelivery: vi.fn<(orgId: string, ticketId: string, messageId: string) => Promise<Record<string, Delivery>>>(),
  assignTicket: vi.fn<(orgId: string, ticketId: string, to: { subject: string } | 'self' | null) => Promise<Ticket>>(),
  setTicketPriority: vi.fn<(orgId: string, ticketId: string, priority: Ticket['priority']) => Promise<Ticket>>(),
  listAssignees: vi.fn<(orgId: string) => Promise<{ assignees: Assignee[]; me: string[] }>>(),
  listOrgs: vi.fn<() => Promise<Organization[]>>(),
}));
vi.mock('../serviceDeskClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listSupportTickets: m.listSupportTickets, getSupportTicket: m.getSupportTicket, getIntakeConfig: m.getIntakeConfig,
  postTicketMessage: m.postTicketMessage, retryDelivery: m.retryDelivery, assignTicket: m.assignTicket,
  setTicketPriority: m.setTicketPriority, listAssignees: m.listAssignees,
}));
vi.mock('../../../client/accessClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: m.listOrgs,
}));

import { SupportPage } from '../SupportPage.js';

// The inbound author is NOT the phone number: the requester row is the only
// place `+15550123` can come from, so the "shows the customer's number" case
// reads the meta row and nothing else (round 1: `tw-phone` was vacuous because
// the author `wa:+15550123` carried the same digits).
const BASE: Ticket = {
  ticketId: 't1', subject: 'Order late', status: 'open', priority: 'normal',
  channel: 'whatsapp', createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z',
  replyChannel: { kind: 'whatsapp', connectionId: 'c' }, requester: { phone: '+15550123' },
  messages: [
    { messageId: 'in-1', direction: 'inbound', body: 'where is it', author: 'Customer', at: '2026-10-01T10:00:00Z' },
    { messageId: 'out:1', direction: 'outbound', body: 'shipping today', author: 'user:u', at: '2026-10-01T10:05:00Z' },
  ],
};
/** The same ticket with no reply channel and no requester (a manual ticket). */
const MANUAL: Ticket = {
  ticketId: 't1', subject: 'Order late', status: 'open', priority: 'normal',
  channel: 'manual', createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z',
  messages: BASE.messages,
};
const ORG: Organization = {
  orgId: 'o1', tenantId: 'tn1', name: 'Acme', slug: 'acme', createdBy: 'u1',
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
};
const OUTSIDE_WINDOW: Delivery = { state: 'failed', at: '2026-10-01T10:05:01Z', attempts: 1, code: 'outside_window' };

beforeEach(() => {
  vi.clearAllMocks();
  m.listOrgs.mockResolvedValue([ORG]);
  m.listSupportTickets.mockResolvedValue([BASE]);
  m.getIntakeConfig.mockResolvedValue({ configured: true, here: true, config: { defaultOrgId: 'o1' } });
  m.listAssignees.mockResolvedValue({ assignees: [{ subject: 'u-ana', displayName: 'Ana' }, { subject: 'u-me', displayName: 'Me' }], me: ['u-me'] });
  m.getSupportTicket.mockResolvedValue({ ...BASE, deliveries: { 'out:1': { state: 'failed', at: '2026-10-01T10:05:01Z', attempts: 1, code: 'wa_request_failed', message: 'x' } } });
});
afterEach(cleanup);

async function openTicket(): Promise<HTMLElement> {
  render(<SupportPage />);
  await act(async () => {});
  await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Order late' })); });
  return screen.getByRole('list', { name: 'Thread for Order late' });
}

describe('ADR 0878 D7 — delivery is visible, and a failure has an exit', () => {
  it('a failed reply says it was not delivered, why, and offers Retry', async () => {
    const thread = await openTicket();
    expect(within(thread).getByText('Not delivered')).toBeTruthy();
    expect(thread.textContent).toContain('WhatsApp could not be reached. Try again.');
    m.retryDelivery.mockResolvedValue({ 'out:1': { state: 'sent', at: '2026-10-01T10:06:00Z', attempts: 2 } });
    await act(async () => { fireEvent.click(within(thread).getByRole('button', { name: 'Retry' })); });
    expect(m.retryDelivery).toHaveBeenCalledWith('o1', 't1', 'out:1');
    expect(within(thread).getByText('Sent')).toBeTruthy();
    expect(within(thread).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('a ticket with no reply channel says so BEFORE the reply is written', async () => {
    m.listSupportTickets.mockResolvedValue([MANUAL]);
    m.getSupportTicket.mockResolvedValue({ ...MANUAL, deliveries: {} });
    await openTicket();
    expect(screen.getByRole('option', { name: 'Record a reply (not sent)' })).toBeTruthy();
    expect(document.body.textContent).toContain('This ticket has no reply channel, so a reply is saved on the thread but not sent.');
  });

  it('a WhatsApp ticket offers a WhatsApp reply and shows the customer\'s number', async () => {
    await openTicket();
    expect(screen.getByRole('option', { name: 'Reply on WhatsApp' })).toBeTruthy();
    // The requester's number, in the ticket's meta row (not the thread).
    expect(screen.getByText('· +15550123')).toBeTruthy();
  });
});

describe('ADR 0878 D7 — views, assignment, priority', () => {
  it('a view asks the server for that view', async () => {
    render(<SupportPage />);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Overdue' })); });
    expect(m.listSupportTickets).toHaveBeenLastCalledWith('o1', undefined, 'overdue');
    expect(screen.getByRole('button', { name: 'Overdue' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('Assign to me, then the picker names the assignee and priority re-saves', async () => {
    await openTicket();
    m.assignTicket.mockResolvedValue({ ...BASE, assigneeMemberId: 'u-me' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Assign to me' })); });
    expect(m.assignTicket).toHaveBeenCalledWith('o1', 't1', 'self');
    // A menu, not a <select> (SD2UX-7): its trigger names the assignee.
    expect(screen.getByRole('button', { name: 'Change assignee' }).textContent).toContain('You');
    m.setTicketPriority.mockResolvedValue({ ...BASE, priority: 'urgent' });
    await act(async () => { fireEvent.change(screen.getByLabelText('Change ticket priority'), { target: { value: 'urgent' } }); });
    expect(m.setTicketPriority).toHaveBeenCalledWith('o1', 't1', 'urgent');
  });

  it('an overdue open ticket is flagged in the queue', async () => {
    m.listSupportTickets.mockResolvedValue([{ ...BASE, slaDueAt: '2020-01-01T00:00:00Z' }]);
    render(<SupportPage />);
    await act(async () => {});
    expect(screen.getAllByText('Overdue').some((el) => el.classList.contains('chip'))).toBe(true);
  });
});

describe('ADR 0878 D2 — intake configured for another organization', () => {
  it('says so and offers no takeover', async () => {
    m.getIntakeConfig.mockResolvedValue({ configured: true, here: false, config: null });
    render(<SupportPage />);
    await act(async () => {});
    expect(document.body.textContent).toContain('filed into a different organization');
    expect(screen.queryByRole('button', { name: 'File intake into this org' })).toBeNull();
  });
});

describe('ADR 0878 grade-ux follow-ups', () => {
  it('a failure Retry cannot fix offers no Retry (SD2UX-10); a reply with no record does not read as sent (SD2UX-9)', async () => {
    m.getSupportTicket.mockResolvedValue({ ...BASE, messages: [...BASE.messages, { messageId: 'old', direction: 'outbound', body: 'legacy', author: 'user:u', at: '2026-09-01T00:00:00Z' }],
      deliveries: { 'out:1': OUTSIDE_WINDOW } });
    const thread = await openTicket();
    expect(within(thread).queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(within(thread).getByText('No delivery record')).toBeTruthy();
  });

  it('opening a ticket moves focus to its heading (SD2UX-4); the no-channel button says Save, not Send (SD2UX-12)', async () => {
    m.listSupportTickets.mockResolvedValue([MANUAL]);
    m.getSupportTicket.mockResolvedValue({ ...MANUAL, deliveries: {} });
    await openTicket();
    expect(document.activeElement?.textContent).toBe('Order late');
    expect(screen.getByRole('button', { name: /Save reply/ })).toBeTruthy();
  });
});

describe('ADR 0878 OQ-1 — the out-of-window refusal reads as the decision specified', () => {
  it('Not delivered: outside WhatsApp\'s 24-hour reply window — and no Retry', async () => {
    // Twin of the SD2UX-10 case above on "outside_window ⇒ no Retry"; this one owns
    // the exact refusal copy.
    m.getSupportTicket.mockResolvedValue({ ...BASE, deliveries: { 'out:1': OUTSIDE_WINDOW } });
    const thread = await openTicket();
    expect(thread.textContent).toContain("Not delivered: outside WhatsApp's 24-hour reply window");
    expect(within(thread).queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
