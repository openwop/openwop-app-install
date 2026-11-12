/**
 * ADR 1101 — a knowledge-sync pass respects what happens to its source WHILE it runs,
 * acts only as the person and the credential the source is bound to, and reports only
 * deletions it made. Connections, the provider listing/fetch and the KB writes are
 * mocked; the real source row (CAS), cursors, claim storage and scheduler job drive it.
 *
 * What each case guards, and the sabotage that reds it:
 *  - D1 (`KS2WF-1`): a Pause / revocation / DSAR pause made DURING a pass survives the
 *    pass, and its scheduler job stays disabled. Red if `recordPassOutcome` decides the
 *    status from the row read at the START (the pre-1101 `statusAfterPass(source.status)`).
 *  - D1: the prune phase re-checks the source and stops destroying when the binding
 *    changed. Red if the pre-prune `bindingChangedSinceLease` check is removed.
 *  - D1: a pass that OUTLIVED its lease writes nothing over the newer pass's row. Red if
 *    the `fresh.syncStartedAt !== stamp` guard is removed.
 *  - D1: a source deleted mid-pass leaves no cursor behind. Red if `sweepAfterDelete` goes.
 *  - D3 (`KS2WF-3`): a creator who lost write on the org PAUSES the source before any
 *    egress and counts no failure. Red if the `passActorMayWrite` check is removed.
 *  - D2: a bound connection that is not `active` fails before egress, coded. Red if the
 *    status check goes (the pinned broker would then decide, after spending a listing).
 *  - D6 (`KS2CD-6`): only a document-level miss counts as pruned; a reindex lock keeps
 *    the cursor and counts a failure; a collection-gate 404 stops the prune, coded. Red
 *    if prune goes back to `.catch(() => undefined)`.
 *  - D7: every outcome carries a code.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots } from '../src/host/workflowChainPackLoader.js';

vi.mock('../src/features/connections/connectionsService.js', () => ({ getConnection: vi.fn() }));
vi.mock('../src/host/knowledgeSourceFetch.js', () => ({ listFolder: vi.fn(), fetchKnowledgeSource: vi.fn(), fetchKnowledgeSourceBytes: vi.fn(), MAX_LIST_FILES: 1000 }));
vi.mock('../src/features/kb/kbService.js', () => ({ ingestDocument: vi.fn(), deleteDocument: vi.fn(), getCollection: vi.fn(async () => ({ collectionId: 'col' })) }));
vi.mock('../src/features/knowledge-sync/knowledgeSyncAccess.js', () => ({ passActorMayWrite: vi.fn(async () => true), holdsOrgScope: vi.fn(async () => true) }));

import { getConnection, type Connection } from '../src/features/connections/connectionsService.js';
import { listFolder, fetchKnowledgeSource, type SyncFolderListing } from '../src/host/knowledgeSourceFetch.js';
import { ingestDocument, deleteDocument, type KnowledgeDocument } from '../src/features/kb/kbService.js';
import { passActorMayWrite } from '../src/features/knowledge-sync/knowledgeSyncAccess.js';
import { syncNow } from '../src/features/knowledge-sync/knowledgeSyncRunner.js';
import {
  createSyncSource, getSyncSource, listFileStates, upsertFileState, syncDocumentId, setSyncStatus,
  knowledgeSyncJobId, pauseSourcesForRevokedConnection, eraseKnowledgeSyncSubject, deleteSyncSource,
  mutateSource, ERASED_CREATOR, type SyncSource,
} from '../src/features/knowledge-sync/knowledgeSyncService.js';
import { getJob } from '../src/host/schedulingService.js';
import { OpenwopError } from '../src/types.js';

const mConn = vi.mocked(getConnection);
const mList = vi.mocked(listFolder);
const mFetch = vi.mocked(fetchKnowledgeSource);
const mIngest = vi.mocked(ingestDocument);
const mDelete = vi.mocked(deleteDocument);
const mMayWrite = vi.mocked(passActorMayWrite);
const NOW = '2026-06-22T00:00:00.000Z';
const T = 'tP';

const CONN: Connection = {
  connectionId: 'c1', tenantId: T, userId: 'user:owner', provider: 'google', kind: 'oauth2',
  displayName: 'D', status: 'active', scopes: [], connectedAt: NOW, updatedAt: NOW,
};
const INGESTED: Omit<KnowledgeDocument, 'text'> = {
  documentId: 'd', collectionId: 'col', tenantId: T, orgId: 'org1', title: 'Doc',
  source: { kind: 'text' }, contentTrust: 'untrusted', chunkCount: 1, createdBy: 'user:owner', createdAt: NOW,
};
const doc = (id: string, rev: string): SyncFolderListing['files'][number] => ({ fileId: id, name: `${id}.doc`, mimeType: 'application/vnd.google-apps.document', revision: rev });
const listing = (...files: SyncFolderListing['files']): SyncFolderListing => ({ files, complete: true });

let storage: Awaited<ReturnType<typeof openStorage>>;
let source: SyncSource;
const deps = () => ({ storage });
const jobEnabled = async (id: string): Promise<boolean | undefined> => (await getJob(knowledgeSyncJobId(id)))?.enabled;
/** A cursor for a file a PRIOR pass synced, so a pass over a folder without it prunes it. */
const seedCursor = (fileId: string) =>
  upsertFileState({ sourceId: source.id, externalFileId: fileId, documentId: syncDocumentId(source.id, fileId), revision: 'r0', tenantId: T });

beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
});
beforeEach(async () => {
  mConn.mockReset(); mList.mockReset(); mFetch.mockReset(); mIngest.mockReset(); mDelete.mockReset(); mMayWrite.mockReset();
  mConn.mockResolvedValue(CONN);
  mFetch.mockResolvedValue({ title: 'Doc', text: 'hello', sourceUrl: 'https://drive.example/doc' });
  mIngest.mockResolvedValue(INGESTED);
  mDelete.mockResolvedValue(undefined);
  mMayWrite.mockResolvedValue(true);
  source = await createSyncSource(T, 'org1', { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly', createdBy: 'user:owner' }, NOW);
});
afterEach(() => vi.clearAllMocks());

describe('D1 — a pause made DURING a pass survives it (`KS2WF-1`)', () => {
  it('a USER pause mid-pass stays paused, keeps its reason, and its job stays disabled', async () => {
    mList.mockImplementation(async () => {
      await setSyncStatus(T, source.id, 'paused', NOW, { pausedReason: 'user' });
      return listing(doc('a', 'r1'));
    });
    await syncNow(deps(), T, source.id, NOW);
    const after = await getSyncSource(T, source.id);
    expect(after?.status, 'the pass wrote back the status it read when it started').toBe('paused');
    expect(after?.pausedReason).toBe('user');
    expect(await jobEnabled(source.id), 'the pass re-armed the cadence the user stopped').toBe(false);
    expect(after?.syncStartedAt, 'the pass still releases its own lease').toBeUndefined();
    expect(after?.lastRun?.ingested, 'and still records what it did').toBe(1);
  });

  it('a REVOCATION mid-pass keeps its reconnect instruction and code', async () => {
    mList.mockImplementation(async () => {
      await pauseSourcesForRevokedConnection(T, 'c1', NOW);
      return listing(doc('a', 'r1'));
    });
    await syncNow(deps(), T, source.id, NOW);
    const after = await getSyncSource(T, source.id);
    expect(after?.status).toBe('paused');
    expect(after?.pausedReason).toBe('connection-revoked');
    expect(after?.lastErrorCode).toBe('connection_revoked');
    expect(await jobEnabled(source.id)).toBe(false);
  });

  it('a revocation mid-pass on a FAILED pass keeps its code and counts no failure (re-grade N1)', async () => {
    mList.mockImplementation(async () => {
      await pauseSourcesForRevokedConnection(T, 'c1', NOW);
      throw new OpenwopError('credential_required', 'Connect your Google account first, then import.', 409, { provider: 'google' });
    });
    await expect(syncNow(deps(), T, source.id, NOW)).rejects.toThrow(/Connect your Google account/);
    const after = await getSyncSource(T, source.id);
    expect(after?.status).toBe('paused');
    expect(after?.pausedReason).toBe('connection-revoked');
    expect(after?.lastErrorCode, 'the pass error replaced the reconnect instruction').toBe('connection_revoked');
    expect(after?.consecutiveFailures, 'a failure was counted against a source the user must reconnect').toBeUndefined();
    expect(after?.syncStartedAt, 'the lease is still released').toBeUndefined();
  });

  it('a DSAR erasure mid-pass keeps its pause', async () => {
    mList.mockImplementation(async () => {
      await eraseKnowledgeSyncSubject(T, 'user:owner');
      return listing(doc('a', 'r1'));
    });
    await syncNow(deps(), T, source.id, NOW);
    const after = await getSyncSource(T, source.id);
    expect(after?.status).toBe('paused');
    expect(after?.pausedReason).toBe('creator-erased');
    expect(after?.createdBy).toBe(ERASED_CREATOR);
  });
});

describe('D1 — re-check before destroying', () => {
  it('a pause mid-pass STOPS the prune: nothing more is deleted and the cursor is kept', async () => {
    await seedCursor('gone');
    mList.mockImplementation(async () => {
      await setSyncStatus(T, source.id, 'paused', NOW, { pausedReason: 'user' });
      return listing(); // a complete, EMPTY folder: `gone` would be pruned
    });
    const result = await syncNow(deps(), T, source.id, NOW);
    expect(result.pruneSkipped).toBe('changed');
    expect(result.pruned).toBe(0);
    expect(mDelete, 'the pass kept deleting after the user paused it').not.toHaveBeenCalled();
    expect((await listFileStates(source.id)).map((c) => c.externalFileId)).toEqual(['gone']);
    expect((await getSyncSource(T, source.id))?.lastRun?.pruneSkipped).toBe('changed');
  });

  it('an erasure that lands on an ALREADY-paused source (a Sync-now override) also stops the prune', async () => {
    await setSyncStatus(T, source.id, 'paused', NOW, { pausedReason: 'user' });
    await seedCursor('gone');
    mList.mockImplementation(async () => {
      // The eraser leaves an already-paused row paused — only `createdBy` changes.
      await eraseKnowledgeSyncSubject(T, 'user:owner');
      return listing();
    });
    const result = await syncNow(deps(), T, source.id, NOW);
    expect(result.pruneSkipped, 'a status-only re-check would have missed this').toBe('changed');
    expect(mDelete).not.toHaveBeenCalled();
  });

  it('an unchanged source prunes normally (positive control)', async () => {
    await seedCursor('gone');
    mList.mockResolvedValue(listing());
    const result = await syncNow(deps(), T, source.id, NOW);
    expect(result.pruned).toBe(1);
    expect(result.pruneSkipped).toBeUndefined();
    expect(mDelete).toHaveBeenCalledTimes(1);
    expect(await listFileStates(source.id)).toEqual([]);
  });
});

describe('D1 — lease ownership and deletion during a pass', () => {
  it('a pass that OUTLIVED its lease writes nothing over the newer pass', async () => {
    mList.mockImplementation(async () => {
      // A newer pass took the row over (its own lease stamp).
      await mutateSource(T, source.id, (cur) => ({ ...cur, syncStartedAt: '2026-06-22T05:00:00.000Z', updatedAt: '2026-06-22T05:00:00.000Z' }));
      return listing(doc('a', 'r1'));
    });
    await syncNow(deps(), T, source.id, NOW);
    const after = await getSyncSource(T, source.id);
    expect(after?.syncStartedAt, 'the stale pass released the NEWER pass\'s lease').toBe('2026-06-22T05:00:00.000Z');
    expect(after?.lastRun, 'the stale pass clobbered the newer pass\'s bookkeeping').toBeUndefined();
  });

  it('a pass that OUTLIVED its lease stops PRUNING over the cursors the newer pass owns', async () => {
    await seedCursor('gone');
    mList.mockImplementation(async () => {
      await mutateSource(T, source.id, (cur) => ({ ...cur, syncStartedAt: '2026-06-22T05:00:00.000Z', updatedAt: '2026-06-22T05:00:00.000Z' }));
      return listing(); // `gone` would be pruned
    });
    const result = await syncNow(deps(), T, source.id, NOW);
    expect(result.pruneSkipped, 'the stale pass kept deleting beside the newer one').toBe('changed');
    expect(mDelete).not.toHaveBeenCalled();
  });

  it('a source deleted mid-pass leaves no cursor behind', async () => {
    mList.mockImplementation(async () => {
      await deleteSyncSource(T, source.id);
      return listing(doc('a', 'r1'));
    });
    await syncNow(deps(), T, source.id, NOW);
    expect(await getSyncSource(T, source.id)).toBeNull();
    expect(await listFileStates(source.id), 'the pass wrote a cursor for a source that no longer exists').toEqual([]);
    // Once as the CHANGED-file clean re-ingest, once by the post-delete sweep.
    expect(mDelete.mock.calls.filter((c) => c[3] === syncDocumentId(source.id, 'a')).length, 'and removed the document it wrote after the delete').toBe(2);
  });

  it('mutateSource never inserts a missing row', async () => {
    expect(await mutateSource(T, 'sync-does-not-exist', (cur) => cur)).toBeNull();
    expect(await getSyncSource(T, 'sync-does-not-exist')).toBeNull();
  });
});

describe('D3 — the person a pass acts as must still be able to write the org (`KS2WF-3`)', () => {
  it('a creator without write PAUSES the source before any egress, and counts no failure', async () => {
    mMayWrite.mockResolvedValue(false);
    await expect(syncNow(deps(), T, source.id, NOW)).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'creator_no_access' } });
    expect(mList, 'the pass listed the folder of a person who no longer belongs').not.toHaveBeenCalled();
    const after = await getSyncSource(T, source.id);
    expect(after?.status).toBe('paused');
    expect(after?.pausedReason).toBe('creator-no-access');
    expect(after?.lastErrorCode).toBe('creator_no_access');
    expect(after?.consecutiveFailures, 'a refusal is not a failure — it must not burn the retry budget').toBeUndefined();
    expect(mMayWrite).toHaveBeenCalledWith(T, 'user:owner', 'org1');
  });

  it('a membership read that ERRORS is an ordinary failure, never a pause', async () => {
    mMayWrite.mockRejectedValue(new Error('member store unavailable'));
    await expect(syncNow(deps(), T, source.id, NOW)).rejects.toThrow(/member store unavailable/);
    const after = await getSyncSource(T, source.id);
    expect(after?.status).toBe('active');
    expect(after?.consecutiveFailures).toBe(1);
  });

  it('a TENANT-LEVEL connection (no person) is not checked (ADR 0605)', async () => {
    mConn.mockResolvedValue({ ...CONN, userId: undefined });
    mMayWrite.mockResolvedValue(false);
    mList.mockResolvedValue(listing());
    await expect(syncNow(deps(), T, source.id, NOW)).resolves.toMatchObject({ failed: 0 });
    expect(mMayWrite).not.toHaveBeenCalled();
  });
});

