/**
 * The knowledge-sync PASS and its outcome bookkeeping: `runKnowledgeSyncOnce` + `syncNow`
 * (ADR 0107 Phase 3, hardened by ADR 0605 Tier 1/5/R1). Connections, the provider
 * listing/fetch and the KB writes are mocked; the real diff, file-state cursor, claim
 * storage, source row and per-source scheduler job drive it.
 *
 * What each case guards, and the sabotage that reds it:
 *  - SECURITY: synced content is ingested `contentTrust:'untrusted'` (ADR 0027) with the
 *    stable `sync:<source>:<file>` id in the PRIVILEGED argument (#3333), and every KB
 *    write is taken AS THE CONNECTION OWNER (`{ subject: conn.userId }`, ADR 0643 R3
 *    Blocker 2, `KBC-1`), never the pre-authorized bypass. Flip the trust or swap the
 *    caller and the exact-arity `toHaveBeenCalledWith`s red.
 *  - ROUTING: a Google-native doc exports as text; every other file downloads bytes with
 *    its provider and mimeType (ADR 0111 audio cap).
 *  - ADR 0108 OQ-3: `includeMedia:false` never fetches media, and prunes synced media.
 *  - ADR 0605 Tier 1: an INCOMPLETE listing prunes nothing and is REPORTED (result,
 *    `lastError`, `lastRun`), never a silent clean run.
 *  - per-file failure isolation; a pruned file loses its KB doc AND its cursor. Prune
 *    cases clear `mDelete` before the pass under test, because the seed pass's
 *    delete-then-ingest already called it with the same document id (that stale call
 *    let a dropped prune pass these cases: probe w23g1-run-prune-delete, vacuous).
 *  - ADR 0605 Tier 5 (`KSWF-2`/`KSWF-4`): a failure backs off with the source still
 *    SCHEDULED (its scheduler job stays enabled); only a run of failures is terminal
 *    (job disabled); the single-runner claim lives in `syncNow` (409 on a lost claim).
 *  - ADR 0605 R1: a pass that dies mid-flight is recoverable after `SYNC_LEASE_MS`; a
 *    pass never un-pauses a source (`statusAfterPass`); a connection-revoked pause
 *    refuses a manual sync before any egress (`KSC-17`).
 *
 * CORRECTED 2026-10-11 (grade-tests w23): three cases used to prove "still scheduled" /
 * "disarmed" through `isSyncDue` + `listActiveSyncSourcesForTenant`. WF-KB-3 deleted the
 * daemon that called them, so neither has a product caller and those assertions vouched
 * for a dead lane. The live gate is the scheduler job's `enabled` flag (asserted below);
 * the surface's backoff skip is asserted in `knowledge-sync-workflow.test.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
/** The caller every KB write must carry: the connection owner (ADR 0643 R3 Blocker 2). */
const OWNER_CALLER = { subject: 'user:owner' };
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots } from '../src/host/workflowChainPackLoader.js';

vi.mock('../src/features/connections/connectionsService.js', () => ({ getConnection: vi.fn() }));
vi.mock('../src/host/knowledgeSourceFetch.js', () => ({ listFolder: vi.fn(), fetchKnowledgeSource: vi.fn(), fetchKnowledgeSourceBytes: vi.fn(), MAX_LIST_FILES: 1000 })); // the real cap, read by the runner's partial-listing message
vi.mock('../src/features/kb/kbService.js', () => ({ ingestDocument: vi.fn(), deleteDocument: vi.fn(), getCollection: vi.fn(async () => ({ collectionId: 'col' })) })); // `getCollection` (ADR 0643 R4 Should 3): the runner resolves the target collection as the connection owner BEFORE listing/fetching — a readable stub here, so these tests keep exercising the per-file lanes

import { getConnection, type Connection } from '../src/features/connections/connectionsService.js';
import {
  listFolder, fetchKnowledgeSource, fetchKnowledgeSourceBytes,
  type SyncFolderListing, type FetchedSource, type FetchedBytes,
} from '../src/host/knowledgeSourceFetch.js';
import { ingestDocument, deleteDocument, type KnowledgeDocument } from '../src/features/kb/kbService.js';
import { runKnowledgeSyncOnce, syncNow } from '../src/features/knowledge-sync/knowledgeSyncRunner.js';
import {
  createSyncSource, getSyncSource, listFileStates, syncDocumentId, claimSyncRun,
  MAX_CONSECUTIVE_FAILURES, setSyncStatus, knowledgeSyncJobId, retryDelayMs,
  pauseSourcesForRevokedConnection, syncStateVersion, statusAfterPass, SYNC_LEASE_MS,
  type SyncSource,
} from '../src/features/knowledge-sync/knowledgeSyncService.js';
import { getJob } from '../src/host/schedulingService.js';

