/**
 * ADR 0768 P3 — live status (running) on tabs + rows, the `@@` board chip, and
 * reply duration derived from the conversation log's own turn timestamps.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { count?: unknown }) => (o && o.count !== undefined ? `${k}:${String(o.count)}` : k),
  }),
}));
vi.mock('../AgentMentionAutocomplete.js', () => ({ AgentMentionAutocomplete: () => null }));
vi.mock('../SlashAutocomplete.js', () => ({ SlashAutocomplete: () => null }));
vi.mock('../BoardMentionAutocomplete.js', () => ({ BoardMentionAutocomplete: () => null }));
vi.mock('../lib/workflowMentions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workflowMentions.js')>()),
  refreshWorkflowMentionCache: vi.fn(async () => undefined),
}));

import type { ChatMessage, WorkflowRunState } from '../types.js';
import { computeTabBadge, deriveActivity } from '../tabDeck/useTabBadges.js';
import { turnsToBubbles } from '../conversationTransport.js';
import type { ConversationTurn } from '../conversationClient.js';
import { TurnReceipt } from '../TurnReceipt.js';
import { ChatInput } from '../ChatInput.js';

const msg = (over: Partial<ChatMessage>): ChatMessage => ({ id: 'm', role: 'assistant', content: 'x', ...over } as ChatMessage);

describe('running tab state', () => {
  it('a pending/running workflow run marks the tab running', () => {
    const run = msg({ id: 'r', role: 'workflow_run', workflowRun: { status: 'running' } as WorkflowRunState });
    expect(deriveActivity([run], false).running).toBe(true);
    expect(deriveActivity([msg({})], true).running).toBe(true);
    expect(deriveActivity([msg({})], false).running).toBe(false);
  });

  it('ranks blocked > running > unread, and never badges the active tab', () => {
    expect(computeTabBadge(false, 'a', null, true, true)).toEqual({ unread: false, blocked: true });
    expect(computeTabBadge(false, 'a', null, false, true)).toEqual({ unread: false, blocked: false, running: true });
    expect(computeTabBadge(false, 'a', null, false, false)).toEqual({ unread: true, blocked: false });
    expect(computeTabBadge(true, 'a', null, true, true)).toEqual({ unread: false, blocked: false });
  });

  it('leaves pre-P3 callers (no running arg) byte-identical', () => {
    expect(computeTabBadge(false, 'a', 'a', false)).toEqual({ unread: false, blocked: false });
  });
});

describe('reply duration from the conversation log', () => {
  const turn = (over: Partial<ConversationTurn>): ConversationTurn => ({
    messageId: 'id', from: 'assistant', content: 'hi', ts: 0, role: 'agent', turnIndex: 0, ...over,
  });

  it('is the agent turn ts minus the preceding user turn ts', () => {
    const bubbles = turnsToBubbles([
      turn({ messageId: 'u1', role: 'user', from: 'user', ts: 1_000 }),
      turn({ messageId: 'a1', ts: 39_000 }),
    ]);
    expect(bubbles[1]).toMatchObject({ id: 'a1', replyMs: 38_000 });
  });

  it('is absent without a preceding user turn or when out of order', () => {
    expect(turnsToBubbles([turn({ messageId: 'a0', ts: 5 })])[0]?.replyMs).toBeUndefined();
    const b = turnsToBubbles([turn({ messageId: 'u', role: 'user', ts: 9_000 }), turn({ messageId: 'a', ts: 1_000 })]);
    expect(b[1]?.replyMs).toBeUndefined();
  });

  it('the receipt states it once the turn settles, and not while streaming', () => {
    const { rerender } = render(<TurnReceipt message={msg({ replyMs: 1_500, isStreaming: true })} />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<TurnReceipt message={msg({ replyMs: 1_500 })} />);
    expect(screen.getByRole('button').textContent).toMatch(/1\.5/);
  });
});

describe('@@ board chip', () => {
  const textarea = () => screen.getByRole('combobox', { name: 'composerAriaLabel' }) as HTMLTextAreaElement;

  it('seeds `@@` at the caret when the host enables it (Boards of Advisors on)', async () => {
    render(<ChatInput onSend={vi.fn()} boardSigil />);
    fireEvent.change(textarea(), { target: { value: 'ask', selectionStart: 3 } });
    fireEvent.click(screen.getByRole('button', { name: 'sigilBoardAria' }));
    await waitFor(() => expect(textarea().value).toBe('ask @@'));
  });

  it('is absent unless the host enables it', () => {
    render(<ChatInput onSend={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'sigilBoardAria' })).toBeNull();
  });
});