describe('D2 — the bound connection must be usable', () => {
  it('a `needs-reconsent` connection fails BEFORE listing, coded `connection_unusable`', async () => {
    mConn.mockResolvedValue({ ...CONN, status: 'needs-reconsent' });
    await expect(syncNow(deps(), T, source.id, NOW)).rejects.toThrow(/needs-reconsent/);
    expect(mList).not.toHaveBeenCalled();
    const after = await getSyncSource(T, source.id);
    expect(after?.lastErrorCode).toBe('connection_unusable');
    expect(after?.consecutiveFailures).toBe(1);
  });
});

describe('D6 — prune counts only real deletions (`KS2CD-6`)', () => {
  it('a document-level miss counts as pruned and drops the cursor', async () => {
    await seedCursor('gone');
    mList.mockResolvedValue(listing());
    mDelete.mockRejectedValueOnce(new OpenwopError('not_found', 'Document not found.', 404, { documentId: syncDocumentId(source.id, 'gone') }));
    const result = await syncNow(deps(), T, source.id, NOW);
    expect(result.pruned).toBe(1);
    expect(await listFileStates(source.id)).toEqual([]);
  });

  it('a reindex lock KEEPS the cursor and counts a failure — it is not a deletion', async () => {
    await seedCursor('gone');
    mList.mockResolvedValue(listing());
    mDelete.mockRejectedValueOnce(new OpenwopError('conflict', 'A reindex is running for this collection.', 409, { collectionId: 'col' }));
    const result = await syncNow(deps(), T, source.id, NOW);
    expect(result.pruned, 'reported a deletion that did not happen').toBe(0);
    expect(result.failed).toBe(1);
    expect((await listFileStates(source.id)).map((c) => c.externalFileId), 'the cursor was dropped, so no pass would ever remove it').toEqual(['gone']);
    expect((await getSyncSource(T, source.id))?.lastErrorCode).toBe('files_failed');
  });

  it('a collection-gate 404 stops the prune with `collection_unreadable`, keeping every cursor', async () => {
    await seedCursor('g1');
    await seedCursor('g2');
    mList.mockResolvedValue(listing());
    mDelete.mockRejectedValue(new OpenwopError('not_found', 'Collection not found.', 404, { collectionId: 'col' }));
    await expect(syncNow(deps(), T, source.id, NOW)).rejects.toThrow(/stopped being readable/);
    expect((await listFileStates(source.id)).length).toBe(2);
    expect(mDelete).toHaveBeenCalledTimes(1);
    expect((await getSyncSource(T, source.id))?.lastErrorCode).toBe('collection_unreadable');
  });
});

describe('D7 — every outcome carries a code; a clean pass clears it', () => {
  it('a partial listing is `listing_incomplete` with its reason, and a clean pass clears the code', async () => {
    mList.mockResolvedValueOnce({ files: [doc('a', 'r1')], complete: false, incompleteReason: 'file_cap' });
    await syncNow(deps(), T, source.id, NOW);
    let after = await getSyncSource(T, source.id);
    expect(after?.lastErrorCode).toBe('listing_incomplete');
    expect(after?.lastErrorParams).toMatchObject({ reason: 'file_cap', max: 1000 });
    mList.mockResolvedValueOnce(listing(doc('a', 'r1')));
    await syncNow(deps(), T, source.id, '2026-06-22T01:00:00.000Z');
    after = await getSyncSource(T, source.id);
    expect(after?.lastErrorCode).toBeUndefined();
    expect(after?.lastError).toBeUndefined();
  });
});
