/**
 * ADR 0578 (SD-G4) — the reply composer keeps the learned gesture and gains
 * prose: Enter sends; Shift+Enter inserts a newline (and never sends); Enter
 * during IME composition never sends (the CJK defect this class of change
 * usually ships); typed/pasted newlines reach the send payload intact.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { listSupportTickets, getSupportTicket, getIntakeConfig, postTicketMessage, listOrgs } = vi.hoisted(() => ({
  listSupportTickets: vi.fn(), getSupportTicket: vi.fn(), getIntakeConfig: vi.fn(), postTicketMessage: vi.fn(), listOrgs: vi.fn(),
}));
vi.mock('../serviceDeskClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listSupportTickets, getSupportTicket, getIntakeConfig, postTicketMessage,
}));
vi.mock('../../../client/accessClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs,
}));

import { SupportPage } from '../SupportPage.js';

const TICKET = {
  ticketId: 't1', subject: 'Login broken', status: 'open' as const, priority: 'high' as const,
  channel: 'email', messages: [{ messageId: 'm1', direction: 'inbound' as const, body: 'help', author: 'c@x.io', at: '2026-07-25T10:00:00Z' }],
  requester: 'c@x.io', createdAt: '2026-07-25T10:00:00Z', updatedAt: '2026-07-25T10:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  listSupportTickets.mockResolvedValue([TICKET]);
  getIntakeConfig.mockResolvedValue({ defaultOrgId: 'o1' });
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
    expect(postTicketMessage).toHaveBeenCalledWith('o1', 't1', 'para one\n\npara two', 'outbound');
  });
});