const mConn = vi.mocked(getConnection);
const mList = vi.mocked(listFolder);
const mFetch = vi.mocked(fetchKnowledgeSource);
const mBytes = vi.mocked(fetchKnowledgeSourceBytes);
const mIngest = vi.mocked(ingestDocument);
const mDelete = vi.mocked(deleteDocument);
const NOW = '2026-06-22T00:00:00.000Z';

/** Production-shaped fixtures (typed against the real interfaces — no casts). */
const CONN: Connection = {
  connectionId: 'c1', tenantId: 'tA', userId: 'user:owner', provider: 'google', kind: 'oauth2',
  displayName: 'D', status: 'active', scopes: [], connectedAt: NOW, updatedAt: NOW,
};
const TEXT: FetchedSource = { title: 'Doc', text: 'hello world', sourceUrl: 'https://drive.example/doc' };
const BYTES: FetchedBytes = { title: 'File', contentBase64: 'YmFzZTY0', contentType: 'application/pdf', sourceUrl: 'https://drive.example/file' };
const INGESTED: Omit<KnowledgeDocument, 'text'> = {
  documentId: 'd', collectionId: 'col', tenantId: 'tA', orgId: 'org1', title: 'Doc',
  source: { kind: 'text' }, contentTrust: 'untrusted', chunkCount: 1, createdBy: 'user:owner', createdAt: NOW,
};

/** Is the source's per-source scheduler job armed? (The live "is it scheduled" gate.) */
const jobEnabled = async (sourceId: string): Promise<boolean | undefined> =>
  (await getJob(knowledgeSyncJobId(sourceId)))?.enabled;

let source: SyncSource;
/**
 * ADR 0605 Tier 5 — `syncNow` now takes the single-runner claim itself, so it needs
 * a storage with `claimOnce`. A REAL one, not a stub that always returns true: a
 * stub would make every claim assertion in this file vacuous.
 */
