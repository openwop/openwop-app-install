/**
 * Knowledge Base — the reindex is a collection-wide WRITE LOCK, and the surface
 * says so (KBX-1 … KBX-7).
 *
 * `readHonesty.test.tsx` covers what the job says when it ENDS. This file covers
 * what OWNS it while it runs, which is the gap the 2026-09-03 `/grade-ux` pass
 * found: two Blockers and four Improvements all downstream of the same seam.
 *
 * Every case here is BOTH-POLARITY, for the reason that file states: an
 * "absent" assertion alone is vacuous, because a page that rendered nothing
 * would satisfy it. So each lock assertion is paired with the unlocked control,
 * and each stranded-job assertion with the healthy job that must NOT show the
 * stalled state.
 *
 * The one that has to be exactly right is KBX-2. The bug was a RENDER
 * CONDITION, not a missing function — `resume()` was already status-agnostic and
 * already correct, and only `{job.status === 'paused' && <Button …>}` kept it
 * unreachable from the status a closed tab actually leaves behind. A test that
 * merely asserted "`resume` works" would have passed against the bug. So the
 * assertion is on what a `running` job RENDERS, which is the thing that was
 * false, and reverting the condition to `=== 'paused'` turns it red — witnessed
 * on `continuing a RUNNING job re-enters the drain`, which FINDS the Continue
 * button on a `running` job before it clicks it.
 *
 * Wave-6 /grade-tests (2026-10-09) cut three cases whose every break is caught
 * elsewhere, each confirmed by a sabotage probe that turned BOTH sides red:
 *  - "a RUNNING job renders a continue action" → the continue-drain case below
 *    and `orgAccess.test.tsx` "positive control: the OWNER keeps Reindex…";
 *  - "a live job stamps when it last advanced" → the KBX-3 positive control;
 *  - "the paused Notice does not ALSO carry its own live role" → "a PAUSED job
 *    announces" (the KB passes `announce`) + `ui/__tests__/noticeAnnounce.test.tsx`
 *    "DROPS its own live region when announcing" (the Notice honours it).
 *
 * The announcer is MODULE state, so it is reset per case, and `announce` is
 * wrapped (real behaviour kept) so a stomped announcement — one overwritten in
 * the same commit — is still visible in `mock.calls`. Without that, the
 * exactly-one case could not fail: the slot keeps only the LAST string.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Kb = typeof import('../kbClient.js');
const api = vi.hoisted(() => ({
  listOrgs: vi.fn<Kb['listOrgs']>(),
  listCollections: vi.fn<Kb['listCollections']>(),
  listDocuments: vi.fn<Kb['listDocuments']>(),
  search: vi.fn<Kb['search']>(),
  startReindex: vi.fn<Kb['startReindex']>(),
  drainReindex: vi.fn<Kb['drainReindex']>(),
  getReindexJob: vi.fn<Kb['getReindexJob']>(),
  cancelReindex: vi.fn<Kb['cancelReindex']>(),
  deleteDocument: vi.fn<Kb['deleteDocument']>(),
}));
vi.mock('../kbClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../kbClient.js')>();
  return { ...orig, ...api };
});
vi.mock('../../knowledge-sync/KnowledgeSyncPanel.js', () => ({
  KnowledgeSyncPanel: () => <div data-testid="sync-panel" />,
}));
vi.mock('../../media/mediaClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listCollections: vi.fn(async () => []) };
});

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: toasts }));

// Typed with the REAL `confirm` signature, not `() => true`. An argument-less mock
// gives `mock.calls` an EMPTY TUPLE type, so `calls[0]![0]` is a compile error the
// vitest run never sees — unit tests are not type-checked by `npm run build`, only
// by `check:test-types`.
const confirmMock = vi.hoisted(() => vi.fn<typeof import('../../../ui/confirm.js')['confirm']>());
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmMock }));

// KB2UX-1 — the page reads the caller's per-org authority. These suites test
// what an OWNER sees; `orgAccess.test.tsx` covers the narrower callers.
const accessApi = vi.hoisted(() => ({
  getEffectiveAccess: vi.fn<typeof import('../../../client/accessClient.js')['getEffectiveAccess']>(),
}));
vi.mock('../../../client/accessClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...accessApi };
});
// The REAL announcer, wrapped: behaviour unchanged, every call recorded.
vi.mock('../../../ui/announce.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../ui/announce.js')>();
  return { ...real, announce: vi.fn(real.announce) };
});

import { KnowledgeBasePage } from '../KnowledgeBasePage.js';
import { announce, currentAnnouncements } from '../../../ui/announce.js';
import type { KbCollection, KbDocument, Org, ReindexJob } from '../kbClient.js';
import type { EffectiveAccess } from '../../../client/accessClient.js';

const OWNER_ACCESS: EffectiveAccess = { roles: ['owner'], scopes: ['workspace:read', 'workspace:write', 'host:org:manage'], basis: 'member' };
const LOCK_ANNOUNCE = 'Document changes are paused while this collection is being reindexed.';
/** Every string handed to the announcer since the per-case reset. */
const spoken = (): string[] => vi.mocked(announce).mock.calls.map(([m]) => m);

