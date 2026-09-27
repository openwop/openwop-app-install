/**
 * KB-UX-3 / ADR 0583 — a retrieval whose SOURCE faulted is not an empty corpus.
 *
 * `agentKnowledgeComposition.ts` catches a KB or memory fault and contributes
 * nothing, so the run survives — correct for a live agent turn, and exactly
 * wrong for a human-facing preview: `{chunks:[], hasResults:false}` came back at
 * HTTP 200, the panel's `.catch` was unreachable for that whole class, and three
 * surfaces (`/profile` → Knowledge, every project's Knowledge tab, and the agent
 * workspace) rendered an internal error as the confident "No matches".
 *
 * The cure had to be SERVER-SIDE — the SPA cannot distinguish two identical 200s
 * — so the composition now reports `failedSources` and this panel renders it.
 * These tests pin the RENDERING half; `backend/typescript/test/
 * agent-knowledge-partial-retrieval.test.ts` pins the reporting half.
 *
 * Both polarities on every arm: an absent "No matches" proves nothing on its own
 * (a panel that rendered nothing would satisfy it), so each failure arm is
 * paired with the success arm that keeps the honest empty state reachable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

import { SubjectKnowledgePanel, type SubjectKnowledgeClient } from '../SubjectKnowledgePanel.js';

const copy = {
  intro: 'intro',
  emptyBody: 'empty',
  searchTitle: 'Search this knowledge',
  searchPlaceholder: 'Ask…',
};

const makeClient = (retrieve: SubjectKnowledgeClient['retrieve']): SubjectKnowledgeClient => ({
  getKnowledge: vi.fn().mockResolvedValue({ collections: [] }),
  listOrgs: vi.fn().mockResolvedValue([{ orgId: 'o1', name: 'Alpha' }]),
  createCollection: vi.fn(),
  unbindCollection: vi.fn(),
  ingestText: vi.fn(),
  deleteDocument: vi.fn(),
  retrieve,
});

const mountAndSearch = async (client: SubjectKnowledgeClient): Promise<void> => {
  render(<SubjectKnowledgePanel client={client} copy={copy} />);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText('Search this knowledge'), { target: { value: 'pto' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /search/i })); });
};

afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());

describe('KB-UX-3 — a faulted source is reported, not rendered as "no matches"', () => {
  it('a KB fault: the panel says the answer is incomplete and NEVER "No matches"', async () => {
    await mountAndSearch(makeClient(vi.fn().mockResolvedValue({ chunks: [], hasResults: false, failedSources: ['kb'] })));

    expect(screen.getByText(/could not be searched, so this answer is incomplete/i)).toBeTruthy();
    expect(screen.getByText(/Unsearched: documents/)).toBeTruthy();
    expect(screen.queryByText('No matches yet.')).toBeNull();
  });

  it('a GENUINELY empty corpus still says "No matches" (the other polarity)', async () => {
    await mountAndSearch(makeClient(vi.fn().mockResolvedValue({ chunks: [], hasResults: false, failedSources: [] })));

    expect(screen.getByText('No matches yet.')).toBeTruthy();
    expect(screen.queryByText(/could not be searched/i)).toBeNull();
  });

  it('a PARTIAL answer — some chunks AND a faulted source — shows both', async () => {
    await mountAndSearch(makeClient(vi.fn().mockResolvedValue({
      chunks: [{ content: 'a note that survived', kind: 'memory' }],
      hasResults: true,
      failedSources: ['kb'],
    })));

    expect(screen.getByText('a note that survived')).toBeTruthy();
    // Results ALONE would read as a complete answer; the qualifier is what
    // stops a partial retrieval passing for a whole one.
    expect(screen.getByText(/could not be searched, so this answer is incomplete/i)).toBeTruthy();
  });

  it('a thrown retrieve clears the previous answer instead of leaving it under the new query', async () => {
    const retrieve = vi.fn()
      .mockResolvedValueOnce({ chunks: [{ content: 'first answer', kind: 'kb', title: 'Doc' }], hasResults: true })
      .mockRejectedValueOnce(new Error('retrieve_500'));
    const client = makeClient(retrieve);
    render(<SubjectKnowledgePanel client={client} copy={copy} />);
    await act(async () => {});

    fireEvent.change(screen.getByLabelText('Search this knowledge'), { target: { value: 'one' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /search/i })); });
    expect(screen.getByText('first answer')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search this knowledge'), { target: { value: 'two' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /search/i })); });

    // The stale-claim family: the previous query's answer under the new question.
    expect(screen.queryByText('first answer')).toBeNull();
    expect(screen.queryByText('No matches yet.')).toBeNull();
    expect(screen.getByText('retrieve_500')).toBeTruthy();
  });
});
