/**
 * ADR 0578 (SD-G4) — the reply composer keeps the learned gesture and gains
 * prose: Enter sends; Shift+Enter inserts a newline (and never sends); Enter
 * during IME composition never sends (the CJK defect this class of change
 * usually ships); typed/pasted newlines reach the send payload intact.
 *
 * Sabotage-witnessed (ADR 0578 + round 1/2): the `isComposing` guard, the
 * `shiftKey` guard, the Enter → send dispatch, and the untrimmed-interior
 * payload (newlines kept, only the ends trimmed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import type { Ticket, TicketDetail, IntakeStatus, QueueView } from '../serviceDeskClient.js';
import type { Organization } from '../../../client/accessClient.js';

const { listSupportTickets, getSupportTicket, getIntakeConfig, postTicketMessage, listOrgs } = vi.hoisted(() => ({
  listSupportTickets: vi.fn<(orgId: string, status?: string, view?: QueueView) => Promise<Ticket[]>>(),
  getSupportTicket: vi.fn<(orgId: string, ticketId: string) => Promise<TicketDetail>>(),
  getIntakeConfig: vi.fn<(orgId: string) => Promise<IntakeStatus>>(),
  postTicketMessage: vi.fn<(orgId: string, ticketId: string, body: string, direction: 'outbound' | 'internal', idempotencyKey?: string) => Promise<TicketDetail>>(),
  listOrgs: vi.fn<() => Promise<Organization[]>>(),
}));
vi.mock('../serviceDeskClient.js', async (orig) => ({
  ...(await orig<typeof import('../serviceDeskClient.js')>()),
  // ADR 0878 D7 — the assignee picker read (enrichment; never the network in tests).
  listAssignees: async () => ({ assignees: [], me: [] }),
  listSupportTickets, getSupportTicket, getIntakeConfig, postTicketMessage,
}));
vi.mock('../../../client/accessClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/accessClient.js')>()),
  listOrgs,
}));

import { SupportPage } from '../SupportPage.js';

const TICKET: Ticket = {
  ticketId: 't1', subject: 'Login broken', status: 'open', priority: 'high',
  channel: 'email', messages: [{ messageId: 'm1', direction: 'inbound', body: 'help', author: 'c@x.io', at: '2026-07-25T10:00:00Z' }],
  requester: { email: 'c@x.io' }, createdAt: '2026-07-25T10:00:00Z', updatedAt: '2026-07-25T10:00:00Z',
};
const ORG: Organization = {
  orgId: 'o1', tenantId: 'tn1', name: 'Acme', slug: 'acme', createdBy: 'u1',
  createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([ORG]);
  listSupportTickets.mockResolvedValue([TICKET]);
  getIntakeConfig.mockResolvedValue({ configured: true, here: true, config: { defaultOrgId: 'o1' } });
  getSupportTicket.mockResolvedValue(TICKET);
  postTicketMessage.mockResolvedValue(TICKET);
});
afterEach(cleanup);

async function openComposer(): Promise<HTMLTextAreaElement> {
  render(<SupportPage />);
  await act(async () => {});
  fireEvent.click(await screen.findByText('Login broken'));
  await act(async () => {});
  return await screen.findByLabelText('Message text') as HTMLTextAreaElement;
}

describe('ADR 0578 — the composer gesture', () => {
  it('Enter sends (the learned gesture, kept)', async () => {
    const box = await openComposer();
    expect(box.tagName).toBe('TEXTAREA'); // the SD-G4 upgrade itself
    fireEvent.change(box, { target: { value: 'On our way.' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await act(async () => {});
    expect(postTicketMessage).toHaveBeenCalledTimes(1);
    // The composed text, as a customer-facing reply, under a per-message key.
    expect(postTicketMessage).toHaveBeenCalledWith('o1', 't1', 'On our way.', 'outbound', expect.stringMatching(/^t1:\d+$/));
  });

  it('Shift+Enter does NOT send — it is the newline', async () => {
    const box = await openComposer();
    fireEvent.change(box, { target: { value: 'line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(postTicketMessage).not.toHaveBeenCalled();
  });

  it('Enter during IME composition never sends (the CJK guard)', async () => {
    const box = await openComposer();
    fireEvent.change(box, { target: { value: '入力中' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(postTicketMessage).not.toHaveBeenCalled();
  });

  it('internal newlines survive to the send payload (the textarea point)', async () => {
    const box = await openComposer();
    fireEvent.change(box, { target: { value: 'para one\n\npara two' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await act(async () => {});
    expect(postTicketMessage).toHaveBeenCalledWith('o1', 't1', 'para one\n\npara two', 'outbound', expect.any(String));
  });
});