const ORG: Org = { orgId: 'o1', name: 'Acme' };
const COLLECTION: KbCollection = {
  collectionId: 'c1', name: 'HR Policies', documentCount: 1, chunkCount: 3,
  updatedAt: '2026-09-03T00:00:00.000Z',
};
const DOC: KbDocument = { documentId: 'd1', title: 'PTO Policy', source: { kind: 'text' }, chunkCount: 3, createdAt: '2026-09-03T00:00:00.000Z' };

/** A reindex job, `updatedAt` expressed as "this many ms ago" so the
 *  not-advancing threshold is exercised against a real clock rather than a
 *  frozen literal that quietly ages into whatever the test needs. */
const job = (over: Partial<ReindexJob> = {}, agoMs = 0): ReindexJob => ({
  collectionId: 'c1', targetSpec: { provider: 'local' }, fromSig: 'a', toSig: 'b',
  totalChunks: 100, embeddedChunks: 40, status: 'running',
  costEstimateTokens: 0, costSpentTokens: 0,
  startedAt: new Date(Date.now() - agoMs).toISOString(),
  updatedAt: new Date(Date.now() - agoMs).toISOString(),
  ...over,
});

beforeEach(() => {
  // Reset the module-level slot FIRST, then the mocks, so this call is not in
  // `mock.calls` (Vitest 4 `resetAllMocks` restores the wrapped real impl).
  announce('');
  vi.resetAllMocks();
  accessApi.getEffectiveAccess.mockResolvedValue(OWNER_ACCESS);
  window.history.replaceState({}, '', '/kb');
  api.listOrgs.mockResolvedValue([ORG]);
  api.listCollections.mockResolvedValue([COLLECTION]);
  api.listDocuments.mockResolvedValue([DOC]);
  api.getReindexJob.mockResolvedValue(null);
  confirmMock.mockResolvedValue(true);
});
afterEach(cleanup);

const view = async (path = '/kb?org=o1&collection=c1'): Promise<void> => {
  window.history.replaceState({}, '', path);
  render(<MemoryRouter initialEntries={[path]}><KnowledgeBasePage /></MemoryRouter>);
  await screen.findByRole('heading', { name: 'Embedding model & rebuild' });
};

/* ─── KBX-2: the stranded job's non-destructive exit ───────────────── */

