/**
 * ADR 0107 Phase 3 — the sync RUN orchestration. The composed seams (Connections,
 * knowledgeSourceFetch, KB ingest/delete) are mocked; the real diff + file-state
 * store drive it. Covers: new-file ingest + stable documentId + untrusted marking,
 * a second pass detecting CHANGED/DELETED, per-file failure isolation, and the
 * source status/lastSyncedAt bookkeeping.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';

vi.mock('../src/features/connections/connectionsService.js', () => ({ getConnection: vi.fn() }));
vi.mock('../src/host/knowledgeSourceFetch.js', () => ({ listFolder: vi.fn(), fetchKnowledgeSource: vi.fn(), fetchKnowledgeSourceBytes: vi.fn() }));
vi.mock('../src/features/kb/kbService.js', () => ({ ingestDocument: vi.fn(), deleteDocument: vi.fn() }));

import { getConnection } from '../src/features/connections/connectionsService.js';
import { listFolder, fetchKnowledgeSource, fetchKnowledgeSourceBytes } from '../src/host/knowledgeSourceFetch.js';
import { ingestDocument, deleteDocument } from '../src/features/kb/kbService.js';
import { runKnowledgeSyncOnce, syncNow } from '../src/features/knowledge-sync/knowledgeSyncRunner.js';
import { createSyncSource, getSyncSource, listFileStates, syncDocumentId, type SyncSource } from '../src/features/knowledge-sync/knowledgeSyncService.js';

const mConn = vi.mocked(getConnection);
const mList = vi.mocked(listFolder);
const mFetch = vi.mocked(fetchKnowledgeSource);
const mBytes = vi.mocked(fetchKnowledgeSourceBytes);
const mIngest = vi.mocked(ingestDocument);
const mDelete = vi.mocked(deleteDocument);
const NOW = '2026-06-22T00:00:00.000Z';

let source: SyncSource;
beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => {
  mConn.mockReset(); mList.mockReset(); mFetch.mockReset(); mBytes.mockReset(); mIngest.mockReset(); mDelete.mockReset();
  mConn.mockResolvedValue({ connectionId: 'c1', tenantId: 'tA', userId: 'user:owner', provider: 'google', kind: 'oauth2', displayName: 'D', status: 'active', scopes: [], connectedAt: NOW } as never);
  mFetch.mockResolvedValue({ title: 'Doc', text: 'hello world' } as never);
  mBytes.mockResolvedValue({ title: 'File', contentBase64: 'YmFzZTY0', contentType: 'application/pdf' } as never);
  mIngest.mockResolvedValue({} as never);
  mDelete.mockResolvedValue(undefined as never);
  source = await createSyncSource('tA', 'org1', { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, NOW);
});
afterEach(() => vi.clearAllMocks());

// A Google-native doc (Docs) — exported via the TEXT path (fetchKnowledgeSource).
const file = (id: string, rev: string) => ({ fileId: id, name: `${id}.doc`, mimeType: 'application/vnd.google-apps.document', revision: rev });
// A binary file (PDF) — downloaded via the BYTES path (fetchKnowledgeSourceBytes).
const binFile = (id: string, rev: string) => ({ fileId: id, name: `${id}.pdf`, mimeType: 'application/pdf', revision: rev });
// Media files (need a paid OCR/transcription) — the OQ-3 opt-out targets these.
const imgFile = (id: string, rev: string) => ({ fileId: id, name: `${id}.png`, mimeType: 'image/png', revision: rev });
const audFile = (id: string, rev: string) => ({ fileId: id, name: `${id}.mp3`, mimeType: 'audio/mpeg', revision: rev });

describe('runKnowledgeSyncOnce (ADR 0107 Phase 3)', () => {
  it('ingests NEW files with the stable documentId + untrusted trust, records file state', async () => {
    mList.mockResolvedValue([file('a', 'r1'), file('b', 'r1')] as never);
    const r = await runKnowledgeSyncOnce({ storage: {} as never }, source);
    expect(r).toMatchObject({ ingested: 2, pruned: 0, unchanged: 0, failed: 0 });
    // ingest carried the stable documentId + untrusted fence
    expect(mIngest).toHaveBeenCalledWith('tA', 'org1', 'user:owner', 'col',
      expect.objectContaining({ documentId: syncDocumentId(source.id, 'a'), contentTrust: 'untrusted', text: 'hello world' }));
    expect((await listFileStates(source.id)).map((s) => s.externalFileId).sort()).toEqual(['a', 'b']);
  });

  it('downloads a BINARY file (PDF) as bytes and ingests contentBase64 + contentType', async () => {
    mList.mockResolvedValue([binFile('p', 'r1')] as never);
    const r = await runKnowledgeSyncOnce({ storage: {} as never }, source);
    expect(r.ingested).toBe(1);
    expect(mBytes).toHaveBeenCalledWith(expect.anything(), { provider: 'google', ref: 'p', mimeType: 'application/pdf' });
    expect(mFetch).not.toHaveBeenCalled(); // a binary file does NOT use the text path
    expect(mIngest).toHaveBeenCalledWith('tA', 'org1', 'user:owner', 'col',
      expect.objectContaining({ documentId: syncDocumentId(source.id, 'p'), contentTrust: 'untrusted', contentBase64: 'YmFzZTY0', contentType: 'application/pdf' }));
  });

  it('a Google-native doc uses the TEXT export path, not the bytes download', async () => {
    mList.mockResolvedValue([file('doc', 'r1')] as never); // application/vnd.google-apps.document
    await runKnowledgeSyncOnce({ storage: {} as never }, source);
    expect(mFetch).toHaveBeenCalledWith(expect.anything(), { provider: 'google', ref: 'doc' });
    expect(mBytes).not.toHaveBeenCalled();
  });

  it('a OneDrive (microsoft-graph) source routes ALL files through the bytes download', async () => {
    const ms = await createSyncSource('tA', 'orgMs', { connectionId: 'c1', provider: 'microsoft-graph', externalFolderId: 'root', collectionId: 'col', cadence: 'hourly' }, NOW);
    mList.mockResolvedValue([{ fileId: 'o1', name: 'doc.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', revision: 'r1' }] as never);
    await runKnowledgeSyncOnce({ storage: {} as never }, ms);
    expect(mBytes).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ provider: 'microsoft-graph', ref: 'o1' }));

    expect(mFetch).not.toHaveBeenCalled(); // no text path for OneDrive
  });

  it('passes the file mimeType to the bytes fetch so audio gets the larger download cap (ADR 0111 follow-on)', async () => {
    mList.mockResolvedValue([audFile('a', 'r1')] as never);
    await runKnowledgeSyncOnce({ storage: {} as never }, source);
    expect(mBytes).toHaveBeenCalledWith(expect.anything(), { provider: 'google', ref: 'a', mimeType: 'audio/mpeg' });
  });

  it('includeMedia=false SKIPS image/audio (never fetched/ingested) and counts skippedMedia (ADR 0108 OQ-3)', async () => {
    const s = await createSyncSource('tA', 'orgNM', { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly', includeMedia: false }, NOW);
    mList.mockResolvedValue([binFile('p', 'r1'), imgFile('i', 'r1'), audFile('m', 'r1')] as never);
    const r = await runKnowledgeSyncOnce({ storage: {} as never }, s);
    expect(r).toMatchObject({ ingested: 1, skippedMedia: 2 }); // only the PDF ingested
    expect(mBytes).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ref: 'p' }));
    expect(mBytes).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ref: 'i' })); // image not even fetched
    expect((await listFileStates(s.id)).map((x) => x.externalFileId)).toEqual(['p']);
  });

  it('disabling media PRUNES already-synced media on the next pass (prune-on-disable)', async () => {
    mList.mockResolvedValueOnce([binFile('p', 'r1'), imgFile('i', 'r1')] as never);
    await runKnowledgeSyncOnce({ storage: {} as never }, source); // media included → both ingested
    mList.mockResolvedValueOnce([binFile('p', 'r1'), imgFile('i', 'r1')] as never); // folder unchanged
    const r = await runKnowledgeSyncOnce({ storage: {} as never }, { ...source, includeMedia: false });
    expect(r).toMatchObject({ pruned: 1, skippedMedia: 1 }); // the image is dropped from the view → pruned
    expect(mDelete).toHaveBeenCalledWith('tA', 'org1', 'col', syncDocumentId(source.id, 'i'));
  });

  it('a second pass ingests CHANGED + NEW, prunes DELETED, leaves UNCHANGED', async () => {
    mList.mockResolvedValueOnce([file('a', 'r1'), file('b', 'r1')] as never);
    await runKnowledgeSyncOnce({ storage: {} as never }, source); // seed a=r1, b=r1
    // now: a changed (r2), b gone, c new
    mList.mockResolvedValueOnce([file('a', 'r2'), file('c', 'r1')] as never);
    const r = await runKnowledgeSyncOnce({ storage: {} as never }, source);
    expect(r).toMatchObject({ ingested: 2, pruned: 1, unchanged: 0 }); // a(changed)+c(new); b pruned
    expect(mDelete).toHaveBeenCalledWith('tA', 'org1', 'col', syncDocumentId(source.id, 'b')); // pruned doc deleted
    const states = (await listFileStates(source.id)).map((s) => `${s.externalFileId}:${s.revision}`).sort();
    expect(states).toEqual(['a:r2', 'c:r1']); // b cursor dropped, a bumped
  });

  it('isolates a per-file fetch failure (counts it, ingests the rest)', async () => {
    mList.mockResolvedValue([file('ok', 'r1'), file('bad', 'r1')] as never);
    mFetch.mockImplementation((async (_d: unknown, input: { ref: string }) => {
      if (input.ref === 'bad') throw new Error('unsupported file type');
      return { title: 'Doc', text: 'ok' };
    }) as never);
    const r = await runKnowledgeSyncOnce({ storage: {} as never }, source);
    expect(r.ingested).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.errors[0]).toContain('bad');
  });

  it('syncNow records active + lastSyncedAt on success, error on a whole-run failure', async () => {
    mList.mockResolvedValue([file('a', 'r1')] as never);
    await syncNow({ storage: {} as never }, 'tA', source.id, NOW);
    const ok = await getSyncSource('tA', source.id);
    expect(ok?.status).toBe('active');
    expect(ok?.lastSyncedAt).toBe(NOW);
    expect(ok?.lastError).toBeUndefined();

    // whole-run failure: the connection is gone
    mConn.mockResolvedValueOnce(null as never);
    await expect(syncNow({ storage: {} as never }, 'tA', source.id, NOW)).rejects.toThrow();
    const errored = await getSyncSource('tA', source.id);
    expect(errored?.status).toBe('error');
    expect(errored?.lastError).toContain('not found');
  });
});
