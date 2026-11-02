/**
 * ADR 1018 D3 — the operator's read-only record of visitor conversations.
 *
 * Breaks if visitor text (attacker-controlled) is rendered as markup instead of text,
 * if a delete runs without the confirm or leaves the open transcript on screen, if the
 * list read is not scoped to THIS org + widget, or if the panel grows a composer (it is
 * a record, not a second chat — CLAUDE.md "one AI chat").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const { listConversations, getConversation, deleteConversation, confirmMock } = vi.hoisted(() => ({
  listConversations: vi.fn(), getConversation: vi.fn(), deleteConversation: vi.fn(), confirmMock: vi.fn(),
}));
vi.mock('../../../client/chatWidgetClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/chatWidgetClient.js')>()),
  listConversations, getConversation, deleteConversation,
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmMock }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { WidgetConversations } from '../WidgetConversations.js';
import type { Widget } from '../../../client/chatWidgetClient.js';

const W: Widget = { widgetId: 'w1', agentId: 'support', allowedDomains: ['acme.com'], caps: {}, token: 'wgt_abc', enabled: true };
const HOSTILE = '<img src=x onerror="window.__pwned=1">Do you ship?';
const SUMMARY = { threadId: 'a'.repeat(32), startedAt: '2026-10-31T10:00:00.000Z', updatedAt: '2026-10-31T10:05:00.000Z', messageCount: 2, preview: HOSTILE };

beforeEach(() => {
  for (const m of [listConversations, getConversation, deleteConversation, confirmMock]) m.mockReset();
  listConversations.mockResolvedValue([SUMMARY]);
  getConversation.mockImplementation(async (_o: string, _w: string, threadId: string) => ({
    threadId, startedAt: SUMMARY.startedAt, updatedAt: SUMMARY.updatedAt,
    messages: [{ role: 'visitor', text: HOSTILE, at: SUMMARY.startedAt }, { role: 'agent', text: 'Yes, worldwide.', at: SUMMARY.updatedAt }],
  }));
  deleteConversation.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('WidgetConversations (ADR 1018 D3)', () => {
  it('lists this widget\'s conversations and renders visitor text as TEXT, never markup', async () => {
    render(<WidgetConversations orgId="o1" widget={W} onClose={() => {}} />);
    expect(await screen.findByText(HOSTILE)).toBeTruthy();
    expect(listConversations).toHaveBeenCalledWith('o1', 'w1');
    fireEvent.click(screen.getByRole('button', { name: /^Open the conversation/ }));
    const log = await screen.findByRole('region', { name: /^Conversation started/ });
    expect(log.textContent).toContain(HOSTILE);
    expect(log.textContent).toContain('Yes, worldwide.');
    expect(document.querySelector('img')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    // A record, not a chat: nothing to type into.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('deletes only after the confirm, and closes the open transcript', async () => {
    render(<WidgetConversations orgId="o1" widget={W} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Open the conversation/ }));
    await screen.findByRole('region', { name: /^Conversation started/ });

    confirmMock.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: /^Delete the conversation/ }));
    await vi.waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(deleteConversation).not.toHaveBeenCalled();

    confirmMock.mockResolvedValueOnce(true);
    listConversations.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole('button', { name: /^Delete the conversation/ }));
    await vi.waitFor(() => expect(deleteConversation).toHaveBeenCalledWith('o1', 'w1', SUMMARY.threadId));
    expect(await screen.findByText('No conversations yet.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /^Conversation started/ })).toBeNull();
  });
});
