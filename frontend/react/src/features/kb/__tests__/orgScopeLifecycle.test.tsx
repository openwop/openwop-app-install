/**
 * KB-ORG-SCOPE-1 (ADR 0336 deep-link spine): the real KnowledgeBasePage + router
 * with deferred resource reads. The backend already refuses a mixed
 * org/collection tuple; the frontend must never issue that tuple, and no read,
 * write completion or refusal from an old org (or an old auth epoch) may own the
 * new view: no private document body, list, search hit, media list or quality
 * report from org A after a switch to org B.
 *
 * Double guards, recorded (a one-edit probe on either half alone can read
 * vacuous): every read's state is OWNER-KEYED (`collectionRead.owner`,
 * `documentRead.owner`, `detailRead.owner`, …) AND each settle is checked by an
 * `isCurrent` closure; `selectOrg` clears `collection`/`doc` from the URL AND
 * `selected` is derived from the owner-keyed list; `useOrgSelection` accepts a
 * read only for the current owner AND `scopeReady` requires the route org. The
 * focus-request case: the "New collection" field is mounted in both rail
 * states, so the case also asserts focus has NOT moved before the refresh
 * settles.
 *
 * Sabotage-witnessed (grade-tests w97, r1): making the collection, document,
 * search, media or quality `isCurrent` always true; dropping the document-read
 * sequence, the auth-change owner reset, the ingest or delete re-checks, the
 * history reconcile, the route-org scope, the collection focus exemption, the
 * org-read acceptance or its stale-read check; keeping `doc` in the URL; and
 * reporting a failed document read as empty each turn a case red. Added in r2
 * (the r1 probes were vacuous or other-red): keeping `collection` in the URL
 * (case 1 now asserts the exact URL), the detail `isCurrent` (B now has an open
 * document), and the focus wait.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KbCollection, KbDocument, KbDocumentDetail } from '../kbClient.js';
type Kb = typeof import('../kbClient.js');
const api = vi.hoisted(() => ({
  listOrgs: vi.fn<Kb['listOrgs']>(), listCollections: vi.fn<Kb['listCollections']>(),
  listDocuments: vi.fn<Kb['listDocuments']>(), getDocument: vi.fn<Kb['getDocument']>(),
  getQuality: vi.fn<Kb['getQuality']>(), getReindexJob: vi.fn<Kb['getReindexJob']>(),
  search: vi.fn<Kb['search']>(), ingestText: vi.fn<Kb['ingestText']>(),
  createCollection: vi.fn<Kb['createCollection']>(), deleteCollection: vi.fn<Kb['deleteCollection']>(),
  deleteDocument: vi.fn<Kb['deleteDocument']>(),
}));
vi.mock('../kbClient.js', async (original) => ({ ...await original<Kb>(), ...api }));
vi.mock('../../knowledge-sync/KnowledgeSyncPanel.js', () => ({ KnowledgeSyncPanel: () => <div /> }));
const media = vi.hoisted(() => ({ listCollections: vi.fn<typeof import('../../media/mediaClient.js')['listCollections']>() }));
vi.mock('../../media/mediaClient.js', async (original) => ({ ...await original<typeof import('../../media/mediaClient.js')>(), ...media }));
const access = vi.hoisted(() => vi.fn<typeof import('../../../client/accessClient.js')['getEffectiveAccess']>());
vi.mock('../../../client/accessClient.js', async (original) => ({ ...await original<typeof import('../../../client/accessClient.js')>(), getEffectiveAccess: access }));
const confirmation = vi.hoisted(() => vi.fn<typeof import('../../../ui/confirm.js')['confirm']>());
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmation }));
type Toast = typeof import('../../../ui/toast.js')['toast'];
const toasts = vi.hoisted(() => ({ success: vi.fn<Toast['success']>(), error: vi.fn<Toast['error']>(), info: vi.fn<Toast['info']>() }));
vi.mock('../../../ui/toast.js', () => ({ toast: toasts }));
const auth = vi.hoisted(() => ({ listeners: new Set<() => void>() }));
vi.mock('../../../client/config.js', async (original) => ({
  ...await original<typeof import('../../../client/config.js')>(),
  onAuthChange: (listener: () => void) => { auth.listeners.add(listener); return () => { auth.listeners.delete(listener); }; },
}));
import { KnowledgeBasePage } from '../KnowledgeBasePage.js';
const ca: KbCollection = { collectionId: 'ca', name: 'A knowledge', documentCount: 1, chunkCount: 1, updatedAt: '2026-11-07T00:00:00Z' };
const cb: KbCollection = { ...ca, collectionId: 'cb', name: 'B knowledge', documentCount: 0, chunkCount: 0 };
const da: KbDocument = { documentId: 'da', title: 'A private document', source: { kind: 'text' }, chunkCount: 1, createdAt: '2026-11-07T00:00:00Z' };
const detail: KbDocumentDetail = { ...da, text: 'A private body' };
const db: KbDocument = { ...da, documentId: 'db', title: 'B document' };
const detailB: KbDocumentDetail = { ...db, text: 'B private body' };
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('uninitialized promise'); };
  let reject: (error: Error) => void = () => { throw new Error('uninitialized promise'); };
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function RouterProbe() {
  const location = useLocation(); const navigate = useNavigate();
  return <><output aria-label="Current URL">{location.search}</output><button onClick={() => navigate('/kb?org=b&collection=cb')}>Open B deep link</button><button onClick={() => navigate(-1)}>History back</button><button onClick={() => navigate(1)}>History forward</button></>;
}
function view(path = '/kb?org=a&collection=ca', strict = false) {
  const page = <MemoryRouter initialEntries={[path]}><KnowledgeBasePage /><RouterProbe /></MemoryRouter>;
  return render(strict ? <StrictMode>{page}</StrictMode> : page);
}
async function chooseOrg(org: string) {
  fireEvent.change(await screen.findByRole('combobox', { name: 'Organization' }), { target: { value: org } });
}
async function openB() { fireEvent.click(await screen.findByRole('link', { name: 'B knowledge' })); }
async function flush() { await act(async () => { await Promise.resolve(); }); }
beforeEach(() => {
  vi.resetAllMocks(); auth.listeners.clear();
  api.listOrgs.mockResolvedValue([{ orgId: 'a', name: 'A client' }, { orgId: 'b', name: 'B client' }]);
  api.listCollections.mockImplementation(async (org) => org === 'a' ? [ca] : [cb]);
  api.listDocuments.mockImplementation(async (_org, collection) => collection === 'ca' ? [da] : []);
  api.getDocument.mockResolvedValue(detail); api.getQuality.mockResolvedValue([]); api.getReindexJob.mockResolvedValue(null);
  api.search.mockResolvedValue([]); media.listCollections.mockResolvedValue([]);
  access.mockResolvedValue({ roles: ['owner'], scopes: ['workspace:read', 'workspace:write', 'host:org:manage'], basis: 'member' });
  confirmation.mockResolvedValue(true);
});
afterEach(cleanup);

describe('KB organization and resource ownership', () => {
  it('clears both child URL keys and never reads the old collection/document under the new org', async () => {
    view('/kb?org=a&collection=ca&doc=da'); await screen.findByText('A private body');
    const pending = deferred<KbCollection[]>(); api.listCollections.mockImplementation((org) => org === 'b' ? pending.promise : Promise.resolve([ca]));
    await chooseOrg('b'); await flush();
    // Exact: both child keys (collection AND doc) are gone, not just one.
    expect(screen.getByLabelText('Current URL').textContent).toBe('?org=b');
    expect(screen.queryByText('A private body')).toBeNull(); expect(screen.queryByRole('link', { name: 'A knowledge' })).toBeNull();
    expect(api.listDocuments).not.toHaveBeenCalledWith('b', 'ca');
    expect(api.getDocument).not.toHaveBeenCalledWith('b', 'ca', 'da');
    expect(api.getReindexJob).not.toHaveBeenCalledWith('b', 'ca');
    await act(async () => pending.resolve([cb])); await openB(); await screen.findByText('No documents');
  });

  it.each(['resolve', 'reject'] as const)('ignores an old document-list %s after a new org has a valid empty collection', async (ending) => {
    const old = deferred<KbDocument[]>(); api.listDocuments.mockImplementation((_org, collection) => collection === 'ca' ? old.promise : Promise.resolve([]));
    view(); await screen.findByRole('heading', { name: 'A knowledge' });
    await chooseOrg('b'); await openB(); await screen.findByText('No documents');
    await act(async () => { if (ending === 'resolve') old.resolve([da]); else old.reject(new Error('old_collection_404')); });
    expect(screen.getByText('No documents')).toBeVisible();
    expect(screen.queryByText('Failed to load documents.')).toBeNull(); expect(screen.queryByText('A private document')).toBeNull();
  });

  it.each(['resolve', 'reject'] as const)('ignores old collection %s across A → B → A', async (ending) => {
    const old = deferred<KbCollection[]>(); api.listCollections.mockReturnValueOnce(old.promise);
    view('/kb?org=a'); await waitFor(() => expect(api.listCollections).toHaveBeenCalledWith('a'));
    await chooseOrg('b'); await screen.findByRole('link', { name: 'B knowledge' });
    await chooseOrg('a'); await screen.findByRole('link', { name: 'A knowledge' });
    await act(async () => { if (ending === 'resolve') old.resolve([{ ...ca, name: 'Obsolete A collection' }]); else old.reject(new Error('old_collection_error')); });
    expect(screen.getByRole('link', { name: 'A knowledge' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Obsolete A collection' })).toBeNull(); expect(screen.queryByText('Failed to load collections.')).toBeNull();
  });

  it('keeps latest same-scope retry success when an earlier retry later fails', async () => {
    api.listDocuments.mockRejectedValueOnce(new Error('current_failure'));
    view(); await screen.findByText('Failed to load documents.');
    const older = deferred<KbDocument[]>(); const latest = deferred<KbDocument[]>();
    api.listDocuments.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise);
    const retry = screen.getByRole('button', { name: 'Retry' });
    act(() => { retry.click(); retry.click(); });
    expect(api.listDocuments).toHaveBeenCalledTimes(3);
    await act(async () => latest.resolve([])); await screen.findByText('No documents');
    await act(async () => older.reject(new Error('older_retry_failure')));
    expect(screen.getByText('No documents')).toBeVisible(); expect(screen.queryByText('Failed to load documents.')).toBeNull();
  });

  it.each(['resolve', 'reject'] as const)('ignores an old detail %s after organization change', async (ending) => {
    // B has an OPEN document, so a reader is mounted when the old detail settles.
    api.listDocuments.mockImplementation(async (_org, collection) => collection === 'ca' ? [da] : [db]);
    api.getDocument.mockImplementation(async (_org, collection) => collection === 'cb' ? detailB : detail);
    const old = deferred<KbDocumentDetail>(); api.getDocument.mockReturnValueOnce(old.promise);
    view('/kb?org=a&collection=ca&doc=da'); await waitFor(() => expect(api.getDocument).toHaveBeenCalledWith('a', 'ca', 'da'));
    await chooseOrg('b'); await openB();
    fireEvent.click(await screen.findByText('B document'));
    await screen.findByText('B private body');
    expect(api.getDocument).toHaveBeenLastCalledWith('b', 'cb', 'db');
    await act(async () => { if (ending === 'resolve') old.resolve(detail); else old.reject(new Error('old_document_404')); });
    expect(screen.getByText('B private body')).toBeVisible();
    expect(screen.queryByText('A private body')).toBeNull(); expect(screen.queryByText('Failed to load documents.')).toBeNull();
  });

  it('restores a valid document deep link in StrictMode and resolves browser history org changes', async () => {
    view('/kb?org=a&collection=ca&doc=da', true); await screen.findByText('A private body');
    fireEvent.click(screen.getByRole('button', { name: 'Open B deep link' })); await screen.findByText('No documents');
    fireEvent.click(screen.getByRole('button', { name: 'History back' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue('a'));
    await screen.findByText('A private body');
    fireEvent.click(screen.getByRole('button', { name: 'History forward' })); await screen.findByText('No documents');
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue('b');
  });

  it('keeps a current document failure honest and retryable', async () => {
    api.listDocuments.mockRejectedValueOnce(new Error('current_500'));
    view(); await screen.findByText('Failed to load documents.'); expect(screen.queryByText('No documents')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await screen.findByText('A private document');
    expect(screen.queryByText('Failed to load documents.')).toBeNull();
  });

  it('does not submit an old control in the same batch as an auth/workspace invalidation', async () => {
    view(); await screen.findByText('A private document');
    const name = screen.getByRole('textbox', { name: 'New collection' });
    fireEvent.change(name, { target: { value: 'Old tenant collection' } });
    const button = screen.getByRole('button', { name: 'Create collection' });
    act(() => { for (const listener of auth.listeners) listener(); fireEvent.click(button); });
    await flush(); expect(api.createCollection).not.toHaveBeenCalled();
    await screen.findByText('A private document');
    api.createCollection.mockResolvedValue({ ...ca, collectionId: 'fresh' });
    fireEvent.change(screen.getByRole('textbox', { name: 'New collection' }), { target: { value: 'Current tenant collection' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create collection' }));
    await waitFor(() => expect(api.createCollection).toHaveBeenCalledWith('a', 'Current tenant collection'));
  });

  it('does not let an old ingest completion clear a new collection form or toast success', async () => {
    const old = deferred<KbDocument>(); api.ingestText.mockReturnValueOnce(old.promise);
    view(); await screen.findByText('A private document');
    fireEvent.change(screen.getByRole('textbox', { name: 'Paste text to chunk + embed into this collection…' }), { target: { value: 'Old body' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ingest' }));
    await waitFor(() => expect(api.ingestText).toHaveBeenCalledWith('a', 'ca', 'Untitled', 'Old body'));
    await chooseOrg('b'); await openB(); await screen.findByText('No documents');
    const fresh = screen.getByRole('textbox', { name: 'Paste text to chunk + embed into this collection…' });
    fireEvent.change(fresh, { target: { value: 'New unsaved body' } });
    toasts.success.mockClear(); const readsBefore = api.listCollections.mock.calls.length;
    await act(async () => old.resolve(da));
    expect(fresh).toHaveValue('New unsaved body'); expect(toasts.success).not.toHaveBeenCalled();
    expect(api.listCollections.mock.calls.length).toBe(readsBefore);
    expect(screen.getByRole('button', { name: 'Ingest' })).toBeEnabled();
  });

  it('does not issue a delete after its confirmation crosses an org change', async () => {
    const pending = deferred<boolean>(); confirmation.mockReturnValueOnce(pending.promise);
    view(); await screen.findByText('A private document');
    fireEvent.click(screen.getByRole('button', { name: 'Delete document' }));
    await waitFor(() => expect(confirmation).toHaveBeenCalled());
    await chooseOrg('b'); await openB(); await screen.findByText('No documents');
    await act(async () => pending.resolve(true));
    expect(api.deleteDocument).not.toHaveBeenCalled(); expect(api.deleteCollection).not.toHaveBeenCalled();
  });

  it('does not repopulate a new org with an old search result', async () => {
    const pending = deferred<Awaited<ReturnType<Kb['search']>>>(); api.search.mockReturnValueOnce(pending.promise);
    view(); await screen.findByText('A private document');
    fireEvent.change(screen.getByRole('textbox', { name: 'Ask a question…' }), { target: { value: 'Old question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(api.search).toHaveBeenCalledWith('a', 'ca', 'Old question'));
    await chooseOrg('b'); await openB(); await screen.findByText('No documents');
    await act(async () => pending.resolve([{ chunkId: 'old', documentId: 'da', title: 'Old search hit', chunkIndex: 0, text: 'Old search body', score: 0.9 }]));
    expect(screen.queryByText('Old search body')).toBeNull(); expect(screen.queryByText('Old search hit')).toBeNull();
    expect(screen.getByText('No documents')).toBeVisible();
  });

  it('keeps new-org media choices when an old list settles late', async () => {
    const pending = deferred<Awaited<ReturnType<typeof media.listCollections>>>();
    media.listCollections.mockImplementation((org) => org === 'a' ? pending.promise : Promise.resolve([{ collectionId: 'mb', orgId: 'b', name: 'B media', createdAt: '2026-11-07T00:00:00Z' }]));
    view(); await screen.findByText('A private document');
    await chooseOrg('b'); await openB(); await screen.findByRole('option', { name: 'B media' });
    await act(async () => pending.resolve([{ collectionId: 'ma', orgId: 'a', name: 'A obsolete media', createdAt: '2026-11-07T00:00:00Z' }]));
    expect(screen.getByRole('option', { name: 'B media' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'A obsolete media' })).toBeNull();
  });

  it('does not let an old quality report alter the current collection retrieval controls', async () => {
    const pending = deferred<Awaited<ReturnType<Kb['getQuality']>>>();
    api.getQuality.mockImplementation((org) => org === 'a' ? pending.promise : Promise.resolve([{ collectionId: 'cb', enrichment: 'off', embedder: { mode: 'local', funding: 'none', provider: 'local', model: 'hash', available: true, pinned: false }, retrievalMode: 'dense', indexState: 'current' }]));
    view(); await screen.findByText('A private document'); await waitFor(() => expect(api.getQuality).toHaveBeenCalledWith('a'));
    await chooseOrg('b'); await openB(); await screen.findByText('No documents');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Retrieval' })).toHaveValue('dense'));
    await act(async () => pending.resolve([{ collectionId: 'ca', enrichment: 'off', embedder: { mode: 'local', funding: 'none', provider: 'local', model: 'hash', available: true, pinned: false }, retrievalMode: 'dense', indexState: 'current' }]));
    expect(screen.getByRole('combobox', { name: 'Retrieval' })).toHaveValue('dense');
  });

  // No module-level state exists today, so React's instance isolation alone keeps
  // this green (the `mounted` guard is an equivalent mutant here). It stays as a
  // guard against a future module-level cache shared across page mounts.
  it('a late read from an unmounted page never reaches a newly mounted page (guard against a future module-level cache)', async () => {
    const pending = deferred<KbDocument[]>(); api.listDocuments.mockReturnValueOnce(pending.promise);
    const first = view(); await waitFor(() => expect(api.listDocuments).toHaveBeenCalledWith('a', 'ca')); first.unmount();
    view('/kb?org=b&collection=cb'); await screen.findByText('No documents');
    await act(async () => pending.reject(new Error('unmounted_old_failure')));
    expect(screen.getByText('No documents')).toBeVisible(); expect(screen.queryByText('Failed to load documents.')).toBeNull();
  });


  it.each(['resolve', 'reject'] as const)('withholds old-org controls and dependent reads while auth catalog refresh is pending, then handles %s honestly', async (ending) => {
    view(); await screen.findByText('A private document');
    const pending = deferred<Awaited<ReturnType<Kb['listOrgs']>>>();
    api.listOrgs.mockReturnValueOnce(pending.promise);
    const before = api.listCollections.mock.calls.length;
    act(() => { for (const listener of auth.listeners) listener(); });
    await waitFor(() => expect(api.listOrgs).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('combobox', { name: 'Organization' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'New collection' })).toBeNull();
    expect(screen.queryByText('A private document')).toBeNull();
    expect(api.listCollections).toHaveBeenCalledTimes(before);
    await act(async () => { if (ending === 'resolve') pending.resolve([{ orgId: 'a', name: 'Confirmed current client' }]); else pending.reject(new Error('current_catalog_failed')); });
    if (ending === 'resolve') {
      await screen.findByText('A private document');
      expect(screen.getByRole('option', { name: 'Confirmed current client' })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'New collection' })).toBeEnabled();
    } else {
      await screen.findByText('Could not load your organizations');
      expect(screen.queryByRole('textbox', { name: 'New collection' })).toBeNull();
      expect(api.listCollections).toHaveBeenCalledTimes(before);
    }
  });

  it('retains the current collection-delete focus request until the delayed rail refresh settles', async () => {
    view(); await screen.findByText('A private document');
    const pending = deferred<KbCollection[]>(); api.listCollections.mockReturnValueOnce(pending.promise);
    api.deleteCollection.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Delete collection' }));
    await waitFor(() => expect(api.deleteCollection).toHaveBeenCalledWith('a', 'ca'));
    await waitFor(() => expect(api.listCollections).toHaveBeenCalledTimes(2));
    await flush();
    // Focus is deferred until the rail read commits: not taken while it is pending.
    expect(document.activeElement).not.toBe(screen.queryByRole('textbox', { name: 'New collection' }));
    await act(async () => pending.resolve([]));
    await screen.findByText('No collections yet.');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'New collection' })).toHaveFocus());
  });

  it('retains the current catalog when an older StrictMode org read finishes late', async () => {
    const pending = deferred<Awaited<ReturnType<Kb['listOrgs']>>>(); api.listOrgs.mockReturnValueOnce(pending.promise);
    view('/kb?org=a&collection=ca', true); await screen.findByText('A private document');
    await act(async () => pending.resolve([{ orgId: 'a', name: 'Obsolete catalog' }]));
    expect(screen.getByText('A private document')).toBeVisible();
    expect(screen.getByRole('option', { name: 'A client' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Obsolete catalog' })).toBeNull();
  });

  it('blocks an old-org deep link excluded by fresh membership until the user clears it', async () => {
    view('/kb?org=a&collection=ca&doc=da'); await screen.findByText('A private body');
    const pending = deferred<Awaited<ReturnType<Kb['listOrgs']>>>();
    api.listOrgs.mockReturnValueOnce(pending.promise);
    const collectionsBefore = api.listCollections.mock.calls.length;
    const documentsBefore = api.listDocuments.mock.calls.length;
    act(() => { for (const listener of auth.listeners) listener(); });
    await waitFor(() => expect(api.listOrgs).toHaveBeenCalledTimes(2));
    await act(async () => pending.resolve([{ orgId: 'b', name: 'Only current member client' }]));
    await screen.findByText('The item you linked to is no longer available.');
    expect(screen.queryByText('A private body')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'New collection' })).toBeNull();
    expect(api.listCollections).toHaveBeenCalledTimes(collectionsBefore);
    expect(api.listDocuments).toHaveBeenCalledTimes(documentsBefore);
    expect(api.listDocuments).not.toHaveBeenCalledWith('b', 'ca');
    expect(api.getDocument).not.toHaveBeenCalledWith('b', 'ca', 'da');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await screen.findByRole('link', { name: 'B knowledge' });
    expect(screen.getByLabelText('Current URL').textContent).toBe('?org=b');
    await openB(); await screen.findByText('No documents');
    expect(api.listCollections).toHaveBeenLastCalledWith('b');
    expect(api.listDocuments).toHaveBeenLastCalledWith('b', 'cb');
    expect(api.listDocuments).not.toHaveBeenCalledWith('b', 'ca');
  });

});
