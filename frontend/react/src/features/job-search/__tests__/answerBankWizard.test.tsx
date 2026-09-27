/**
 * ADR 0545 D2/P2 — the setup wizard.
 *
 * D2's premise is about attention, not data: ~20 questions once is not toil, one
 * question forty times is. So the properties worth pinning are the ones that
 * make the screen finishable AND abandonable — the coverage number comes from
 * the server rather than the UI, stopping early is stated as safe, and a refusal
 * is explained rather than reported as a failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const QUESTIONS = [
  { key: 'work-auth.legally-authorised', prompt: 'Are you legally allowed to work in the country you are applying in?', kind: 'boolean', why: 'Almost every application asks this, and it is required on all four boards.', core: true },
  { key: 'compensation.expectation', prompt: 'What compensation are you looking for?', kind: 'money', why: 'The question people most dread being asked repeatedly. Answer it once.', core: true },
  { key: 'links.linkedin', prompt: 'Your LinkedIn profile', kind: 'url', why: 'A required field on many forms, and trivially reusable.', core: false },
];

const EMPTY_BANK = () => ({
  questions: QUESTIONS,
  coreKeys: ['work-auth.legally-authorised', 'compensation.expectation'],
  answers: [] as unknown[],
  coverage: { ratio: 0, totalCovered: 0, totalRequired: 21, totalDeclined: 1 },
});
const getBank = vi.fn(async () => EMPTY_BANK());
const save = vi.fn(async () => ({ kind: 'saved' as const }));

vi.mock('../jobSearchClient.js', () => ({
  getAnswerBank: (...a: unknown[]) => getBank(...(a as [])),
  saveAnswer: (...a: unknown[]) => save(...(a as [])),
}));

import { AnswerBankPage } from '../AnswerBankPage.js';

describe('JSUX-AUTO-1 — the explicit done state', () => {
  beforeEach(() => {
    getBank.mockReset(); save.mockReset();
    save.mockImplementation(async () => ({ kind: 'saved' as const }));
  });
  afterEach(cleanup);

  it('at full coverage the wizard acknowledges completion and drops the stop-any-time note', async () => {
    getBank.mockImplementation(async () => ({
      ...EMPTY_BANK(),
      answers: QUESTIONS.map((q) => ({ questionKey: q.key, value: 'x' })),
      coverage: { ratio: 1, totalCovered: 21, totalRequired: 21, totalDeclined: 0 },
    }));
    render(<AnswerBankPage />);
    await screen.findByText(/All questions answered/i);
    expect(screen.queryByText(/You can stop any time/i)).toBeNull();
  });

  it('below full coverage the stop-any-time note stays and no done banner shows', async () => {
    getBank.mockImplementation(async () => ({
      ...EMPTY_BANK(),
      answers: [{ questionKey: QUESTIONS[0]!.key, value: 'x' }],
      coverage: { ratio: 0.3, totalCovered: 6, totalRequired: 21, totalDeclined: 0 },
    }));
    render(<AnswerBankPage />);
    await screen.findByText(/You can stop any time/i);
    expect(screen.queryByText(/All questions answered/i)).toBeNull();
  });
});

describe('the answer-bank wizard', () => {
  // mockRESET, not mockClear: `mockClear` keeps the IMPLEMENTATION, so a mock
  // installed by one test leaks into the next. That is not hypothetical — it
  // made the "nothing answered yet" case read the previous test's answered bank
  // and fail for a reason that had nothing to do with the code.
  beforeEach(() => {
    getBank.mockReset(); save.mockReset();
    getBank.mockImplementation(async () => EMPTY_BANK());
    save.mockImplementation(async () => ({ kind: 'saved' as const }));
  });
  afterEach(cleanup);

  it('states that stopping early is safe, and why', async () => {
    // Abandonability is a design requirement, not a courtesy: an unanswered
    // question parks ONE application (D3) rather than stalling a campaign, and
    // the user cannot know that unless it is said.
    render(<AnswerBankPage />);
    expect(await screen.findByText(/stop any time/i)).toBeTruthy();
    expect(screen.getByText(/do not block a campaign/i)).toBeTruthy();
  });

  it('shows the coverage number the SERVER computed, not one the UI invented', async () => {
    getBank.mockImplementation(async () => ({
      questions: QUESTIONS, coreKeys: [],
      answers: [{ questionKey: 'compensation.expectation', questionText: 'q', value: '$180,000', source: 'user', confirmedAt: 'x', usageCount: 0 }],
      coverage: { ratio: 0.67, totalCovered: 14, totalRequired: 21, totalDeclined: 1 },
    }));
    render(<AnswerBankPage />);
    expect(await screen.findByText(/67%/)).toBeTruthy();
    // …and the count, which is what makes the percentage legible.
    expect(screen.getByText(/1 of 3 answered/i)).toBeTruthy();
  });

  it('says nothing about coverage before anything is answered', async () => {
    // "0%" as an opening state reads as failure rather than as a starting point.
    render(<AnswerBankPage />);
    expect(await screen.findByText(/nothing answered yet/i)).toBeTruthy();
    expect(screen.queryByText(/0%/)).toBeNull();
  });

  it('explains that voluntary self-identification answers are never stored', async () => {
    // None of these questions appear in the bank, so without this the user is
    // left wondering whether we answered on their behalf.
    render(<AnswerBankPage />);
    expect(await screen.findByText(/never stored here/i)).toBeTruthy();
    expect(screen.getByText(/decline to self-identify/i)).toBeTruthy();
  });

  it('answers a yes/no question with two real buttons, not a checkbox', async () => {
    // An unticked checkbox cannot distinguish "no" from "not answered", which is
    // the exact distinction the bank depends on.
    render(<AnswerBankPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^no$/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]).toEqual([
      'Are you legally allowed to work in the country you are applying in?', 'No',
    ]);
  });

  it('explains a REFUSAL with the server’s reason, not as a save failure', async () => {
    save.mockImplementation(async () => ({
      kind: 'refused', reason: 'special-category',
      message: 'This system does not store voluntary self-identification answers. Applications answer “decline to self-identify”.',
    }) as never);
    render(<AnswerBankPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^yes$/i }));
    expect(await screen.findByText(/does not store voluntary self-identification/i)).toBeTruthy();
    expect(screen.queryByText(/could not save/i), 'a refusal is not a failure').toBeNull();
  });

  it('reports a transport failure as one — it did not reject the answer', async () => {
    save.mockImplementation(async () => ({ kind: 'failed' }) as never);
    render(<AnswerBankPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^yes$/i }));
    expect(await screen.findByText(/could not save that answer/i)).toBeTruthy();
  });

  it('a failed READ offers a retry rather than an empty bank', async () => {
    // An empty question list would read as "there is nothing to answer", which
    // is a different and wrong statement.
    getBank.mockImplementation(async () => { throw new Error('down'); });
    render(<AnswerBankPage />);
    expect(await screen.findByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.queryByText(/nothing answered yet/i)).toBeNull();
  });
});

describe('JSUX-A11Y-2 (R3) — selection is carried non-visually, not by variant alone', () => {
  it('the answered boolean carries aria-pressed=true and its sibling false', async () => {
    getBank.mockImplementation(async () => ({
      ...EMPTY_BANK(),
      answers: [{ questionKey: 'work-auth.legally-authorised', value: 'Yes' }],
    }));
    render(<AnswerBankPage />);
    const yes = await screen.findByRole('button', { name: 'Yes', pressed: true });
    expect(yes).toBeTruthy();
    expect(screen.getByRole('button', { name: 'No' }).getAttribute('aria-pressed')).toBe('false');
  });
});
