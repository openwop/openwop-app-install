/**
 * PT-6 — the participant forms use the shared `ui/Field` primitives, which
 * associate every label with its control EXPLICITLY (`<label for>` ↔ `id`).
 * The evidence inputs on Today and the Discover filter selects were wrapped in
 * a bare `<label>` (implicit association only — the pattern
 * jsx-a11y/label-has-associated-control flags and some assistive tech misses).
 *
 * Breaks if TheOneThing's evidence inputs (note, photo, measurement) or any of
 * Discover's search + four filter selects (time, duration, depth, language) go back
 * to a hand-rolled wrapping `<label>` (no `for`/`id` pair, no `.field-label`).
 * Mocked: the kicktodo client's anonymous catalog read (Discover) only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as KickTodoClient from '../../../client/kicktodoClient.js';
import type { ChallengeSummary, TodayAction } from '../../../client/kicktodoClient.js';

vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: null, loading: false }) }));
// FIVE challenges, one with a depth: Discover renders the depth select only past
// four challenges when some carry `depthLevel` (so "every filter select" is all four).
const catalog = vi.hoisted((): ChallengeSummary[] => [1, 2, 3, 4, 5].map((n) => ({
  id: `chal:${n}`, version: 1, status: 'published', title: `Challenge ${n}`, summary: 's', outcome: 'o', durationDays: 7 * n,
  ...(n === 1 ? { depthLevel: 'beginner' as const } : {}),
  activities: [{ stableActivityId: 'a', day: 1, title: 'Step', instructions: 'Go.', estimatedMinutes: 10, evidencePolicy: 'attestation' }],
})));
vi.mock('../../../client/kicktodoClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof KickTodoClient>()),
  publicChallengeCatalog: vi.fn<typeof KickTodoClient.publicChallengeCatalog>(async () => catalog),
  recommendedChallenges: vi.fn<typeof KickTodoClient.recommendedChallenges>(async () => []),
}));

import { ActionCompleter } from '../TheOneThing.js';
import { DiscoverPage } from '../DiscoverPage.js';
import { messages as en } from '../i18n/en.js';

afterEach(cleanup);

/** The control's label is a `.field-label` pointing at it by id. */
const explicitlyLabelled = (control: HTMLElement, label: string): void => {
  expect(control.id).not.toBe('');
  const el = document.querySelector<HTMLLabelElement>(`label[for="${control.id}"]`);
  expect(el).not.toBeNull();
  expect(el?.className).toContain('field-label');
  expect(el?.textContent).toBe(label);
};

const action = (evidencePolicy: TodayAction['occurrence']['evidencePolicy']): TodayAction => ({
  occurrence: { cardId: 'c1', stableActivityId: 'a1', occurrenceDateLocal: '2026-07-19', evidencePolicy },
  card: { id: 'c1', title: 'Do the thing', columnId: 'todo', completed: false },
  checkIn: null,
});

describe('PT-6 — Field primitives', () => {
  it('Today: the note and measurement evidence inputs are explicitly labelled', () => {
    render(<ActionCompleter action={action('note')} busy={false} onComplete={() => {}} />);
    explicitlyLabelled(screen.getByRole('textbox', { name: en.evidenceNoteLabel }), en.evidenceNoteLabel);
    cleanup();
    render(<ActionCompleter action={action('measurement')} busy={false} onComplete={() => {}} />);
    explicitlyLabelled(screen.getByRole('spinbutton', { name: en.evidenceMeasurementLabel }), en.evidenceMeasurementLabel);
    cleanup();
    render(<ActionCompleter action={action('photo')} busy={false} onComplete={() => {}} />);
    explicitlyLabelled(screen.getByRole('textbox', { name: en.evidencePhotoLabel }), en.evidencePhotoLabel);
  });

  it('Discover: the search and every filter select are explicitly labelled', async () => {
    render(<MemoryRouter><DiscoverPage /></MemoryRouter>);
    await waitFor(() => screen.getByRole('heading', { name: 'Challenge 1' }));
    explicitlyLabelled(screen.getByRole('searchbox', { name: en.discoverSearchLabel }), en.discoverSearchLabel);
    for (const label of [en.discoverTimeBudgetLabel, en.discoverDurationBudgetLabel, en.depthFilterLabel, en.contentLocaleLabel]) {
      explicitlyLabelled(screen.getByRole('combobox', { name: label }), label);
    }
  });
});
