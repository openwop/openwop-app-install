/**
 * EMPTY-ON-FAIL-2 (ADR 0779 D7, the RTP-EMPTY-1 class) — a failed transcript read is
 * NOT an empty conversation, in EITHER compare pane.
 *
 * Each pane's catch set its messages to [], so the pane rendered the empty-transcript
 * "—" with no error: a conversation that could not be read looked like one with no
 * messages. Each pane now keeps its own failed flag and a Retry.
 *
 * Break it by dropping the `leftFailed ?` (left case) or `rightId && rightFailed ?`
 * (right case) branch in CompareView, or by restoring `setLeft([])` /
 * `setRight([])` in the catches with the flags ignored; a no-op right-pane Retry
 * reds the right-pane Retry case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessagePersisted, ChatSessionHeader } from '../../client/chatSessionsClient.js';

const listChatSessions = vi.fn<() => Promise<ChatSessionHeader[]>>();
const listChatSessionMessages = vi.fn<(sessionId: string) => Promise<ChatMessagePersisted[]>>();
vi.mock('../../client/chatSessionsClient.js', () => ({
  listChatSessions: () => listChatSessions(),
  listChatSessionMessages: (sessionId: string) => listChatSessionMessages(sessionId),
}));

const { CompareView } = await import('../CompareView.js');

const hdr = (sessionId: string, title: string): ChatSessionHeader =>
  ({ sessionId, tenantId: 't', title, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 1 });
const msg = (messageId: string, content: string): ChatMessagePersisted =>
  ({ messageId, sessionId: 's', role: 'user', content, meta: null, createdAt: '2026-01-01T00:00:00.000Z' });

const FAILED = 'Could not load this';
const EMPTY_PANE = '—';

beforeEach(() => {
  listChatSessions.mockReset();
  listChatSessionMessages.mockReset();
  listChatSessions.mockResolvedValue([hdr('cur', 'Current'), hdr('other', 'Other chat')]);
});
afterEach(cleanup);

describe('EMPTY-ON-FAIL-2 — a failed transcript read is not an empty pane', () => {
  it('left pane: a rejected read of THIS conversation shows the failure, not the empty "—"', async () => {
    listChatSessionMessages.mockRejectedValue(new Error('messages_500'));
    render(<CompareView currentSessionId="cur" onClose={() => undefined} />);
    expect(await screen.findByText(FAILED)).toBeTruthy();
    expect(screen.queryByText(EMPTY_PANE)).toBeNull();
  });

  it('left pane: Retry re-reads and renders the transcript', async () => {
    listChatSessionMessages.mockRejectedValueOnce(new Error('messages_500')).mockResolvedValue([msg('m1', 'hello left')]);
    render(<CompareView currentSessionId="cur" onClose={() => undefined} />);
    await screen.findByText(FAILED);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('hello left')).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it('right pane: a rejected read of the PICKED conversation shows the failure, not the empty "—"', async () => {
    listChatSessionMessages.mockImplementation((id) =>
      (id === 'other' ? Promise.reject(new Error('messages_500')) : Promise.resolve([msg('m1', 'hello left')])));
    render(<CompareView currentSessionId="cur" onClose={() => undefined} />);
    await screen.findByText('hello left');
    fireEvent.change(screen.getByLabelText('Compare with'), { target: { value: 'other' } });
    expect(await screen.findByText(FAILED)).toBeTruthy();
    expect(screen.queryByText(EMPTY_PANE)).toBeNull();
  });

  it('right pane: Retry re-reads ONLY the picked conversation and renders it', async () => {
    let otherCalls = 0;
    listChatSessionMessages.mockImplementation((id) => {
      if (id !== 'other') return Promise.resolve([msg('m1', 'hello left')]);
      otherCalls += 1;
      return otherCalls === 1 ? Promise.reject(new Error('messages_500')) : Promise.resolve([msg('m2', 'hello right')]);
    });
    render(<CompareView currentSessionId="cur" onClose={() => undefined} />);
    await screen.findByText('hello left');
    fireEvent.change(screen.getByLabelText('Compare with'), { target: { value: 'other' } });
    await screen.findByText(FAILED);
    const leftReads = listChatSessionMessages.mock.calls.filter(([id]) => id === 'cur').length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('hello right')).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(otherCalls).toBe(2);
    expect(listChatSessionMessages.mock.calls.filter(([id]) => id === 'cur').length).toBe(leftReads); // left not re-read
  });

  it('a successful EMPTY read still renders the empty "—" pane (positive control)', async () => {
    listChatSessionMessages.mockResolvedValue([]);
    render(<CompareView currentSessionId="cur" onClose={() => undefined} />);
    expect(await screen.findByText(EMPTY_PANE)).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
  });
});
