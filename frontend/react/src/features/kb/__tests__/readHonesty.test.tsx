/**
 * Knowledge Base — a failed read never borrows an empty read's meaning.
 *
 * `features/kb/` had ZERO frontend tests (`KB-UX-16`), which is why `KB-UX-1`,
 * `KB-UX-2` and `KB-UX-4` could all ship at once: each of the three is invisible
 * to a typecheck and to a build gate, and each renders a CONFIDENT FALSE CLAIM
 * rather than an error, so nothing about it looks wrong in a screenshot either.
 *
 * Every assertion here is BOTH-POLARITY. An "absent" assertion on its own is
 * vacuous — a page that rendered nothing at all would satisfy "no `No matches`
 * on screen" — so each failure case is paired with the success case that proves
 * the honest branch still exists and is reachable.
 *
 * The one that needed the most care is the RETRY. This repo has reintroduced,
 * three times in one week, a "fix" that clears the failure flag while stale
 * empty data remains: for the frame between the retry click and the settle, the
 * false-empty state is back on screen. `runSearch` and `reloadDocs` clear the
 * DATA and the FLAG together.
 *
 * CORRECTED 2026-08-18 — this docblock used to say "the tests below assert the
 * DOM *between* the click and the resolve", present tense, plural. Only ONE
 * does: the search-retry arm, via a hand-resolved deferred promise. The other
 * retries settle under `waitFor`, which by construction skips straight past the
 * frame that holds this bug — so for those the between-frames property is NOT
 * witnessed here. Stated plainly rather than left as a claim the file does not
 * keep: "all of the tests assert X" is exactly the kind of sentence a later
 * reader trusts instead of re-deriving.
 *
 * A third path is protected by something else entirely. `useOrgSelection`'s
 * retry (`ui/useOrgSelection.ts:113`) bumps `reload` ONLY — it clears neither
 * `orgs` nor `orgsFailed`. It is still safe, because `ui/OrgSelectionState`
 * branches FAILED-FIRST, so the stale failure flag holds the failure state on
 * screen. Branch order, not the clearing mechanism, is what protects it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(),
  listCollections: vi.fn(),
  listDocuments: vi.fn(),
  search: vi.fn(),
  startReindex: vi.fn(),
  drainReindex: vi.fn(),
  getReindexJob: vi.fn(),
  cancelReindex: vi.fn(),
}));
vi.mock('../kbClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../kbClient.js')>();
  return { ...orig, ...api };
});

// The Drive-sync panel does its own gated fetch; stub it so this file stays
// about the KB page's own reads.
vi.mock('../../knowledge-sync/KnowledgeSyncPanel.js', () => ({
  KnowledgeSyncPanel: () => <div data-testid="sync-panel" />,
}));
vi.mock('../../media/mediaClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listCollections: vi.fn(async () => []) };
});

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: toasts }));

// KBX-1 / KBX-7 — Start and Discard are now gated behind `ui/confirm`. This file
// is about read honesty, not about the gates (those are pinned in
// `reindexLifecycle.test.tsx`), so it answers yes and stays on its own subject.
const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmMock }));

import { KnowledgeBasePage } from '../KnowledgeBasePage.js';

const ORG = { orgId: 'o1', name: 'Acme' };
const COLLECTION = {
  collectionId: 'c1', name: 'HR Policies', documentCount: 1, chunkCount: 3,
  updatedAt: '2026-08-18T00:00:00.000Z',
};

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: the *Once queues survive a clear, and a
  // leftover queued response silently answers the NEXT test (observed).
  vi.resetAllMocks();
  window.history.replaceState({}, '', '/kb');
  api.listOrgs.mockResolvedValue([ORG]);
  api.listCollections.mockResolvedValue([COLLECTION]);
  api.listDocuments.mockResolvedValue([]);
  api.getReindexJob.mockResolvedValue(null);
  confirmMock.mockResolvedValue(true);
});
afterEach(cleanup);

const view = (path = '/kb?org=o1&collection=c1'): void => {
  window.history.replaceState({}, '', path);
  render(<MemoryRouter initialEntries={[path]}><KnowledgeBasePage /></MemoryRouter>);
};

/** A promise the test resolves by hand, so the in-flight FRAME is observable. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/* ─── KB-UX-1: search ──────────────────────────────────────────── */

