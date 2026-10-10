/**
 * KB2UX-1 — `/kb` offers a control only to a caller whose ONE possible outcome
 * is not a 403.
 *
 * The page is admin-tier, and the admin tier admits the built-in `admin` role
 * and any custom role holding a `host:*:manage` scope. But the KB doors ask, per
 * org, for `workspace:write` (every document / collection / config write) and
 * `host:org:manage` (the reindex — OWNER-only). So an `admin` was offered the
 * whole Reindex panel and a `host:teams:manage` member every write on the page.
 *
 * Both polarities, per case: the narrowed caller loses the control AND the
 * owner (positive control) still has it — an "absent" assertion alone passes
 * against a page that rendered nothing.
 *
 * Sabotage-witnessed (wave-6 /grade-tests): `canReindex` keyed on
 * `workspace:write`, `canWrite` dropping its scope check, the `failed` access
 * state collapsed into `ready`, and the owner-only note removed each turn a
 * case here red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Kb = typeof import('../kbClient.js');
const api = vi.hoisted(() => ({
  listOrgs: vi.fn<Kb['listOrgs']>(),
  listCollections: vi.fn<Kb['listCollections']>(),
  listDocuments: vi.fn<Kb['listDocuments']>(),
  getReindexJob: vi.fn<Kb['getReindexJob']>(),
  startReindex: vi.fn<Kb['startReindex']>(),
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
const accessApi = vi.hoisted(() => ({
  getEffectiveAccess: vi.fn<typeof import('../../../client/accessClient.js')['getEffectiveAccess']>(),
}));
vi.mock('../../../client/accessClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...accessApi };
});
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: toasts }));

import { KnowledgeBasePage } from '../KnowledgeBasePage.js';
import type { KbCollection, KbDocument, Org, ReindexJob } from '../kbClient.js';
import type { EffectiveAccess } from '../../../client/accessClient.js';

const OWNER: EffectiveAccess = { roles: ['owner'], scopes: ['workspace:read', 'workspace:write', 'host:org:manage'], basis: 'member' };
const ADMIN: EffectiveAccess = { roles: ['admin'], scopes: ['workspace:read', 'workspace:write', 'host:members:manage'], basis: 'member' };
const TEAMS_ONLY: EffectiveAccess = { roles: ['teams-steward'], scopes: ['workspace:read', 'host:teams:manage'], basis: 'member' };

const ORG: Org = { orgId: 'o1', name: 'Acme' };
const COLLECTION: KbCollection = { collectionId: 'c1', name: 'HR Policies', documentCount: 1, chunkCount: 3, updatedAt: '2026-10-05T00:00:00.000Z' };
const DOC: KbDocument = { documentId: 'd1', title: 'PTO Policy', source: { kind: 'text' }, chunkCount: 3, createdAt: '2026-10-05T00:00:00.000Z' };
const RUNNING: ReindexJob = {
  collectionId: 'c1', targetSpec: { provider: 'local' }, fromSig: 'a', toSig: 'b', totalChunks: 100, embeddedChunks: 40,
  status: 'running', costEstimateTokens: 0, costSpentTokens: 0, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.resetAllMocks();
  api.listOrgs.mockResolvedValue([ORG]);
  api.listCollections.mockResolvedValue([COLLECTION]);
  api.listDocuments.mockResolvedValue([DOC]);
  api.getReindexJob.mockResolvedValue(null);
});
afterEach(cleanup);

const view = async (): Promise<void> => {
  const path = '/kb?org=o1&collection=c1';
  window.history.replaceState({}, '', path);
  render(<MemoryRouter initialEntries={[path]}><KnowledgeBasePage /></MemoryRouter>);
  await screen.findByRole('heading', { name: 'Embedding model & rebuild' });
  await screen.findByText('PTO Policy');
  await waitFor(() => expect(accessApi.getEffectiveAccess).toHaveBeenCalledWith({ orgId: 'o1' }));
};

describe('KB2UX-1 — the reindex is offered only to a caller holding host:org:manage', () => {
  it('an ADMIN (not owner) is not offered Reindex — and is told who can', async () => {
    accessApi.getEffectiveAccess.mockResolvedValue(ADMIN);
    await view();
    await screen.findByText('Only an organization owner can start, continue or discard a rebuild.');
    expect(screen.queryByRole('button', { name: 'Reindex' })).toBeNull();
    // …while every workspace:write control an admin DOES hold is still there.
    expect(screen.getByRole('heading', { name: 'Add a document' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Delete collection/ })).toBeTruthy();
  });

  it('an ADMIN watching a LIVE job sees its progress but no Continue / Discard', async () => {
    accessApi.getEffectiveAccess.mockResolvedValue(ADMIN);
    api.getReindexJob.mockResolvedValue(RUNNING);
    await view();
    await screen.findByText('Only an organization owner can start, continue or discard a rebuild.');
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue rebuild' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard rebuild' })).toBeNull();
  });

  it('positive control: the OWNER keeps Reindex, Continue and Discard', async () => {
    accessApi.getEffectiveAccess.mockResolvedValue(OWNER);
    api.getReindexJob.mockResolvedValue(RUNNING);
    await view();
    expect(await screen.findByRole('button', { name: 'Continue rebuild' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard rebuild' })).toBeTruthy();
    expect(screen.queryByText('Only an organization owner can start, continue or discard a rebuild.')).toBeNull();
  });
});

describe('KB2UX-1 — every write is offered only to a caller holding workspace:write', () => {
  it('a host:teams:manage member (admin-tier, no workspace:write) gets a read-only page that says so', async () => {
    accessApi.getEffectiveAccess.mockResolvedValue(TEAMS_ONLY);
    await view();
    await screen.findByText(/You can search and read this organization’s knowledge base/);
    expect(screen.queryByRole('heading', { name: 'Add a document' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete collection/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete document/ })).toBeNull();
    expect(screen.queryByLabelText('New collection')).toBeNull();
    expect(screen.queryByText('Retrieval')).toBeNull();
    // Search — a READ — is untouched.
    expect(screen.getByLabelText('Ask a question…')).toBeTruthy();
  });

  it('a FAILED permission read hides the writes and SAYS it could not check — never "you have none"', async () => {
    accessApi.getEffectiveAccess.mockRejectedValueOnce(new Error('getEffectiveAccess returned 503'));
    await view();
    await screen.findByText(/couldn’t confirm your permissions/);
    expect(screen.queryByText(/You can search and read/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Add a document' })).toBeNull();

    // Retry re-reads, and an owner answer restores the controls.
    accessApi.getEffectiveAccess.mockResolvedValue(OWNER);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Add a document' })).toBeTruthy();
    expect(screen.queryByText(/couldn’t confirm your permissions/)).toBeNull();
  });

  it('positive control: an OWNER sees no read-only notice and every write', async () => {
    accessApi.getEffectiveAccess.mockResolvedValue(OWNER);
    await view();
    expect(await screen.findByRole('heading', { name: 'Add a document' })).toBeTruthy();
    expect(screen.getByLabelText('New collection')).toBeTruthy();
    expect(screen.queryByText(/You can search and read/)).toBeNull();
    // The owner-side polarity of the ADMIN case's absent Reindex button.
    expect(screen.getByRole('button', { name: 'Reindex' })).toBeTruthy();
  });
});
