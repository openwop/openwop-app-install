/**
 * ADR 1001 D7/D8 — an agent's chat question card.
 *
 * Why it exists: the chat lane reuses the run lane's card (one card system), so
 * these pin the chat wiring, not the card's own behaviour (that is
 * ClarificationDialog.agentAsk.test.tsx): the card shows under the agent's
 * LATEST turn only while its ask is unanswered; its answer goes to the
 * surface's `onAnswerClarification` with the ask id, the ask data and the spec
 * `ClarificationResume.answers` (`[]` = Skip); model text renders as text; and
 * the optimistic answer turn reads as the host persists it.
 *
 * Red when (sabotage-witnessed, recorded in the ADR 1001 P2 record and
 * re-measured in /grade-tests wave 80): the last-message guard is dropped (card
 * on a stale ask); the `answered` guard is dropped; the handler guard is
 * dropped; the answers are not unwrapped from the resume value; the ask id is
 * swapped for the message id; the skipped turn keeps the host's English; the
 * summary's boolean arm is flipped; the summary's final skip fallback is
 * dropped (answers that match no question).
 *
 * Double guard: an EMPTY answer list returns the skip line from two places
 * (the early `answers.length === 0` return and the final fallback), so
 * removing either one alone stays green.
 *
 * The markup-as-text case is card behaviour, and duplicates
 * `interrupts/__tests__/ClarificationDialog.agentAsk.test.tsx` "renders a
 * choice carrying markup as plain text" (the same `ClarificationQuestions`
 * renderer). It is kept because it is a security case; whether to dedupe is a
 * human ask (wave 80).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { MessageFeed } from '../MessageFeed.js';
import type { ChatMessage } from '../types.js';
import { clarificationAnswerSummary } from '../../interrupts/clarificationModel.js';
import { registerDefaultCards } from '../registry/defaultCards.js';

// The chat surface registers the card set at mount (ChatTab); do the same here.
registerDefaultCards();

const FEED = { tenantId: 't-test', onResolveInterrupt: async () => {}, onOpenWorkflowProgress: () => {}, focusedWorkflowMessageId: null };
const DATA = {
  questions: [
    { id: 'region', question: 'Which region?', schema: { type: 'string', enum: ['EMEA', '<img src=x onerror=alert(1)>'] } },
    { id: 'ok', question: 'Book now?', schema: { type: 'boolean' } },
  ],
};
const msg = (id: string, role: ChatMessage['role'], content: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id, role, content, createdAt: '2026-10-29T00:00:00.000Z', ...over,
});
const asked = (id: string, answered = false): ChatMessage =>
  msg(id, 'assistant', 'Which region? (EMEA / …)', { meta: { clarificationAsk: { askId: `wire-${id}`, data: DATA, ...(answered ? { answered: true } : {}) } } });

beforeEach(() => {
  cleanup();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('chat question card (ADR 1001 D7)', () => {
  it('renders under the latest agent turn, and answers with the ask id, data and answers', async () => {
    const onAnswer = vi.fn(async () => {});
    render(<MessageFeed {...FEED} messages={[msg('u1', 'user', 'plan'), asked('a1')]} onAnswerClarification={onAnswer} />);
    fireEvent.click(screen.getByRole('radio', { name: 'EMEA' }));
    fireEvent.click(screen.getByRole('radio', { name: 'clarifyYes' }));
    fireEvent.click(screen.getByRole('button', { name: 'interrupts:submitAnswer' }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    expect(onAnswer).toHaveBeenCalledWith('wire-a1', DATA, [{ id: 'region', answer: 'EMEA' }, { id: 'ok', answer: true }]);
  });

  it('Skip sends no answers', async () => {
    const onAnswer = vi.fn(async () => {});
    render(<MessageFeed {...FEED} messages={[asked('a1')]} onAnswerClarification={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'interrupts:clarifySkip' }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('wire-a1', DATA, []));
  });

  it('a choice that looks like markup renders as text', () => {
    render(<MessageFeed {...FEED} messages={[asked('a1')]} onAnswerClarification={async () => {}} />);
    expect(screen.getByRole('radio', { name: '<img src=x onerror=alert(1)>' })).toBeTruthy();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('no card once answered, on an ask the conversation moved past, or without a handler', () => {
    const { rerender } = render(<MessageFeed {...FEED} messages={[asked('a1', true)]} onAnswerClarification={async () => {}} />);
    expect(screen.queryByRole('button', { name: 'interrupts:clarifySkip' })).toBeNull();
    rerender(<MessageFeed {...FEED} messages={[asked('a1'), msg('u2', 'user', 'never mind')]} onAnswerClarification={async () => {}} />);
    expect(screen.queryByRole('button', { name: 'interrupts:clarifySkip' })).toBeNull();
    rerender(<MessageFeed {...FEED} messages={[asked('a1')]} />);
    expect(screen.queryByRole('button', { name: 'interrupts:clarifySkip' })).toBeNull();
    // Control: the same feed with a handler shows it.
    rerender(<MessageFeed {...FEED} messages={[asked('a1')]} onAnswerClarification={async () => {}} />);
    expect(screen.getByRole('button', { name: 'interrupts:clarifySkip' })).toBeTruthy();
  });
});

describe('a skipped answer turn (ADR 1001 D7)', () => {
  it('reads in the viewer\'s language, not the host\'s English fallback', () => {
    render(<MessageFeed {...FEED} messages={[msg('u1', 'user', 'I skipped your questions.', { meta: { clarificationSkipped: true } })]} />);
    expect(screen.getByText('clarifySkippedTurn')).toBeTruthy();
    expect(screen.queryByText('I skipped your questions.')).toBeNull();
  });
});

describe('clarificationAnswerSummary — the optimistic answer turn', () => {
  const data = DATA; // the chat ask's data, as the host records it (no profile)
  it('matches the host display: one line per answer, yes/no for booleans', () => {
    expect(clarificationAnswerSummary(data, [{ id: 'region', answer: 'EMEA' }, { id: 'ok', answer: false }], 'SKIP'))
      .toBe('Which region? EMEA\nBook now? no');
  });
  it('a Skip, or an ask it cannot read, is the localized skip line', () => {
    expect(clarificationAnswerSummary(data, [], 'SKIP')).toBe('SKIP');
    expect(clarificationAnswerSummary({ questions: 'x' }, [{ id: 'region', answer: 'EMEA' }], 'SKIP')).toBe('SKIP');
    expect(clarificationAnswerSummary(data, [{ id: 'nope', answer: 'EMEA' }], 'SKIP'), 'answers that match no question').toBe('SKIP');
  });
});