describe('KBX-2 — a job stranded in `running` offers more than Cancel', () => {
  it('continuing a RUNNING job re-enters the drain — the function was always status-agnostic', async () => {
    api.getReindexJob.mockResolvedValue(job({ status: 'running' }));
    api.drainReindex.mockResolvedValue(job({ status: 'done', embeddedChunks: 100 }));
    await view();

    fireEvent.click(await screen.findByRole('button', { name: 'Continue rebuild' }));
    await waitFor(() => expect(api.drainReindex).toHaveBeenCalled());
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Reindex complete'));
  });

  it('positive control: a PAUSED job still says Resume, not Continue', async () => {
    api.getReindexJob.mockResolvedValue(job({ status: 'paused' }));
    await view();

    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue rebuild' })).toBeNull();
  });

  it('negative control: a DONE job offers neither — it shows the start form', async () => {
    api.getReindexJob.mockResolvedValue(job({ status: 'done', embeddedChunks: 100 }));
    await view();

    expect(await screen.findByRole('button', { name: 'Reindex' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue rebuild' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });
});

/* ─── KBX-1 + KBX-7: the two gates ─────────────────────────────────── */

describe('KBX-1 / KBX-7 — the reindex asks before it starts, and before it discards', () => {
  it('Start is gated, and the gate names the write lock and the tab', async () => {
    api.startReindex.mockResolvedValue(job({ status: 'running' }));
    api.drainReindex.mockResolvedValue(job({ status: 'done', embeddedChunks: 100 }));
    await view();

    fireEvent.click(await screen.findByRole('button', { name: 'Reindex' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    const opts = confirmMock.mock.calls[0]![0];
    expect(opts.title).toContain('HR Policies');
    // The consequence the old copy hid: writes stop, and searches do not.
    expect(opts.body).toMatch(/paused until the rebuild finishes/);
    expect(opts.body).toMatch(/Searches keep working/);
    // KBX-1 — written for the ADR 0643 D1b end state: the tab is the fast path,
    // not the owner. The OLD copy said the opposite ("in the background") while
    // a `for` loop in the tab was the only driver.
    expect(opts.body).toMatch(/continues on the server if you close this tab/);
  });

  it('declining the Start gate does not start anything', async () => {
    confirmMock.mockResolvedValue(false);
    await view();

    fireEvent.click(await screen.findByRole('button', { name: 'Reindex' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(api.startReindex).not.toHaveBeenCalled();
  });

  it('Discard is gated, and declining leaves the staged rebuild alone', async () => {
    api.getReindexJob.mockResolvedValue(job({ status: 'running' }));
    confirmMock.mockResolvedValue(false);
    await view();

    fireEvent.click(await screen.findByRole('button', { name: 'Discard rebuild' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(api.cancelReindex).not.toHaveBeenCalled();
    const opts = confirmMock.mock.calls[0]![0];
    expect(opts.body).toMatch(/re-embeds every passage from scratch/);
  });

  it('positive control: accepting the Discard gate does cancel', async () => {
    api.getReindexJob.mockResolvedValue(job({ status: 'running' }));
    api.cancelReindex.mockResolvedValue(job({ status: 'cancelled' }));
    await view();

    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Discard rebuild' })); });
    await waitFor(() => expect(api.cancelReindex).toHaveBeenCalled());
  });

  it('the field-help no longer promises a background rebuild', async () => {
    await view();
    const help = await screen.findByText(/Currently: local\./);
    // The exact sentence that was false in four locales.
    expect(help.textContent).not.toMatch(/in the background/);
    expect(help.textContent).toMatch(/continues on the server if you close this tab/);
  });
});

/* ─── KBX-3: a frozen job is not painted as a live one ─────────────── */

describe('KBX-3 — last-known, and when', () => {
  it('a job that has not advanced for minutes says so, and says what happens next', async () => {
    api.getReindexJob.mockResolvedValue(job({ status: 'running' }, 10 * 60_000));
    await view();
    const stalled = await screen.findByText(/has not advanced for several minutes/);
    // Written for ADR 0643: D1b (it drains without this tab) and D1a (a running
    // job whose lease goes unrenewed is cancelled, not left blocking forever).
    expect(stalled.textContent).toMatch(/continues on the server/);
    expect(stalled.textContent).toMatch(/cancelled automatically after 30 minutes/);
  });

  it('positive control: a job that advanced a moment ago is NOT called stalled', async () => {
    api.getReindexJob.mockResolvedValue(job({ status: 'running' }, 1_000));
    await view();
    await screen.findByText(/Last progress/);
    expect(screen.queryByText(/has not advanced for several minutes/)).toBeNull();
  });

  it('a PAUSED job is never called stalled — the budget clock is not the lease clock', async () => {
    // ADR 0643 D1a: `paused` is budget-paused by construction and expires only
    // against a 48h ceiling. Calling it "not advancing" would tell the operator
    // to act on something that is behaving exactly as designed.
    api.getReindexJob.mockResolvedValue(job({ status: 'paused' }, 10 * 60_000));
    await view();
    await screen.findByRole('button', { name: 'Resume' });
    expect(screen.queryByText(/has not advanced for several minutes/)).toBeNull();
  });

  it('KB-UX-11 — a failed job read is disclosed, not swallowed into an idle Start form', async () => {
    api.getReindexJob.mockRejectedValue(new Error('reindex_500'));
    await view();
    expect(await screen.findByText(/rebuild status could not be read/)).toBeTruthy();
  });
});

/* ─── KBX-5: the page knows about the lock ─────────────────────────── */

describe('KBX-5 — a locked collection disables and explains its writes', () => {
  it('a live job disables every document write and says why, once', async () => {
    api.getReindexJob.mockResolvedValue(job({ status: 'running' }));
    await view();

    expect(await screen.findByText(/adding, importing and deleting documents are paused/)).toBeTruthy();
    expect((screen.getByLabelText('Paste text to chunk + embed into this collection…') as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /Ingest/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /Delete collection/ }).hasAttribute('disabled')).toBe(true);
    // CT-KBX-3 — the sync runner writes through the same guarded functions, so
    // its refusal must not read as a Drive/credential problem.
    expect(screen.getByText(/not a connection problem/)).toBeTruthy();
  });

  it('positive control: with no job, the same six controls are live', async () => {
    await view();
    const text = screen.getByLabelText('Paste text to chunk + embed into this collection…') as HTMLTextAreaElement;
    expect(text.disabled).toBe(false);
    fireEvent.change(text, { target: { value: 'hello' } });
    expect(screen.getByRole('button', { name: /Ingest/ }).hasAttribute('disabled')).toBe(false);
    expect((screen.getByLabelText('Add from URL') as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: /Delete collection/ }).hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText(/adding, importing and deleting documents are paused/)).toBeNull();
    expect(screen.queryByText(/not a connection problem/)).toBeNull();
  });

  it('search is NOT disabled by the lock — reads keep working on the current model', async () => {
    // The claim the confirm body makes has to be true on screen, or the gate is
    // just a different lie.
    api.getReindexJob.mockResolvedValue(job({ status: 'running' }));
    await view();
    fireEvent.change(screen.getByLabelText('Ask a question…'), { target: { value: 'pto' } });
    expect(screen.getByRole('button', { name: /Search/ }).hasAttribute('disabled')).toBe(false);
  });
});

/* ─── KBX-6: the pause is audible ──────────────────────────────────── */

describe('KBX-6 — the reindex pause reaches assistive tech', () => {
  it('a PAUSED job announces, so `reportTerminal` suppressing its toast is honest', async () => {
    api.getReindexJob.mockResolvedValue(job({ status: 'paused', error: 'daily embedding budget reached' }));
    await view();
    await screen.findByRole('button', { name: 'Resume' });
    // `Notice announce=` delegates to the ONE GlobalLiveRegion rather than
    // rendering its own region (which, mounted with its text already inside,
    // speaks nothing — `ui/Notice.tsx` documents this at length).
    await waitFor(() => expect(currentAnnouncements().polite).toContain('daily embedding budget was reached'));
    // KB2UX-2 — the visible text is the LOCALIZED sentence, not the server's
    // English diagnostic (which used to be rendered verbatim in all 4 locales).
    expect(screen.getByText(/Paused — daily embedding budget reached/)).toBeTruthy();
    expect(screen.queryByText('daily embedding budget reached')).toBeNull();
  });

  it('exactly ONE lock notice announces — a second string on the same commit silences the first', async () => {
    // The stomp is real: the polite slot holds one string, so the page-level
    // lock notice, the budget notice and the not-advancing notice would
    // overwrite each other in mount order and the operator would hear whichever
    // happened to render last. `paused` wins over the generic lock sentence.
    api.getReindexJob.mockResolvedValue(job({ status: 'paused' }));
    await view();
    await screen.findByRole('button', { name: 'Resume' });
    await waitFor(() => expect(currentAnnouncements().polite).toContain('daily embedding budget was reached'));
    // The slot holds only the LAST string, so a lock announcement stomped in the
    // same commit would be invisible there; the call record is not.
    expect(spoken()).not.toContain(LOCK_ANNOUNCE);
    expect(currentAnnouncements().polite).not.toContain('Document changes are paused');
    // …and the page-level sentence is still on SCREEN; only the speech is deduped.
    expect(screen.getByText(/adding, importing and deleting documents are paused/)).toBeTruthy();
  });

  it('a stalled job speaks the not-advancing sentence, not the generic lock one', async () => {
    api.getReindexJob.mockResolvedValue(job({ status: 'running' }, 10 * 60_000));
    await view();
    await screen.findByText(/has not advanced for several minutes/);
    await waitFor(() => expect(currentAnnouncements().polite).toContain('not advancing'));
    expect(spoken()).not.toContain(LOCK_ANNOUNCE);
  });

  it('positive control: a healthy running job speaks the lock sentence', async () => {
    api.getReindexJob.mockResolvedValue(job({ status: 'running' }, 1_000));
    await view();
    await screen.findByText(/adding, importing and deleting documents are paused/);
    await waitFor(() => expect(currentAnnouncements().polite).toContain('Document changes are paused'));
    expect(spoken()).toContain(LOCK_ANNOUNCE);
  });
});