describe('KB-UX-1 — a failed search does not render the previous answer', () => {
  it('a search that FAILS after a successful EMPTY one must not re-render "No matches"', async () => {
    api.search.mockResolvedValueOnce([]);
    view();

    fireEvent.change(await screen.findByLabelText('Ask a question…'), { target: { value: 'pto' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    // The honest empty state exists and is reachable — the positive control
    // without which the absence below proves nothing.
    expect(await screen.findByText('No matches — add documents, or try a different question.')).toBeTruthy();

    api.search.mockRejectedValueOnce(new Error('search_500'));
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));

    expect(await screen.findByText('Search failed')).toBeTruthy();
    expect(screen.queryByText('No matches — add documents, or try a different question.')).toBeNull();
    expect(screen.getByText(/Nothing was searched for/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('a search that FAILS after a successful NON-EMPTY one must not leave the old hits on screen', async () => {
    api.search.mockResolvedValueOnce([
      { chunkId: 'k1', documentId: 'd1', title: 'PTO Policy', chunkIndex: 0, text: '15 days of PTO', score: 0.9 },
    ]);
    view();

    fireEvent.change(await screen.findByLabelText('Ask a question…'), { target: { value: 'pto' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    expect(await screen.findByText('15 days of PTO')).toBeTruthy();

    api.search.mockRejectedValueOnce(new Error('search_500'));
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));

    expect(await screen.findByText('Search failed')).toBeTruthy();
    // The previous query's answer, under the new question, was the whole defect.
    expect(screen.queryByText('15 days of PTO')).toBeNull();
  });

  it('the RETRY frame shows neither the stale hits nor "No matches" while it is in flight', async () => {
    api.search.mockResolvedValueOnce([]);
    view();
    fireEvent.change(await screen.findByLabelText('Ask a question…'), { target: { value: 'pto' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    expect(await screen.findByText('No matches — add documents, or try a different question.')).toBeTruthy();

    api.search.mockRejectedValueOnce(new Error('search_500'));
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await screen.findByText('Search failed');

    // Retry, and HOLD the request open. This is the frame the "clear the flag
    // but keep the data" fix re-broke three times.
    const pending = deferred<unknown[]>();
    api.search.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(screen.queryByText('No matches — add documents, or try a different question.')).toBeNull();
    expect(screen.queryByText('Search failed')).toBeNull();

    await act(async () => { pending.resolve([]); await pending.promise; });
    // …and it terminates honestly once the read actually answers.
    expect(await screen.findByText('No matches — add documents, or try a different question.')).toBeTruthy();
  });

  it('an absent score renders an em-dash, not a confident 0.000 (KB-UX-14)', async () => {
    api.search.mockResolvedValueOnce([
      // The wire may omit `score`; the client type says otherwise, which is why
      // the page's `h.score ?? 0` looked safe and fabricated a number instead.
      { chunkId: 'k1', documentId: 'd1', title: 'PTO Policy', chunkIndex: 0, text: 'unscored passage' },
      { chunkId: 'k2', documentId: 'd1', title: 'PTO Policy', chunkIndex: 1, text: 'scored passage', score: 0.812 },
    ]);
    view();
    fireEvent.change(await screen.findByLabelText('Ask a question…'), { target: { value: 'pto' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));

    expect(await screen.findByText('unscored passage')).toBeTruthy();
    expect(screen.getByText('0.812')).toBeTruthy();   // positive control
    expect(screen.queryByText('0.000')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
  });
});

/* ─── KB-UX-4: list reads ──────────────────────────────────────── */

describe('KB-UX-4 — a failed list read terminates, and offers a retry', () => {
  it('orgs FAIL: the shared honest card, never "No organizations" and never a perpetual skeleton', async () => {
    api.listOrgs.mockRejectedValue(new Error('orgs_500'));
    view('/kb');
    expect(await screen.findByText('Could not load your organizations')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(document.querySelector('.skeleton')).toBeNull();
    // The org-gated read must not have started.
    expect(api.listCollections).not.toHaveBeenCalled();
  });

  it('orgs SUCCEED but are empty: the real zero-organization card survives', async () => {
    api.listOrgs.mockResolvedValue([]);
    view('/kb');
    expect(await screen.findByText('No organizations')).toBeTruthy();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    expect(document.querySelector('.skeleton')).toBeNull();
  });

  it('collections FAIL: a retryable card, never "No collections yet", and the retry re-reads', async () => {
    api.listCollections.mockRejectedValueOnce(new Error('collections_500'));
    view('/kb?org=o1');

    expect(await screen.findByText('Failed to load collections.')).toBeTruthy();
    expect(screen.queryByText('No collections yet.')).toBeNull();

    api.listCollections.mockResolvedValueOnce([COLLECTION]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]!);
    expect(await screen.findByRole('link', { name: 'HR Policies' })).toBeTruthy();
    expect(screen.queryByText('Failed to load collections.')).toBeNull();
  });

  it('documents FAIL: a retryable card, never the "No documents" empty state', async () => {
    api.listDocuments.mockRejectedValue(new Error('documents_500'));
    view();
    expect(await screen.findByText('Failed to load documents.')).toBeTruthy();
    expect(screen.queryByText('No documents')).toBeNull();
    expect(screen.getByText(/This is a failed read, not an empty collection/)).toBeTruthy();
  });

  it('documents SUCCEED with []: the genuine empty state survives', async () => {
    view();
    expect(await screen.findByText('No documents')).toBeTruthy();
    expect(screen.queryByText('Failed to load documents.')).toBeNull();
  });
});

/* ─── KB-UX-2: reindex ─────────────────────────────────────────── */

describe('KB-UX-2 — a reindex that did not complete does not report completion', () => {
  const job = (over: Record<string, unknown> = {}) => ({
    collectionId: 'c1', targetSpec: { provider: 'local' }, fromSig: 'a', toSig: 'b',
    totalChunks: 10, embeddedChunks: 10, status: 'done', costEstimateTokens: 0, costSpentTokens: 0,
    startedAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z', ...over,
  });

  const startReindexAndSettle = async (terminal: Record<string, unknown>): Promise<void> => {
    api.startReindex.mockResolvedValue(job({ status: 'running', embeddedChunks: 0 }));
    api.drainReindex.mockResolvedValue(job(terminal));
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'Reindex' }));
    await waitFor(() => expect(api.drainReindex).toHaveBeenCalled());
  };

  it('a FAILED job reports the failure — the branch that was unreachable', async () => {
    await startReindexAndSettle({ status: 'failed', error: 'embedding provider rejected the key' });
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(toasts.success).not.toHaveBeenCalled();
    expect(String(toasts.error.mock.calls[0]![0])).toContain('embedding provider rejected the key');
  });

  it('a CANCELLED job does not report completion', async () => {
    await startReindexAndSettle({ status: 'cancelled' });
    await waitFor(() => expect(toasts.info).toHaveBeenCalled());
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it('a PAUSED job does not report completion (the budget Notice already says it, and persists)', async () => {
    await startReindexAndSettle({ status: 'paused', error: 'daily embedding budget reached' });
    await waitFor(() => expect(api.drainReindex).toHaveBeenCalled());
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it('positive control: a DONE job still reports completion', async () => {
    await startReindexAndSettle({ status: 'done' });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Reindex complete'));
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('KB-UX-10 — Cancel is live DURING the drain, not disabled for the whole job', async () => {
    api.startReindex.mockResolvedValue(job({ status: 'running', embeddedChunks: 0 }));
    const pending = deferred<unknown>();
    api.drainReindex.mockReturnValueOnce(pending.promise);
    api.cancelReindex.mockResolvedValue(job({ status: 'cancelled' }));
    view();

    fireEvent.click(await screen.findByRole('button', { name: 'Reindex' }));
    const cancel = await screen.findByRole('button', { name: 'Discard rebuild' });
    expect(cancel.hasAttribute('disabled')).toBe(false);
    // KBX-7 — the click now awaits a confirm before it reaches the API, so the
    // assertion has to settle rather than read synchronously. The property under
    // test is unchanged: the control is LIVE (not `disabled`) mid-drain.
    await act(async () => { fireEvent.click(cancel); });
    await waitFor(() => expect(api.cancelReindex).toHaveBeenCalled());

    await act(async () => { pending.resolve(job({ status: 'cancelled' })); await pending.promise; });
  });
});
