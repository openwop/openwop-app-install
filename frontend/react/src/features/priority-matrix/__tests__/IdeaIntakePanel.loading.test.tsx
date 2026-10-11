/**
 * IdeaIntakePanel loading regression (STRATUX-2) — the intake form fields
 * initialize FROM the fetch, so they MUST NOT render editable before it
 * resolves (a fast typist's input would be clobbered on load). This locks the
 * designed loading state: fields appear only after the intake fetch settles,
 * initialized from what it returned.
 *
 * Sabotage-witnessed (w15): `!loaded ?` → `false ?` reds the pre-load absence;
 * dropping `setLoaded(true)` reds the post-load form; dropping the
 * `setRequester(r.intake?.requester …)` init reds the initialized value.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import type { IdeaIntake, RankedIdea } from '../priorityMatrixClient.js';

let resolveIntake: (v: { intake: IdeaIntake | null; evidence: [] }) => void;
vi.mock('../priorityMatrixClient.js', () => ({
  getIdeaIntake: vi.fn(() => new Promise((res) => { resolveIntake = res as typeof resolveIntake; })),
  getIdeaScoreHistory: vi.fn(() => new Promise(() => { /* never resolves — the section is fail-soft */ })),
  patchIdeaIntake: vi.fn(),
  addIdeaEvidence: vi.fn(),
  removeIdeaEvidence: vi.fn(),
  mergeIdea: vi.fn(),
  promoteIdeaToProject: vi.fn(),
}));
import { IdeaIntakePanel } from '../IdeaIntakePanel.js';

afterEach(cleanup);

const idea: RankedIdea = {
  card: { id: 'card-1', title: 'Expand to EU', columnId: 'new' },
  status: { columnId: 'new', columnName: 'New', terminal: false },
  scores: {}, computedPriority: 0, rank: 1,
  completeness: { declared: 0, scored: 0, missing: [], complete: true },
};

describe('IdeaIntakePanel — loading regression (STRATUX-2)', () => {
  it('holds the intake form until the fetch resolves (no pre-load editable fields)', async () => {
    render(<IdeaIntakePanel listId="l1" idea={idea} others={[]} onClose={() => {}} onChanged={() => {}} />);

    // While the intake fetch is pending, the editable Requester field is absent —
    // the loading state is shown instead.
    expect(screen.queryByLabelText('Requester')).toBeNull();
    expect(screen.getByText('Loading…')).toBeTruthy();

    // Resolve the fetch: the form (Requester field) now renders, initialized FROM it.
    resolveIntake({
      intake: { listId: 'l1', cardId: 'card-1', requester: 'Ada Lovelace', updatedBy: 'u1', updatedAt: '2026-07-01T00:00:00.000Z' },
      evidence: [],
    });
    await waitFor(() => expect((screen.getByLabelText('Requester') as HTMLInputElement).value).toBe('Ada Lovelace'));
    expect(screen.queryByText('Loading…')).toBeNull();
  });
});
