/**
 * ADR 0904 D7 — the "AI context" enrichment control. The per-chunk cost lands on the
 * tenant's OWN AI key, so the estimate is shown BEFORE enabling it, and a collection
 * set to AI context whose key no longer resolves SAYS so rather than silently indexing
 * without it. Both polarities: the chip/estimate appear only from the quality report.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Kb = typeof import('../kbClient.js');
const api = vi.hoisted(() => ({
  listOrgs: vi.fn<Kb['listOrgs']>(),
  listCollections: vi.fn<Kb['listCollections']>(),
  listDocuments: vi.fn<Kb['listDocuments']>(),
  getDocument: vi.fn<Kb['getDocument']>(),
  search: vi.fn<Kb['search']>(),
  getReindexJob: vi.fn<Kb['getReindexJob']>(),
  deleteDocument: vi.fn<Kb['deleteDocument']>(),
  deleteCollection: vi.fn<Kb['deleteCollection']>(),
  ingestText: vi.fn<Kb['ingestText']>(),
  createCollection: vi.fn<Kb['createCollection']>(),
  setRetrievalMode: vi.fn<Kb['setRetrievalMode']>(),
  setReranker: vi.fn<Kb['setReranker']>(),
  getQuality: vi.fn<Kb['getQuality']>(),
}));
vi.mock('../kbClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../kbClient.js')>();
  // ADR 0904 — the page also reads the quality report; a unit test must not reach it live.
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
import { KnowledgeBasePage } from '../KnowledgeBasePage.js';
import { announce } from '../../../ui/announce.js';
import type { KbCollection, KbDocument, Org } from '../kbClient.js';
import type { EffectiveAccess } from '../../../client/accessClient.js';

const OWNER_ACCESS: EffectiveAccess = { roles: ['owner'], scopes: ['workspace:read', 'workspace:write', 'host:org:manage'], basis: 'member' };

const ORG: Org = { orgId: 'o1', name: 'Acme' };
const COLLECTION: KbCollection = {
  collectionId: 'c1', name: 'HR Policies', documentCount: 2, chunkCount: 6,
  updatedAt: '2026-09-03T00:00:00.000Z', retrievalConfig: { mode: 'dense' },
};
const TEXT_DOC: KbDocument = { documentId: 'd1', title: 'PTO Policy', source: { kind: 'text' }, chunkCount: 3, createdAt: '2026-09-03T00:00:00.000Z' };


beforeEach(() => {
  announce(''); // module-level slot: a previous case's string must not satisfy this one
  vi.resetAllMocks();
  accessApi.getEffectiveAccess.mockResolvedValue(OWNER_ACCESS);
  window.history.replaceState({}, '', '/kb');
  api.listOrgs.mockResolvedValue([ORG]);
  api.listCollections.mockResolvedValue([COLLECTION]);
  api.listDocuments.mockResolvedValue([TEXT_DOC]);
  api.getDocument.mockImplementation(async () => ({ ...TEXT_DOC, text: 'body text' }));
  api.getReindexJob.mockResolvedValue(null);
  confirmMock.mockResolvedValue(true);
});
afterEach(cleanup);

const view = async (path = '/kb?org=o1&collection=c1'): Promise<void> => {
  window.history.replaceState({}, '', path);
  render(<MemoryRouter initialEntries={[path]}><KnowledgeBasePage /></MemoryRouter>);
  await screen.findByRole('heading', { name: 'Documents' });
};


describe('ADR 0904 D7 — AI context enrichment control', () => {
  it('offers AI context and shows its cost on the tenant key before it is enabled', async () => {
    api.getQuality.mockResolvedValue([{ collectionId: 'c1', enrichment: 'off', enrichmentEstimateTokens: 12345, embedder: { mode: 'local' as const, funding: 'none' as const, provider: 'local', model: 'local-hash-v1', available: true, pinned: false }, retrievalMode: 'hybrid' as const, indexState: 'current' as const }]);
    await view();
    expect(screen.getByRole('option', { name: /AI context/ })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/about 12,345 tokens on your AI key/)).toBeTruthy());
    expect(screen.queryByText(/your AI key is unavailable/)).toBeNull();
  });

  it('says so when AI context is on but the key no longer resolves', async () => {
    api.getQuality.mockResolvedValue([{ collectionId: 'c1', enrichment: 'llm', enrichmentUnavailable: true, embedder: { mode: 'local' as const, funding: 'none' as const, provider: 'local', model: 'local-hash-v1', available: true, pinned: false }, retrievalMode: 'hybrid' as const, indexState: 'current' as const }]);
    await view();
    await waitFor(() => expect(screen.getByText(/your AI key is unavailable — indexing without it/)).toBeTruthy());
  });

  it('shows nothing extra when the quality report is unavailable', async () => {
    api.getQuality.mockRejectedValue(new Error('down'));
    await view();
    expect(screen.queryByText(/tokens on your AI key/)).toBeNull();
    expect(screen.queryByText(/your AI key is unavailable/)).toBeNull();
  });
});


describe('ADR 0904 P7 — server-authoritative reranker control', () => {
  const rankingCollection: KbCollection = { ...COLLECTION, retrievalConfig: { mode: 'hybrid+rerank' } };
  const quality = { collectionId: 'c1', enrichment: 'off' as const, embedder: { mode: 'local' as const, funding: 'none' as const, provider: 'local', model: 'local-hash-v1', available: true, pinned: false }, retrievalMode: 'hybrid+rerank' as const, indexState: 'current' as const };

  it('offers Vertex only when the backend reports it available and saves through retrieval config', async () => {
    api.listCollections.mockResolvedValue([rankingCollection]);
    api.getQuality.mockResolvedValue([{ ...quality, availableRerankers: ['local', 'vertex'] }]);
    api.setReranker.mockImplementation(async () => {
      const saved: KbCollection = { ...rankingCollection, retrievalConfig: { mode: 'hybrid+rerank', rerank: { kind: 'vertex' } } };
      api.listCollections.mockResolvedValue([saved]); return saved;
    });
    await view();
    await screen.findByRole('option', { name: 'Vertex AI (provided by this deployment)' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Reranker' }), { target: { value: 'vertex' } });
    await waitFor(() => expect(api.setReranker).toHaveBeenCalledWith('o1', 'c1', 'vertex'));
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Reranker' }) as HTMLSelectElement).disabled).toBe(false));
    expect((screen.getByRole('combobox', { name: 'Reranker' }) as HTMLSelectElement).value).toBe('vertex');
  });

  it('keeps unavailable provider options out of a new selection', async () => {
    api.listCollections.mockResolvedValue([rankingCollection]);
    api.getQuality.mockResolvedValue([{ ...quality, availableRerankers: ['local'] }]);
    await view();
    expect(screen.getByRole('option', { name: 'Built-in (offline)' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Vertex AI (provided by this deployment)' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Cohere connection' })).toBeNull();
  });

  it('reverts a rejected provider change and reports the failure', async () => {
    api.listCollections.mockResolvedValue([rankingCollection]);
    api.getQuality.mockResolvedValue([{ ...quality, availableRerankers: ['local', 'vertex'] }]);
    api.setReranker.mockRejectedValue(new Error('Operator disabled the provider.'));
    await view();
    await screen.findByRole('option', { name: 'Vertex AI (provided by this deployment)' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Reranker' }), { target: { value: 'vertex' } });
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Reranker' }) as HTMLSelectElement).value).toBe('local'));
  });
});
