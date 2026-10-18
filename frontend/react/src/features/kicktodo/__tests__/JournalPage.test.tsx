/**
 * KTP-4 — the Journal (ADR 0443 R5) had no test. It is the participant's own
 * record: newest-first entries grouped by calendar day, their note in their
 * own words, the measured value, and the challenge it belongs to. A failed
 * journal read is a stated failure with a working Retry — never the empty
 * "nothing here yet" state (failed ≠ empty).
 *
 * Mocked: the kicktodo client's `getJournal` + `listChallenges` reads.
 * Breaks if: entries stop rendering their note / measurement / challenge chip;
 * two entries on one day stop sharing ONE day group; the catch maps to the
 * empty state; or Retry stops re-reading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { getJournal, JournalEntry, listChallenges } from '../../../client/kicktodoClient.js';

const kt = vi.hoisted(() => ({
  getJournal: vi.fn<typeof getJournal>(),
  listChallenges: vi.fn<typeof listChallenges>(),
}));
vi.mock('../../../client/kicktodoClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...kt,
}));

import { JournalPage } from '../JournalPage.js';
import { messages as en } from '../i18n/en.js';

const entries: JournalEntry[] = [
  { cardId: 'c3', enrollmentId: 'e1', challengeId: 'chal:focus', note: 'Two calm hours.', createdAt: '2026-09-21T15:00:00Z' },
  { cardId: 'c2', enrollmentId: 'e1', challengeId: 'chal:focus', measuredValue: 42, createdAt: '2026-09-21T09:00:00Z' },
  { cardId: 'c1', enrollmentId: 'e1', challengeId: 'chal:focus', note: 'A slow start.', createdAt: '2026-09-19T12:00:00Z' },
];

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  kt.getJournal.mockResolvedValue(entries);
  kt.listChallenges.mockResolvedValue([{
    id: 'chal:focus', version: 1, status: 'published', title: 'Focus gently', summary: 's', outcome: 'o', durationDays: 14, activities: [],
  }]);
});
const mount = () => render(<MemoryRouter><JournalPage /></MemoryRouter>);

describe('JournalPage (ADR 0443 R5)', () => {
  it('renders each entry in the participant’s words, grouped by day', async () => {
    mount();
    expect(await screen.findByText('Two calm hours.')).toBeTruthy();
    expect(screen.getByText('A slow start.')).toBeTruthy();
    expect(screen.getByText(en.journalMeasured.replace('{{value}}', '42'))).toBeTruthy();
    // Three entries over TWO calendar days → two day groups (the diary shape).
    const groups = screen.getAllByRole('heading', { level: 2 });
    expect(groups).toHaveLength(2);
    const first = within(screen.getByRole('region', { name: groups[0]!.textContent ?? '' }));
    expect(first.getByText('Two calm hours.')).toBeTruthy();
    expect(first.getAllByText('Focus gently')).toHaveLength(2);
  });

  it('an empty journal is the designed empty state', async () => {
    kt.getJournal.mockResolvedValue([]);
    mount();
    expect(await screen.findByText(en.journalEmptyTitle)).toBeTruthy();
  });

  it('a failed read is a stated failure with a Retry that re-reads — never the empty state', async () => {
    kt.getJournal.mockRejectedValueOnce(new Error('503'));
    mount();
    expect(await screen.findByText(en.journalError)).toBeTruthy();
    expect(screen.queryByText(en.journalEmptyTitle)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Two calm hours.')).toBeTruthy();
    expect(screen.queryByText(en.journalError)).toBeNull();
    expect(kt.getJournal).toHaveBeenCalledTimes(2);
  });
});
