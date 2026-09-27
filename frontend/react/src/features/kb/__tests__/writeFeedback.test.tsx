/**
 * Knowledge Base — what a write says when it fails, what it says when it works,
 * and where focus goes afterwards (KBX-4, KBX-8 … KBX-12, KB-UX-8, KB-UX-9).
 *
 * The family this file pins is the one the 2026-09 loop has now met six times:
 * **a transport diagnostic reaching a human**. On this surface it had its purest
 * form — `deleteDocument`/`deleteCollection` never parsed the response body at
 * all, so during a reindex the operator's toast literally read
 * `deleteDocument returned 409`: a function name they have never heard of, a
 * number, and no mention of the reindex that actually refused the write. The
 * cure is `kbUiHelpers.kbActionError`, and the test for it has to assert BOTH
 * halves — that the localized sentence appears AND that the wire string does
 * not — because a mapper that appends the server prose would satisfy the first
 * on its own.
 *
 * Both-polarity throughout, same rule as its two sibling files.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(),
  listCollections: vi.fn(),
  listDocuments: vi.fn(),
  search: vi.fn(),
  getReindexJob: vi.fn(),
  deleteDocument: vi.fn(),
  deleteCollection: vi.fn(),
  ingestText: vi.fn(),
  createCollection: vi.fn(),
  setRetrievalMode: vi.fn(),
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
const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmMock }));

import { KnowledgeBasePage } from '../KnowledgeBasePage.js';
import { KbRequestError } from '../kbRequestError.js';
import { currentAnnouncements } from '../../../ui/announce.js';

const ORG = { orgId: 'o1', name: 'Acme' };
const COLLECTION = {
  collectionId: 'c1', name: 'HR Policies', documentCount: 2, chunkCount: 6,
  updatedAt: '2026-09-03T00:00:00.000Z', retrievalConfig: { mode: 'dense' as const },
};
const TEXT_DOC = { documentId: 'd1', title: 'PTO Policy', source: { kind: 'text' }, chunkCount: 3, createdAt: '2026-09-03T00:00:00.000Z' };
const URL_DOC = { documentId: 'd2', title: 'Vendor terms', source: { kind: 'url', url: 'https://vendor.example.com/terms' }, chunkCount: 2, createdAt: '2026-09-03T00:00:00.000Z' };

/** The 409 the reindex lock actually produces, prose and all. */
const REINDEX_409 = () => new KbRequestError('A reindex is in progress for this collection; retry after it completes or cancel it.', 409);

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState({}, '', '/kb');
  api.listOrgs.mockResolvedValue([ORG]);
  api.listCollections.mockResolvedValue([COLLECTION]);
  api.listDocuments.mockResolvedValue([TEXT_DOC]);
  api.getReindexJob.mockResolvedValue(null);
  confirmMock.mockResolvedValue(true);
});
afterEach(cleanup);

const view = async (path = '/kb?org=o1&collection=c1'): Promise<void> => {
  window.history.replaceState({}, '', path);
  render(<MemoryRouter initialEntries={[path]}><KnowledgeBasePage /></MemoryRouter>);
  await screen.findByRole('heading', { name: 'Documents' });
};

const lastError = (): string => String(toasts.error.mock.calls.at(-1)?.[0] ?? '');

/* ─── KBX-4: no wire diagnostics, no untranslated server prose ─────── */

describe('KBX-4 — a failed write is a sentence, not an HTTP diagnostic', () => {
  it('a 409 on delete names the reindex — never "deleteDocument returned 409"', async () => {
    api.deleteDocument.mockRejectedValue(REINDEX_409());
    await view();

    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /Delete document/ })[0]!); });
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());

    expect(lastError()).toMatch(/paused while it is being reindexed/);
    // Both halves. The first would pass for a mapper that PREPENDS its sentence
    // to the server's; these are what make it a replacement.
    expect(lastError()).not.toMatch(/deleteDocument/);
    expect(lastError()).not.toMatch(/returned 409/);
    expect(lastError()).not.toMatch(/A reindex is in progress for this collection/);
  });

  it('the same 409 on deleting a COLLECTION gets the same sentence', async () => {
    api.deleteCollection.mockRejectedValue(REINDEX_409());
    await view();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Delete collection/ })); });
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(lastError()).toMatch(/paused while it is being reindexed/);
    expect(lastError()).not.toMatch(/deleteCollection/);
  });

  it('a 5xx says what a 5xx means — not the same sentence as a 409', async () => {
    // A mapper that returned one string for everything would pass the tests
    // above. This is the control that says the STATUS is actually read.
    api.ingestText.mockRejectedValue(new KbRequestError('boom', 503));
    await view();
    fireEvent.change(screen.getByLabelText('Paste text to chunk + embed into this collection…'), { target: { value: 'hello' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Ingest/ })); });
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());

    expect(lastError()).toMatch(/Reload to see whether it went through/);
    expect(lastError()).not.toMatch(/reindexed/);
    expect(lastError()).not.toMatch(/boom/);
  });

  it('a status with nothing to say falls back to the caller’s own copy', async () => {
    api.ingestText.mockRejectedValue(new KbRequestError('socket hang up', 418));
    await view();
    fireEvent.change(screen.getByLabelText('Paste text to chunk + embed into this collection…'), { target: { value: 'hello' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Ingest/ })); });
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(lastError()).toBe('Ingest failed.');
  });

  it('a non-transport failure also falls back, rather than leaking its message', async () => {
    api.ingestText.mockRejectedValue(new Error('TypeError: fetch failed'));
    await view();
    fireEvent.change(screen.getByLabelText('Paste text to chunk + embed into this collection…'), { target: { value: 'hello' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Ingest/ })); });
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(lastError()).toBe('Ingest failed.');
    expect(lastError()).not.toMatch(/fetch failed/);
  });
});

