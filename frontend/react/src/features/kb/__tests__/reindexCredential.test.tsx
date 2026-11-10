/** KB-BYOK-1 (ADR 0398 correction, 2026-11-06): the real KB page drives the existing
 * startReindex client contract with saved-key NAMES only. No provider call or
 * secret-value read (the byokClient mock exposes only `listStoredRefs`, so any other
 * import fails the module); resolver/dispatch is covered in backend.
 *
 * Claims: only exact/colon provider names are offered (never google-vertex for
 * google), nothing is auto-selected, the explicitly chosen ref is sent and named in
 * the confirmation, Local sends no key and lists none; a failed key read says so (no
 * empty state) and keeps the default path; Retry works and is off while a start is
 * pending; and an auth, provider, organization, collection or unmount change voids a
 * pending confirmation, start or drain: nothing starts, drains or toasts afterwards.
 *
 * Double guards (a single-guard sabotage reads green by design):
 *  - after the confirmation: `isCurrent()` AND `credentialRef && !keys.isVerified()`;
 *    removing both reds the provider/auth/organization/collection cases.
 *  - after a drain: `runToCompletion`'s `keys.isCurrent(identity)` AND `start`'s
 *    `isCurrent()` before `reportTerminal`, which also checks `selectionVersion`
 *    (bumped by the auth invalidation); the loop guard alone is held by the other two.
 *  - Local sends no key: the provider change clears the choice, the Reindex button is
 *    disabled for an unverified key, and the request omits it for `local`.
 *  - organization change: the old panel unmounts with its collection, so the key
 *    field closes for that reason too (a constant panel `key` stays green there; it
 *    reds the collection case).
 *  - no key carried into a re-opened collection: a fresh panel starts blank AND the
 *    provider change that shows the key field clears the choice. Local is the
 *    default and hides the field, so every path to the field goes through that clear;
 *    a panel that starts from a remembered key alone stays green. The held pair
 *    w95g2r2-kb-carry-both (remembered key + no clear) reds case 10.
 *
 * Sabotage witnesses (/grade-tests wave 95): a prefix provider filter, no blank
 * option, dropping the ref from the request or the confirmation, listing keys for
 * Local, keeping the choice across a provider change, hiding the failed read,
 * blocking the default path on it, a dead or always-on Retry, skipping the verified
 * check before the confirmation, the post-confirmation guards, the post-start guard,
 * `isCurrent` in the shared hook, reporting a drain after a workspace switch, and a
 * constant panel key. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { fireAuthChanged } from '../../../client/config.js';
import type { KbCollection, ReindexJob } from '../kbClient.js';
type Kb = typeof import('../kbClient.js');
const api = vi.hoisted(() => ({
  listOrgs: vi.fn<Kb['listOrgs']>(), listCollections: vi.fn<Kb['listCollections']>(),
  listDocuments: vi.fn<Kb['listDocuments']>(), getReindexJob: vi.fn<Kb['getReindexJob']>(),
  startReindex: vi.fn<Kb['startReindex']>(), drainReindex: vi.fn<Kb['drainReindex']>(),
}));
const keys = vi.hoisted(() => vi.fn<typeof import('../../../byok/lib/byokClient.js')['listStoredRefs']>());
const confirmation = vi.hoisted(() => vi.fn<typeof import('../../../ui/confirm.js')['confirm']>());
const access = vi.hoisted(() => vi.fn<typeof import('../../../client/accessClient.js')['getEffectiveAccess']>());
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../kbClient.js', async original => ({ ...await original<Kb>(), ...api, getQuality: async () => [] }));
vi.mock('../../../byok/lib/byokClient.js', () => ({ listStoredRefs: keys }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmation }));
vi.mock('../../../ui/toast.js', () => ({ toast: toasts }));
vi.mock('../../../client/accessClient.js', async original => ({ ...await original<typeof import('../../../client/accessClient.js')>(), getEffectiveAccess: access }));
vi.mock('../../knowledge-sync/KnowledgeSyncPanel.js', () => ({ KnowledgeSyncPanel: () => null }));
vi.mock('../../media/mediaClient.js', async original => ({ ...await original<typeof import('../../media/mediaClient.js')>(), listCollections: async () => [] }));
import { KnowledgeBasePage } from '../KnowledgeBasePage.js';
const collection: KbCollection = { collectionId: 'c1', name: 'Official product facts', documentCount: 1, chunkCount: 1, updatedAt: '2026-11-06T00:00:00Z' };
const running: ReindexJob = {
  collectionId: 'c1', targetSpec: { provider: 'google', credentialRef: 'google:chosen' }, fromSig: 'old', toSig: 'new',
  totalChunks: 1, embeddedChunks: 0, status: 'running', costEstimateTokens: 10, costSpentTokens: 0,
  startedAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z',
};
function deferred<T>() { let resolve: (value: T) => void = () => { throw new Error('Promise not initialized'); }; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function select(label: string): HTMLSelectElement { const element = screen.getByLabelText(label); if (!(element instanceof HTMLSelectElement)) throw new Error(`${label} is not a select`); return element; }
async function view() {
  window.history.replaceState({}, '', '/kb?org=o1&collection=c1');
  const result = render(<MemoryRouter initialEntries={['/kb?org=o1&collection=c1']}><KnowledgeBasePage /></MemoryRouter>);
  await screen.findByRole('heading', { name: 'Embedding model & rebuild' });
  return result;
}
async function google() {
  fireEvent.change(select('Embedding model'), { target: { value: 'google' } });
  await screen.findByRole('option', { name: 'google:chosen' });
}
beforeEach(() => {
  vi.resetAllMocks();
  api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'KickTodo' }, { orgId: 'o2', name: 'DeckTalk' }]);
  api.listCollections.mockResolvedValue([collection]); api.listDocuments.mockResolvedValue([]); api.getReindexJob.mockResolvedValue(null);
  api.startReindex.mockResolvedValue(running); api.drainReindex.mockResolvedValue({ ...running, status: 'done', embeddedChunks: 1 });
  access.mockResolvedValue({ roles: ['owner'], scopes: ['workspace:read', 'workspace:write', 'host:org:manage'], basis: 'member' });
  confirmation.mockResolvedValue(true);
  keys.mockResolvedValue(['google:first', 'google:chosen', 'google-vertex:team', 'anthropic:other', 'cohere:embed']);
});
afterEach(cleanup);
it('offers only matching saved names without auto-selecting and sends the explicitly chosen Google reference', async () => {
  await view(); expect(keys).not.toHaveBeenCalled(); await google();
  const field = select('Saved embedding key');
  expect([...field.options].map(option => option.value)).toEqual(['', 'google:first', 'google:chosen']);
  expect(field.value).toBe('');
  fireEvent.change(field, { target: { value: 'google:chosen' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reindex' }));
  await waitFor(() => expect(api.startReindex).toHaveBeenCalledWith('o1', 'c1', { provider: 'google', credentialRef: 'google:chosen' }));
  const call = confirmation.mock.calls[0]; if (!call) throw new Error('Confirmation was not shown');
  expect(call[0].body).toContain('google:chosen'); expect(call[0].body).toContain('Searches keep working');
  await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Reindex complete'));
});
it('keeps Local independent of saved keys and a provider change clears the explicit choice', async () => {
  await view(); await google(); fireEvent.change(select('Saved embedding key'), { target: { value: 'google:chosen' } });
  fireEvent.change(select('Embedding model'), { target: { value: 'cohere' } });
  await screen.findByRole('option', { name: 'cohere:embed' }); expect(select('Saved embedding key').value).toBe('');
  fireEvent.change(select('Embedding model'), { target: { value: 'local' } });
  expect(screen.queryByLabelText('Saved embedding key')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reindex' }));
  await waitFor(() => expect(api.startReindex).toHaveBeenCalledWith('o1', 'c1', { provider: 'local' }));
});
it('shows a failed key read honestly and allows the old no-override path', async () => {
  keys.mockRejectedValueOnce(new Error('offline')); await view();
  fireEvent.change(select('Embedding model'), { target: { value: 'google' } });
  await screen.findByText('Saved keys could not be loaded. Retry, or keep the existing default.');
  expect(screen.queryByText(/No saved keys match/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reindex' }));
  await waitFor(() => expect(api.startReindex).toHaveBeenCalledWith('o1', 'c1', { provider: 'google' }));
});
it('retries a failed list and preserves blank selection with no keys', async () => {
  keys.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]); await view();
  fireEvent.change(select('Embedding model'), { target: { value: 'google' } });
  await screen.findByText('Saved keys could not be loaded. Retry, or keep the existing default.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText(/No saved keys match this embedding provider/);
  expect(select('Saved embedding key').value).toBe('');
});
it('does not submit a selected old-workspace key when auth changes before React commits the reset', async () => {
  await view(); await google(); fireEvent.change(select('Saved embedding key'), { target: { value: 'google:chosen' } });
  const button = screen.getByRole('button', { name: 'Reindex' });
  act(() => { fireAuthChanged(); fireEvent.click(button); });
  expect(api.startReindex).not.toHaveBeenCalled(); expect(confirmation).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Saved embedding key')).toBeNull();
  fireEvent.click(await screen.findByRole('link', { name: 'Official product facts' }));
  await google();
  await waitFor(() => expect(select('Saved embedding key').value).toBe(''));
  expect(api.startReindex).not.toHaveBeenCalled(); expect(confirmation).not.toHaveBeenCalled();
});
it('invalidates a pending confirmation on provider change without starting a job', async () => {
  const pending = deferred<boolean>(); confirmation.mockReturnValue(pending.promise); await view(); await google();
  fireEvent.change(select('Saved embedding key'), { target: { value: 'google:chosen' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reindex' }));
  await waitFor(() => expect(confirmation).toHaveBeenCalledTimes(1));
  fireEvent.change(select('Embedding model'), { target: { value: 'local' } });
  await act(async () => pending.resolve(true)); expect(api.startReindex).not.toHaveBeenCalled();
});
it('invalidates confirmation on workspace auth change even when the same org remains selected', async () => {
  const pending = deferred<boolean>(); confirmation.mockReturnValue(pending.promise); await view(); await google();
  fireEvent.change(select('Saved embedding key'), { target: { value: 'google:chosen' } }); fireEvent.click(screen.getByRole('button', { name: 'Reindex' }));
  await waitFor(() => expect(confirmation).toHaveBeenCalledTimes(1)); act(() => fireAuthChanged());
  await act(async () => pending.resolve(true)); expect(api.startReindex).not.toHaveBeenCalled();
});
it('ignores an outstanding start result after unmount, without draining or claiming completion', async () => {
  const pending = deferred<ReindexJob>(); api.startReindex.mockReturnValue(pending.promise); const mounted = await view(); await google();
  fireEvent.change(select('Saved embedding key'), { target: { value: 'google:chosen' } }); fireEvent.click(screen.getByRole('button', { name: 'Reindex' }));
  await waitFor(() => expect(api.startReindex).toHaveBeenCalledTimes(1)); mounted.unmount();
  await act(async () => pending.resolve(running)); expect(api.drainReindex).not.toHaveBeenCalled(); expect(toasts.success).not.toHaveBeenCalled();
  expect(toasts.error).not.toHaveBeenCalled();
});
it('does not toast an old drain completion after a workspace switch', async () => {
  const pending = deferred<ReindexJob>(); api.drainReindex.mockReturnValue(pending.promise); await view(); await google();
  fireEvent.change(select('Saved embedding key'), { target: { value: 'google:chosen' } }); fireEvent.click(screen.getByRole('button', { name: 'Reindex' }));
  await waitFor(() => expect(api.drainReindex).toHaveBeenCalledTimes(1)); act(() => fireAuthChanged());
  await act(async () => pending.resolve({ ...running, status: 'done', embeddedChunks: 1 })); expect(toasts.success).not.toHaveBeenCalled();
  // Not a failure either: the old drain reports nothing in the new workspace.
  expect(toasts.error).not.toHaveBeenCalled(); expect(toasts.info).not.toHaveBeenCalled();
});
it('rejects a pending confirmation after an organization change and does not carry the old selected key into the new collection context', async () => {
  const pending = deferred<boolean>(); confirmation.mockReturnValue(pending.promise); await view(); await google();
  fireEvent.change(select('Saved embedding key'), { target: { value: 'google:chosen' } }); fireEvent.click(screen.getByRole('button', { name: 'Reindex' }));
  await waitFor(() => expect(confirmation).toHaveBeenCalledTimes(1)); fireEvent.change(select('Organization'), { target: { value: 'o2' } });
  await act(async () => pending.resolve(true)); expect(api.startReindex).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Saved embedding key')).toBeNull();
  // Re-open the collection in the new organization: the old choice is not there.
  fireEvent.click(await screen.findByRole('link', { name: 'Official product facts' }));
  await google();
  await waitFor(() => expect(select('Saved embedding key').value).toBe(''));
  expect(api.startReindex).not.toHaveBeenCalled();
});
it('rejects a pending confirmation after a collection change', async () => {
  api.listCollections.mockResolvedValue([collection, { ...collection, collectionId: 'c2', name: 'Secondary official facts' }]);
  const pending = deferred<boolean>(); confirmation.mockReturnValue(pending.promise); await view(); await google();
  fireEvent.change(select('Saved embedding key'), { target: { value: 'google:chosen' } }); fireEvent.click(screen.getByRole('button', { name: 'Reindex' }));
  await waitFor(() => expect(confirmation).toHaveBeenCalledTimes(1)); fireEvent.click(screen.getByRole('link', { name: /Secondary official facts/ }));
  await act(async () => pending.resolve(true)); expect(api.startReindex).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Saved embedding key')).toBeNull();
});

it('keeps key-list retry unavailable while an accepted default-key start is still pending, then drains the actual returned job', async () => {
  keys.mockRejectedValueOnce(new Error('offline')); const pending = deferred<ReindexJob>(); api.startReindex.mockReturnValue(pending.promise);
  await view(); fireEvent.change(select('Embedding model'), { target: { value: 'google' } });
  await screen.findByText('Saved keys could not be loaded. Retry, or keep the existing default.');
  fireEvent.click(screen.getByRole('button', { name: 'Reindex' }));
  await waitFor(() => expect(api.startReindex).toHaveBeenCalledWith('o1', 'c1', { provider: 'google' }));
  const retry = screen.getByRole('button', { name: 'Retry' }); if (!(retry instanceof HTMLButtonElement)) throw new Error('Retry is not a button');
  expect(retry.disabled).toBe(true); fireEvent.click(retry); expect(keys).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(running));
  await waitFor(() => expect(api.drainReindex).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Reindex complete'));
});
