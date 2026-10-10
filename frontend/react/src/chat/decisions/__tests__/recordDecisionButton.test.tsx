/**
 * ADR 0853 D2 — the message action is WIRED: with `onRecordDecision`, every
 * message (own and others') in a multi-party feed carries "Record as decision"
 * and clicking it hands that message over; without it, no button.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { MessageFeed } from '../../MessageFeed.js';
import type { ChatMessage } from '../../types.js';

const msg = (id: string, role: ChatMessage['role'], content: string, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role, content, createdAt: '2026-10-07T00:00:00.000Z', ...over } as ChatMessage);
const actions = { onToggleReaction: () => {}, onEdit: () => {}, onDelete: () => {} };
const directory = new Map([['user:alice', { displayName: 'Alice', kind: 'user' as const }], ['user:bob', { displayName: 'Bob', kind: 'user' as const }]]);
const base = { tenantId: 't', onResolveInterrupt: vi.fn(), onOpenWorkflowProgress: vi.fn(), focusedWorkflowMessageId: null };

beforeEach(() => { cleanup(); window.HTMLElement.prototype.scrollIntoView = vi.fn(); });

describe('Record as decision — the message action', () => {
  it("is on others' and own messages and hands over the clicked message", () => {
    const onRecord = vi.fn();
    render(<MessageFeed {...base} messages={[
      msg('m1', 'user', 'We ship EU first', { authorSubject: 'user:alice' }),
      msg('m2', 'user', 'Agreed', { authorSubject: 'user:bob' }),
    ]} authorDirectory={directory} viewerSubjectRef="user:bob" messageActions={actions} onRecordDecision={onRecord} />);
    const buttons = screen.getAllByText('recordAsDecision');
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
  });

  it('no button without the handler', () => {
    render(<MessageFeed {...base} messages={[msg('m1', 'user', 'x', { authorSubject: 'user:alice' })]} authorDirectory={directory} viewerSubjectRef="user:bob" messageActions={actions} />);
    expect(screen.queryByText('recordAsDecision')).toBeNull();
  });
});