/* ─── KBX-11: every write path confirms ────────────────────────────── */

describe('KBX-11 — the four silent write paths now confirm', () => {
  it('paste-text ingest confirms', async () => {
    api.ingestText.mockResolvedValue(TEXT_DOC);
    await view();
    fireEvent.change(screen.getByLabelText('Paste text to chunk + embed into this collection…'), { target: { value: 'hello' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Ingest/ })); });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Document added.'));
  });

  it('create-collection confirms, by name', async () => {
    api.createCollection.mockResolvedValue(COLLECTION);
    await view();
    fireEvent.change(screen.getByLabelText('New collection'), { target: { value: 'Handbook' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create collection' })); });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Collection “Handbook” created.'));
  });

  it('delete-document confirms — the row no longer just vanishes', async () => {
    api.deleteDocument.mockResolvedValue(undefined);
    await view();
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /Delete document/ })[0]!); });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Document deleted.'));
  });

  it('delete-collection confirms, by name', async () => {
    api.deleteCollection.mockResolvedValue(undefined);
    await view();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Delete collection/ })); });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Collection “HR Policies” deleted.'));
  });

  it('negative control: a FAILED write confirms nothing', async () => {
    api.ingestText.mockRejectedValue(new KbRequestError('nope', 503));
    await view();
    fireEvent.change(screen.getByLabelText('Paste text to chunk + embed into this collection…'), { target: { value: 'hello' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Ingest/ })); });
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(toasts.success).not.toHaveBeenCalled();
  });
});

/* ─── KBX-12: focus after a destructive action ─────────────────────── */

describe('KBX-12 — focus survives a delete', () => {
  it('deleting the only document moves focus to the Documents heading, not <body>', async () => {
    api.deleteDocument.mockResolvedValue(undefined);
    // The list re-read AFTER the delete returns empty, which unmounts the whole
    // grid — including any node focused before the reload committed. That is why
    // the chain has to end on the heading.
    api.listDocuments.mockResolvedValueOnce([TEXT_DOC]).mockResolvedValue([]);
    await view();

    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /Delete document/ })[0]!); });
    await waitFor(() => expect(screen.getByText('No documents')).toBeTruthy());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Documents' })));
    expect(document.activeElement).not.toBe(document.body);
  });

  it('deleting a collection moves focus into the collections rail', async () => {
    api.deleteCollection.mockResolvedValue(undefined);
    await view();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Delete collection/ })); });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('New collection')));
  });

  it('closing the reader moves focus back to the document list', async () => {
    api.listDocuments.mockResolvedValue([TEXT_DOC, URL_DOC]);
    await view('/kb?org=o1&collection=c1&doc=d1');
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /Back to documents/ })); });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Documents' })));
  });
});

/* ─── KBX-8 + KB-UX-9: the search's in-flight state and its outcome ── */

