/**
 * ADR 1003 D5 — a reply composed from a windowed transcript says so.
 *
 * Before this, only the MODEL was told that earlier turns were left out (a line
 * in its system message). This pins the human half: a settled assistant reply
 * whose meta carries `contextOmittedTurns` shows one quiet note with the count;
 * a streaming reply, a user message, and a reply without the count show none.
 *
 * Sabotage (witnessed 2026-10-29): removing the note from `MessageBubble.tsx`
 * reds the first case; dropping the `!isUser` / `!isStreaming` guard reds the
 * second.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { count?: number }) => (o?.count !== undefined ? `${k}:${o.count}` : k) }) }));

import { MessageFeed } from '../MessageFeed.js';
import type { ChatMessage } from '../types.js';

const FEED = { tenantId: 't-test', onResolveInterrupt: async () => {}, onOpenWorkflowProgress: () => {}, focusedWorkflowMessageId: null };
const msg = (over: Partial<ChatMessage>): ChatMessage => ({ id: 'm', role: 'assistant', content: 'reply', createdAt: '2026-10-29T10:00:00.000Z', ...over });

beforeEach(() => {
  cleanup();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('ADR 1003 D5 — context-budgeted note', () => {
  it('a settled reply with an omitted-turn count shows the note with the count', () => {
    render(<MessageFeed {...FEED} messages={[msg({ meta: { contextOmittedTurns: 6 } })]} />);
    expect(screen.getByText('contextBudgetedNotice:6')).toBeTruthy();
    expect(screen.getByText('contextBudgetedNotice:6').getAttribute('role')).toBe('note');
  });

  it('no note while streaming, on a user message, or without a count', () => {
    render(<MessageFeed {...FEED} messages={[
      msg({ id: 'a', isStreaming: true, meta: { contextOmittedTurns: 6 } }),
      msg({ id: 'b', role: 'user', meta: { contextOmittedTurns: 6 } }),
      msg({ id: 'c' }),
    ]} />);
    expect(screen.queryByText(/contextBudgetedNotice/)).toBeNull();
  });
});