let storage: Awaited<ReturnType<typeof openStorage>>;
const runDeps = (): { storage: Storage } => ({ storage });
beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  // WF-KB-3 — `createSyncSource` now registers the source's `knowledge-sync.run`
  // workflow + scheduler job, so the chain pack must be loaded (examples/ fallback).
  loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
});
beforeEach(async () => {
  mConn.mockReset(); mList.mockReset(); mFetch.mockReset(); mBytes.mockReset(); mIngest.mockReset(); mDelete.mockReset();
  mConn.mockResolvedValue(CONN);
  mFetch.mockResolvedValue(TEXT);
  mBytes.mockResolvedValue(BYTES);
  mIngest.mockResolvedValue(INGESTED);
  mDelete.mockResolvedValue(undefined);
  source = await createSyncSource('tA', 'org1', { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, NOW);
});
afterEach(() => vi.clearAllMocks());

type ListedFile = SyncFolderListing['files'][number];
// A Google-native doc (Docs) — exported via the TEXT path (fetchKnowledgeSource).
const file = (id: string, rev: string): ListedFile => ({ fileId: id, name: `${id}.doc`, mimeType: 'application/vnd.google-apps.document', revision: rev });
// A binary file (PDF) — downloaded via the BYTES path (fetchKnowledgeSourceBytes).
const binFile = (id: string, rev: string): ListedFile => ({ fileId: id, name: `${id}.pdf`, mimeType: 'application/pdf', revision: rev });
// Media files (need a paid OCR/transcription) — the OQ-3 opt-out targets these.
const imgFile = (id: string, rev: string): ListedFile => ({ fileId: id, name: `${id}.png`, mimeType: 'image/png', revision: rev });
const audFile = (id: string, rev: string): ListedFile => ({ fileId: id, name: `${id}.mp3`, mimeType: 'audio/mpeg', revision: rev });

/** ADR 0605 — `listFolder` returns a listing that says whether it is the WHOLE
 *  folder. A test that means "this is the complete folder" must SAY so; the
 *  runner prunes nothing from a listing that does not. */
const listing = (files: ListedFile[], complete = true): SyncFolderListing => ({ files, complete });

describe('runKnowledgeSyncOnce (ADR 0107 Phase 3)', () => {
  it('ingests NEW files with the stable documentId + untrusted trust, records file state', async () => {
    mList.mockResolvedValue(listing([file('a', 'r1'), file('b', 'r1')]));
    const r = await runKnowledgeSyncOnce(runDeps(), source);
    expect(r).toMatchObject({ ingested: 2, pruned: 0, unchanged: 0, failed: 0 });
    // ingest carried the stable documentId + untrusted fence — and carried them in
    // the PRIVILEGED argument, not in the caller-supplied content. #3333 made
    // `documentId`/`contentTrust` non-caller-settable; asserting the split (rather
    // than `objectContaining` over one merged bag) is what makes a regression that
    // moves them back into `input` fail here instead of at runtime.
    expect(mIngest).toHaveBeenCalledWith('tA', 'org1', 'user:owner', 'col',
      expect.objectContaining({ text: 'hello world' }),
      { documentId: syncDocumentId(source.id, 'a'), contentTrust: 'untrusted', silent: true }, OWNER_CALLER);
    expect(mIngest.mock.calls[0]![4]).not.toHaveProperty('contentTrust');
    expect(mIngest.mock.calls[0]![4]).not.toHaveProperty('documentId');
    expect((await listFileStates(source.id)).map((s) => s.externalFileId).sort()).toEqual(['a', 'b']);
  });

  it('downloads a BINARY file (PDF) as bytes and ingests contentBase64 + contentType', async () => {
    mList.mockResolvedValue(listing([binFile('p', 'r1')]));
    const r = await runKnowledgeSyncOnce(runDeps(), source);
    expect(r.ingested).toBe(1);
    expect(mBytes).toHaveBeenCalledWith(expect.anything(), { provider: 'google', ref: 'p', mimeType: 'application/pdf' });
    expect(mFetch).not.toHaveBeenCalled(); // a binary file does NOT use the text path
    expect(mIngest).toHaveBeenCalledWith('tA', 'org1', 'user:owner', 'col',
      expect.objectContaining({ contentBase64: 'YmFzZTY0', contentType: 'application/pdf' }),
      { documentId: syncDocumentId(source.id, 'p'), contentTrust: 'untrusted', silent: true }, OWNER_CALLER);
  });

  it('a Google-native doc uses the TEXT export path, not the bytes download', async () => {
    mList.mockResolvedValue(listing([file('doc', 'r1')])); // application/vnd.google-apps.document
    await runKnowledgeSyncOnce(runDeps(), source);
    expect(mFetch).toHaveBeenCalledWith(expect.anything(), { provider: 'google', ref: 'doc' });
    expect(mBytes).not.toHaveBeenCalled();
  });

  it('a OneDrive (microsoft-graph) source routes ALL files through the bytes download', async () => {
    const ms = await createSyncSource('tA', 'orgMs', { connectionId: 'c1', provider: 'microsoft-graph', externalFolderId: 'root', collectionId: 'col', cadence: 'hourly' }, NOW);
    mList.mockResolvedValue(listing([{ fileId: 'o1', name: 'doc.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', revision: 'r1' }]));
    await runKnowledgeSyncOnce(runDeps(), ms);
    expect(mBytes).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ provider: 'microsoft-graph', ref: 'o1' }));

    expect(mFetch).not.toHaveBeenCalled(); // no text path for OneDrive
  });

  it('passes the file mimeType to the bytes fetch so audio gets the larger download cap (ADR 0111 follow-on)', async () => {
    mList.mockResolvedValue(listing([audFile('a', 'r1')]));
    await runKnowledgeSyncOnce(runDeps(), source);
    expect(mBytes).toHaveBeenCalledWith(expect.anything(), { provider: 'google', ref: 'a', mimeType: 'audio/mpeg' });
  });

  it('includeMedia=false SKIPS image/audio (never fetched/ingested) and counts skippedMedia (ADR 0108 OQ-3)', async () => {
    const s = await createSyncSource('tA', 'orgNM', { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly', includeMedia: false }, NOW);
    mList.mockResolvedValue(listing([binFile('p', 'r1'), imgFile('i', 'r1'), audFile('m', 'r1')]));
    const r = await runKnowledgeSyncOnce(runDeps(), s);
    expect(r).toMatchObject({ ingested: 1, skippedMedia: 2 }); // only the PDF ingested
    expect(mBytes).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ref: 'p' }));
    expect(mBytes).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ref: 'i' })); // image not even fetched
    expect((await listFileStates(s.id)).map((x) => x.externalFileId)).toEqual(['p']);
  });

  it('disabling media PRUNES already-synced media on the next pass (prune-on-disable)', async () => {
    mList.mockResolvedValueOnce(listing([binFile('p', 'r1'), imgFile('i', 'r1')]));
    await runKnowledgeSyncOnce(runDeps(), source); // media included → both ingested
    mDelete.mockClear(); // the seed pass delete-then-ingested `i` — only the prune is under test
    mList.mockResolvedValueOnce(listing([binFile('p', 'r1'), imgFile('i', 'r1')])); // folder unchanged
    const r = await runKnowledgeSyncOnce(runDeps(), { ...source, includeMedia: false });
    expect(r).toMatchObject({ pruned: 1, skippedMedia: 1 }); // the image is dropped from the view → pruned
    expect(mDelete).toHaveBeenCalledWith('tA', 'org1', 'col', syncDocumentId(source.id, 'i'), OWNER_CALLER, { silent: true });
  });

  it('a second pass ingests CHANGED + NEW, prunes DELETED, leaves UNCHANGED', async () => {
    mList.mockResolvedValueOnce(listing([file('a', 'r1'), file('b', 'r1')]));
    await runKnowledgeSyncOnce(runDeps(), source); // seed a=r1, b=r1
    mDelete.mockClear(); // the seed pass delete-then-ingested `b` — only the prune is under test
    // now: a changed (r2), b gone, c new
    mList.mockResolvedValueOnce(listing([file('a', 'r2'), file('c', 'r1')]));
    const r = await runKnowledgeSyncOnce(runDeps(), source);
    expect(r).toMatchObject({ ingested: 2, pruned: 1, unchanged: 0 }); // a(changed)+c(new); b pruned
    expect(mDelete).toHaveBeenCalledWith('tA', 'org1', 'col', syncDocumentId(source.id, 'b'), OWNER_CALLER, { silent: true }); // pruned doc deleted
    const states = (await listFileStates(source.id)).map((s) => `${s.externalFileId}:${s.revision}`).sort();
    expect(states).toEqual(['a:r2', 'c:r1']); // b cursor dropped, a bumped
  });

  // ── ADR 0605 Tier 1 — the runner honours the listing's completeness ────────

  it('an INCOMPLETE listing prunes NOTHING, even though the files are gone from it', async () => {
    mList.mockResolvedValueOnce(listing([file('a', 'r1'), file('b', 'r1')]));
    await runKnowledgeSyncOnce(runDeps(), source); // seed a, b
    // The next pass sees only `a` — but it could not read the whole folder, so
    // `b`'s absence is not evidence that `b` was deleted.
    mDelete.mockClear(); // the seed pass delete-then-ingests; only pass 2 is under test
    mList.mockResolvedValueOnce(listing([file('a', 'r1')], false));
    const r = await runKnowledgeSyncOnce(runDeps(), source);
    expect(r.pruned).toBe(0);
    expect(mDelete).not.toHaveBeenCalled(); // `a` is UNCHANGED, so nothing re-ingests either
    // and the cursor for `b` survives, so a later COMPLETE pass can still act on it
    expect((await listFileStates(source.id)).map((s) => s.externalFileId).sort()).toEqual(['a', 'b']);
  });

  it('a COMPLETE listing still prunes — the guard did not disable the feature', async () => {
    mList.mockResolvedValueOnce(listing([file('a', 'r1'), file('b', 'r1')]));
    await runKnowledgeSyncOnce(runDeps(), source);
    mDelete.mockClear(); // the seed pass delete-then-ingested `b` — only the prune is under test
    mList.mockResolvedValueOnce(listing([file('a', 'r1')], true));
    const r = await runKnowledgeSyncOnce(runDeps(), source);
    expect(r.pruned).toBe(1);
    expect(mDelete).toHaveBeenCalledWith('tA', 'org1', 'col', syncDocumentId(source.id, 'b'), OWNER_CALLER, { silent: true });
  });

  it('reports the partial listing on the result AND on the source row (never a silent clean run)', async () => {
    mList.mockResolvedValue({ files: [file('a', 'r1')], complete: false, incompleteReason: 'file_cap' });
    const r = await runKnowledgeSyncOnce(runDeps(), source);
    expect(r.listingIncomplete).toBe('file_cap');

    await syncNow(runDeps(), 'tA', source.id, NOW);
    const row = await getSyncSource('tA', source.id);
    expect(row?.status).toBe('active'); // it is a partial success, not a failure
    expect(row?.lastError).toMatch(/more than 1000 files.*nothing was removed/i);
    expect(row?.lastRun).toMatchObject({ at: NOW, listingIncomplete: 'file_cap', pruned: 0 }); // persisted, not just toasted
  });

  it('the media opt-out still prunes over a COMPLETE listing (a deliberate exclusion is not an unknown one)', async () => {
    // Guard against the fix over-reaching: `includeMedia:false` shrinks the file
    // set on purpose, and that must keep pruning.
    mList.mockResolvedValueOnce(listing([binFile('p', 'r1'), imgFile('i', 'r1')]));
    await runKnowledgeSyncOnce(runDeps(), source);
    mList.mockResolvedValueOnce(listing([binFile('p', 'r1'), imgFile('i', 'r1')]));
    const r = await runKnowledgeSyncOnce(runDeps(), { ...source, includeMedia: false });
    expect(r).toMatchObject({ pruned: 1, skippedMedia: 1 });
    expect(r.listingIncomplete).toBeUndefined();
  });

  it('isolates a per-file fetch failure (counts it, ingests the rest)', async () => {
    mList.mockResolvedValue(listing([file('ok', 'r1'), file('bad', 'r1')]));
    mFetch.mockImplementation(async (_d, input) => {
      if (input.ref === 'bad') throw new Error('unsupported file type');
      return { ...TEXT, text: 'ok' };
    });
    const r = await runKnowledgeSyncOnce(runDeps(), source);
    expect(r.ingested).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.errors).toEqual([expect.stringContaining('ingest bad: unsupported file type')]);
    // the GOOD file is the one that landed, and only it got a cursor — the bad one
    // has none, so the next pass retries it
    expect(mIngest).toHaveBeenCalledTimes(1);
    expect(mIngest.mock.calls[0]![5]).toMatchObject({ documentId: syncDocumentId(source.id, 'ok') });
    expect((await listFileStates(source.id)).map((s) => s.externalFileId)).toEqual(['ok']);
  });

  it('syncNow records active + lastSyncedAt on a clean pass', async () => {
    mList.mockResolvedValue(listing([file('a', 'r1')]));
    await syncNow(runDeps(), 'tA', source.id, NOW);
    const ok = await getSyncSource('tA', source.id);
    expect(ok?.status).toBe('active');
    expect(ok?.lastSyncedAt).toBe(NOW);
    expect(ok?.lastError).toBeUndefined();
    expect(ok?.consecutiveFailures).toBeUndefined();
    expect(ok?.nextAttemptAt).toBeUndefined();
  });

  /**
   * ADR 0605 Tier 5 (`KSWF-2` + `KSWF-11`) — THIS TEST WAS RE-POINTED, DELIBERATELY.
   *
   * It used to assert that ONE whole-run failure lands the source in
   * `status:'error'`. The assessment filed that as a test PINNING a defect, and this
   * batch agrees and says so: a single transient failure permanently retiring a
   * scheduled source is not behaviour worth guaranteeing. `status:'error'` was
   * excluded by BOTH `listActiveSyncSourcesForTenant` and `isSyncDue`, so
   * `processDueSyncs(now + 365 days)` returned 0 and only a human clicking could
   * revive it — on a surface that reports the failure nowhere.
   *
   * What the product should guarantee, and what is asserted now: a failure is
   * COUNTED and BACKED OFF while the source stays schedulable, and `error` is
   * reached only after a bounded run of failures, at which point it means "a human
   * must look" rather than "one 502 happened once".
   *
   * The rejection also gets a MATCHER. The old `.rejects.toThrow()` with no argument
   * passed on ANY throw — including a `TypeError` from the `{} as never` storage the
   * file used to hand every call site.
   */
  it('a transient failure BACKS OFF and stays schedulable; only a run of them is terminal', async () => {
    mList.mockResolvedValue(listing([file('a', 'r1')]));

    // failure 1 of 5 — the connection is gone
    mConn.mockResolvedValueOnce(null);
    await expect(syncNow(runDeps(), 'tA', source.id, NOW)).rejects.toThrow(/connection .* not found/);
    const first = await getSyncSource('tA', source.id);
    expect(first?.status).toBe('active');            // NOT retired
    expect(first?.consecutiveFailures).toBe(1);
    expect(first?.nextAttemptAt).toBe(new Date(Date.parse(NOW) + retryDelayMs(1)).toISOString()); // backed off
    expect(first?.lastError).toMatch(/attempt 1 of 5/);
    // …and still SCHEDULED: the per-source scheduler job stays armed (the surface then
    // honours `nextAttemptAt` — witnessed in knowledge-sync-workflow.test.ts).
    expect(await jobEnabled(source.id)).toBe(true);

    // drive it to the terminal state
    let row = first!;
    for (let i = 2; i <= MAX_CONSECUTIVE_FAILURES; i += 1) {
      mConn.mockResolvedValueOnce(null);
      // a distinct `now` each time so the claim key (derived from `updatedAt`) moves
      await expect(syncNow(runDeps(), 'tA', source.id, new Date(Date.parse(NOW) + i * 1000).toISOString()))
        .rejects.toThrow(/connection .* not found/);
      row = (await getSyncSource('tA', source.id))!;
    }
    expect(row.consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(row.status).toBe('error');
    expect(row.lastError).toMatch(/stopped after 5 consecutive failures/);
    expect(await jobEnabled(source.id)).toBe(false); // terminal = no longer scheduled
  });

  it('a clean pass CLEARS the backoff, so a recovered source is not held back', async () => {
    mConn.mockResolvedValueOnce(null);
    await expect(syncNow(runDeps(), 'tA', source.id, NOW)).rejects.toThrow(/not found/);
    expect((await getSyncSource('tA', source.id))?.consecutiveFailures).toBe(1);

    mList.mockResolvedValue(listing([file('a', 'r1')]));
    await syncNow(runDeps(), 'tA', source.id, new Date(Date.parse(NOW) + 60_000).toISOString());
    const healed = await getSyncSource('tA', source.id);
    expect(healed?.status).toBe('active');
    expect(healed?.consecutiveFailures).toBeUndefined();
    expect(healed?.nextAttemptAt).toBeUndefined();
  });

  /** ADR 0605 Tier 5 (`KSWF-4`) — the claim now lives in `syncNow`, the ONE choke
   *  both the daemon tick and `POST /:id/sync` pass through. */
  it('a second concurrent pass over the SAME source state is refused with 409', async () => {
    mList.mockResolvedValue(listing([file('a', 'r1')]));
    const fresh = await createSyncSource('tA', 'orgClaim', { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, NOW);

    // first pass wins and completes
    await syncNow(runDeps(), 'tA', fresh.id, NOW);
    // the completed pass moved the row, so a later pass is a NEW state and may run
    await expect(syncNow(runDeps(), 'tA', fresh.id, NOW)).resolves.toBeDefined(); // updatedAt moved ⇒ a NEW pass is legitimate

    // now the real race: two calls against one unchanged state
    const raced = await createSyncSource('tA', 'orgClaim2', { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, NOW);
    const stored = (await getSyncSource('tA', raced.id))!;
    expect(await claimSyncRun(storage, 'tA', stored, Date.parse(NOW))).toBe(true); // stand in for the other lane
    await expect(syncNow(runDeps(), 'tA', raced.id, NOW)).rejects.toMatchObject({ code: 'conflict', httpStatus: 409 });
    // and a LOST claim must not report a failure that did not happen
    const untouched = await getSyncSource('tA', raced.id);
    expect(untouched?.status).toBe('active');
    expect(untouched?.lastError).toBeUndefined();
    expect(untouched?.consecutiveFailures).toBeUndefined();
  });
});

/** Wait until the in-flight lease appears. The lease is written by `syncNow`
 *  several awaits deep, so a fixed number of microtask turns is not a reliable wait;
 *  `vi.waitFor` polls the real condition (bounded at 2 s). */
async function waitForLease(tenantId: string, sourceId: string): Promise<SyncSource> {
  return vi.waitFor(async () => {
    const row = await getSyncSource(tenantId, sourceId);
    expect(row?.syncStartedAt, 'the in-flight lease was never stamped').toBeTruthy();
    return row!;
  }, { timeout: 2000, interval: 5 });
}

/**
 * ADR 0605 R1 (review HIGH 1) — THE CRASH-RECOVERY WITNESS.
 *
 * `claimOnce` is contractually never released on failure, which is safe only for
 * a key that rotates. Tier 5 deleted the wall-clock slot as "not a safety
 * property, it was the defect" — but that slot WAS the crash-recovery mechanism,
 * and after Tier 5 the key moved only when `setSyncStatus` wrote at the END of a
 * pass. A lane that claimed and died therefore held the claim FOREVER: the review
 * measured `conflict` at +1 min, +1 h, +1 day and +30 days, with the row still
 * `active`, `lastSyncedAt:'never'`, and the UI saying "A sync is already
 * running… Try again once it finishes."
 *
 * THE CRASH IS SIMULATED WITH A PROMISE THAT NEVER SETTLES, deliberately. A
 * thrown error runs `syncNow`'s catch, which writes the row and frees the key —
 * that path was never broken, so a witness built on it would be vacuous. What
 * scale-in, an OOM kill, and a backend deploy landing mid-pass all leave behind
 * is a claim taken and NOTHING after it, which is what this reproduces.
 */
describe('ADR 0605 R1 — a pass that DIES mid-flight leaves the source RECOVERABLE', () => {
  it('the source is refused inside the lease and RUNS AGAIN after it (the wedge is bounded, not permanent)', async () => {
    const crashed = await createSyncSource('tA', 'orgCrash', { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, NOW);
    mList.mockResolvedValue(listing([file('a', 'r1')]));
    // …but THIS pass never returns. Nothing after the lease stamp ever runs.
    mList.mockImplementationOnce(() => new Promise<SyncFolderListing>(() => undefined));
    void syncNow(runDeps(), 'tA', crashed.id, NOW).catch(() => undefined);

    const leased = await waitForLease('tA', crashed.id);
    expect(leased.syncStartedAt).toBe(NOW);
    // The claim key MOVED the moment the pass began — that is the anti-wedge
    // property, and it is what a crash used to leave un-moved forever.
    expect(syncStateVersion(leased)).not.toBe(syncStateVersion(crashed));

    // INSIDE the lease both lanes correctly decline: a pass really is in flight.
    // (`syncNow` is the one choke both the scheduled surface and the route pass through.)
    await expect(syncNow(runDeps(), 'tA', crashed.id, new Date(Date.parse(NOW) + 60_000).toISOString()))
      .rejects.toMatchObject({ code: 'conflict', httpStatus: 409 });

    // AFTER the lease the source recovers — WITHOUT a human, a restart, or the
    // global retention backstop (which is a no-op at OPENWOP_IDEMPOTENCY_TTL_DAYS=0).
    const after = new Date(Date.parse(NOW) + SYNC_LEASE_MS + 60_000).toISOString();
    const recovered = await syncNow(runDeps(), 'tA', crashed.id, after); // both lanes run through syncNow
    expect(recovered.ingested).toBe(1);

    const healed = await getSyncSource('tA', crashed.id);
    expect(healed?.status).toBe('active');
    expect(healed?.lastSyncedAt).toBe(after);   // it really synced — not "still never"
    expect(healed?.syncStartedAt).toBeUndefined(); // and the lease was released
  });

  it('a crashed lane\'s claim key is dead: the recovered state claims cleanly', async () => {
    // The mechanism, isolated from the runner. Pre-fix these two computed the
    // SAME key, so the second could never win and the source never ran again.
    const base = await createSyncSource('tA', 'orgKey', { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, NOW);
    expect(await claimSyncRun(storage, 'tA', base, 1)).toBe(true);   // the lane that died
    const leased: SyncSource = { ...base, syncStartedAt: NOW, updatedAt: NOW };
    expect(await claimSyncRun(storage, 'tA', leased, 2)).toBe(true);  // the lane that recovers
  });
});

/**
 * ADR 0605 R1 (review HIGH 3) — A PASS REPORTS AN OUTCOME; IT MAY NOT RESUME A
 * PAUSED SOURCE.
 *
 * Tier 5 wrote `terminal ? 'error' : 'active'` unconditionally, so one failing
 * "Sync now" click on a paused source set it `active` and dropped its
 * `pausedReason` — re-arming a destructive cadence the user had explicitly
 * stopped. Pre-batch the same line wrote `'error'`, which BOTH
 * `listActiveSyncSourcesForTenant` and `isSyncDue` exclude: destructive of the
 * pause, but not self-resuming. Tier 5 upgraded it into an auto-resume.
 */
describe('ADR 0605 R1 — syncNow preserves the PAUSE (`KSC-17`)', () => {
  const pausedSource = async (org: string): Promise<SyncSource> => {
    const s = await createSyncSource('tA', org, { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, NOW);
    return (await setSyncStatus('tA', s.id, 'paused', NOW, { pausedReason: 'user' }))!;
  };

  it('statusAfterPass: `paused` survives every outcome; the others still follow the run', () => {
    for (const outcome of ['ok', 'retry', 'terminal'] as const) {
      expect(statusAfterPass('paused', outcome)).toBe('paused');
    }
    expect(statusAfterPass('active', 'ok')).toBe('active');
    expect(statusAfterPass('active', 'retry')).toBe('active');
    expect(statusAfterPass('active', 'terminal')).toBe('error');
    expect(statusAfterPass('error', 'ok')).toBe('active'); // recovery from error is unchanged
  });

  it('a FAILING pass on a user-paused source leaves it paused, with its reason', async () => {
    const s = await pausedSource('orgPauseFail');
    mList.mockResolvedValue(listing([file('a', 'r1')]));
    mConn.mockResolvedValueOnce(null);
    await expect(syncNow(runDeps(), 'tA', s.id, new Date(Date.parse(NOW) + 1000).toISOString()))
      .rejects.toThrow(/connection .* not found/);

    const row = (await getSyncSource('tA', s.id))!;
    expect(row.status).toBe('paused');
    expect(row.pausedReason).toBe('user');
    expect(row.consecutiveFailures).toBe(1);          // the OUTCOME is still recorded
    // …and the destructive cadence stays disarmed: the scheduler job is still off
    // (a pass that un-paused the source would re-arm it via setSyncStatus).
    expect(await jobEnabled(s.id)).toBe(false);
  });

  it('a CLEAN pass on a user-paused source records the sync and STILL leaves it paused', async () => {
    const s = await pausedSource('orgPauseOk');
    mList.mockResolvedValue(listing([file('a', 'r1')]));
    const at = new Date(Date.parse(NOW) + 2000).toISOString();
    await syncNow(runDeps(), 'tA', s.id, at);

    const row = (await getSyncSource('tA', s.id))!;
    expect(row.lastSyncedAt).toBe(at);
    expect(row.status).toBe('paused');
    expect(row.pausedReason).toBe('user');
    expect(await jobEnabled(s.id)).toBe(false);
  });

  it('a connection-revoked pause REFUSES the manual sync and keeps the reconnect instruction', async () => {
    const s = await createSyncSource('tA', 'orgRevoked', { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, NOW);
    expect(await pauseSourcesForRevokedConnection('tA', 'c1', NOW)).toBeGreaterThan(0);
    const before = (await getSyncSource('tA', s.id))!;
    expect(before.pausedReason).toBe('connection-revoked');

    mList.mockResolvedValue(listing([file('a', 'r1')]));
    await expect(syncNow(runDeps(), 'tA', s.id, new Date(Date.parse(NOW) + 3000).toISOString()))
      .rejects.toMatchObject({ code: 'conflict', httpStatus: 409 });

    const row = (await getSyncSource('tA', s.id))!;
    expect(row.status).toBe('paused');
    expect(row.pausedReason).toBe('connection-revoked');
    // Tier 6's whole `KSU-3` deliverable — the one sentence that says what to do —
    // survives the click. It used to be overwritten by a raw provider error.
    expect(row.lastError).toMatch(/reconnect/i);
    expect(mList).not.toHaveBeenCalled();  // refused BEFORE any egress
    expect(row.syncStartedAt).toBeUndefined(); // and no claim/lease was burned
  });
});