describe('KBX-8 / KB-UX-9 — the search says what it is doing and what it found', () => {
  it('the in-flight frame names the query instead of emptying the region', async () => {
    let resolve!: (v: unknown[]) => void;
    api.search.mockReturnValue(new Promise((r) => { resolve = r; }));
    await view();
    fireEvent.change(screen.getByLabelText('Ask a question…'), { target: { value: 'pto' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));

    expect(await screen.findByText('Searching for “pto”…')).toBeTruthy();
    // KB-UX-1 is NOT weakened by the new arm: no previous answer survives it.
    expect(screen.queryByText('No matches — add documents, or try a different question.')).toBeNull();

    await act(async () => { resolve([]); });
    expect(await screen.findByText('No matches — add documents, or try a different question.')).toBeTruthy();
    expect(screen.queryByText('Searching for “pto”…')).toBeNull();
  });

  it('a resolved search announces its count', async () => {
    api.search.mockResolvedValue([
      { chunkId: 'k1', documentId: 'd1', title: 'PTO Policy', chunkIndex: 0, text: '15 days of PTO', score: 0.9 },
      { chunkId: 'k2', documentId: 'd1', title: 'PTO Policy', chunkIndex: 1, text: 'carry-over', score: 0.7 },
    ]);
    await view();
    fireEvent.change(screen.getByLabelText('Ask a question…'), { target: { value: 'pto' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await screen.findByText('15 days of PTO');
    await waitFor(() => expect(currentAnnouncements().polite).toContain('2 matching passages'));
  });

  it('an empty search announces the no-matches outcome, not silence', async () => {
    api.search.mockResolvedValue([]);
    await view();
    fireEvent.change(screen.getByLabelText('Ask a question…'), { target: { value: 'pto' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await screen.findByText('No matches — add documents, or try a different question.');
    await waitFor(() => expect(currentAnnouncements().polite).toContain('No matches'));
  });
});

/* ─── KBX-9: the six controls are no longer one flag ───────────────── */

describe('KBX-9 — a slow search does not disable the ingest card', () => {
  it('an in-flight search leaves every write control live', async () => {
    api.search.mockReturnValue(new Promise(() => { /* never settles */ }));
    await view();
    fireEvent.change(screen.getByLabelText('Ask a question…'), { target: { value: 'pto' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await screen.findByText('Searching for “pto”…');

    fireEvent.change(screen.getByLabelText('Paste text to chunk + embed into this collection…'), { target: { value: 'hello' } });
    expect(screen.getByRole('button', { name: /Ingest/ }).hasAttribute('disabled')).toBe(false);
    fireEvent.change(screen.getByLabelText('New collection'), { target: { value: 'Handbook' } });
    expect(screen.getByRole('button', { name: 'Create collection' }).hasAttribute('disabled')).toBe(false);
    // …and the search's OWN control is the one that is busy.
    expect(screen.getByRole('button', { name: /Searching/ }).hasAttribute('disabled')).toBe(true);
  });
});

/* ─── KBX-10: the selects do not snap back mid-PATCH ───────────────── */

describe('KBX-10 — a retrieval select holds the chosen value while it saves', () => {
  it('the picked option stays picked until the collection list confirms it', async () => {
    let resolve!: (v: unknown) => void;
    api.setRetrievalMode.mockReturnValue(new Promise((r) => { resolve = r; }));
    await view();
    const select = screen.getByDisplayValue('Standard (semantic)') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'hybrid' } });

    // The defect: `value` derived straight from the loaded collection, so for the
    // whole round-trip the control showed the OLD option back to the user.
    expect(select.value).toBe('hybrid');
    expect(select.disabled).toBe(true);

    api.listCollections.mockResolvedValue([{ ...COLLECTION, retrievalConfig: { mode: 'hybrid' as const } }]);
    await act(async () => { resolve({}); });
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Retrieval settings saved.'));
    expect((screen.getByDisplayValue('Hybrid (keyword + semantic)') as HTMLSelectElement).value).toBe('hybrid');
  });

  it('a FAILED change reverts to the truth rather than keeping the optimistic lie', async () => {
    api.setRetrievalMode.mockRejectedValue(new KbRequestError('nope', 503));
    await view();
    const select = screen.getByDisplayValue('Standard (semantic)') as HTMLSelectElement;
    await act(async () => { fireEvent.change(select, { target: { value: 'hybrid' } }); });

    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByLabelText(/Retrieval/) as HTMLSelectElement).value).toBe('dense'));
  });
});

/* ─── KB-UX-8: a URL document has a label at all ───────────────────── */

describe('KB-UX-8 — a URL-sourced document renders its provenance', () => {
  it('the chip and the sub-line name the source and its origin', async () => {
    api.listDocuments.mockResolvedValue([URL_DOC]);
    await view();
    // `SOURCE_KEY` had no `url` arm, so both of these evaluated `t(undefined)`.
    expect(await screen.findByText('Web page — vendor.example.com')).toBeTruthy();
    expect(screen.getByText('Web page')).toBeTruthy();
  });

  it('positive control: a text document is unchanged', async () => {
    await view();
    // Two nodes by design — the sub-line and the chip both carry it, which is
    // exactly the pair that rendered `t(undefined)` for a URL document.
    expect((await screen.findAllByText('Pasted text')).length).toBe(2);
  });

  it('the reader labels a URL document too', async () => {
    api.listDocuments.mockResolvedValue([URL_DOC]);
    await view('/kb?org=o1&collection=c1&doc=d2');
    // `docSource_url` — the reader used to degrade to the raw literal "url".
    await waitFor(() => expect(screen.getAllByText('Web page').length).toBeGreaterThan(0));
    expect(screen.queryByText('url')).toBeNull();
  });
});
