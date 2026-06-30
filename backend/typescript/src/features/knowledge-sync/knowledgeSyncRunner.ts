/**
 * Knowledge-sync RUN orchestration (ADR 0107 Phase 3) — list → diff → fetch+ingest
 * → prune, over the EXISTING owners (no parallel infra):
 *   - list   : `knowledgeSourceFetch.listFolder` (Phase 1, SSRF-guarded broker)
 *   - diff   : the pure `diffFolder` (Phase 3 core)
 *   - ingest : `kbService.ingestDocument` with the STABLE `sync:<source>:<file>`
 *              documentId + `contentTrust:'untrusted'` (ADR 0027 fence). A CHANGED
 *              file is delete-then-ingested so no stale chunks survive.
 *   - prune  : `kbService.deleteDocument` for files gone from the folder.
 * Per-file failures are isolated (counted, not fatal) so one bad file can't abort
 * the sweep. The drive is the source of truth (one-way, OQ-5).
 */
import type { Storage } from '../../storage/storage.js';
import { createLogger } from '../../observability/logger.js';
import { listFolder, fetchKnowledgeSource, fetchKnowledgeSourceBytes, type KnowledgeFetchDeps } from '../../host/knowledgeSourceFetch.js';
import { ingestDocument, deleteDocument } from '../kb/kbService.js';
import { getConnection } from '../connections/connectionsService.js';
import {
  diffFolder, listFileStates, upsertFileState, deleteFileState,
  getSyncSource, setSyncStatus,
  type SyncSource,
} from './knowledgeSyncService.js';

const log = createLogger('features.knowledgeSync.runner');

export interface SyncRunResult {
  ingested: number;
  pruned: number;
  unchanged: number;
  failed: number;
  /** Image/audio/video files skipped because the source opted out of media (ADR 0108 OQ-3). */
  skippedMedia: number;
  errors: string[];
}

/** image/audio/video — the types that need a paid LLM extraction (OCR/transcription). */
const MEDIA_MIME_RE = /^(image|audio|video)\//i;

/** Run ONE sync pass over a source. Pure of HTTP — composes the host seams above. */
export async function runKnowledgeSyncOnce(deps: { storage: Storage }, source: SyncSource): Promise<SyncRunResult> {
  const conn = await getConnection(source.tenantId, source.connectionId);
  if (!conn) {
    throw new Error(`connection ${source.connectionId} not found`);
  }
  const fetchDeps: KnowledgeFetchDeps = {
    storage: deps.storage,
    tenantId: source.tenantId,
    // The credential is the connection owner's; a scheduled (system) run acts as them.
    actingUserId: conn.userId ?? source.tenantId,
    orgId: source.orgId,
  };
  const listed = await listFolder(fetchDeps, source.provider, source.externalFolderId);
  // ADR 0108 OQ-3: when a source opts out of media, filter image/audio/video OUT of the
  // listing BEFORE the diff — so they're never fetched/transcribed, and any previously
  // synced media drops to `toPrune` (the collection mirrors the folder's selected view).
  const skipMedia = source.includeMedia === false;
  const remote = skipMedia ? listed.filter((f) => !MEDIA_MIME_RE.test(f.mimeType)) : listed;
  const skippedMedia = listed.length - remote.length;
  const states = await listFileStates(source.id);
  const diff = diffFolder(source.id, remote, states);

  let ingested = 0;
  let pruned = 0;
  const errors: string[] = [];

  for (const f of diff.toIngest) {
    try {
      const actor = conn.userId ?? 'knowledge-sync';
      // Route by the file's known type: a Google-native doc (Docs/Sheets/Slides) has
      // no raw bytes → export to text; EVERY other file downloads raw bytes so
      // `extractTextFromBytes` tokenizes it (PDF/DOCX/PPTX/XLSX/ODF + text). OneDrive /
      // SharePoint has no native-export types, so all of its files take the bytes path
      // (via the Graph @microsoft.graph.downloadUrl). Fetch BEFORE deleting the prior doc,
      // so a fetch failure leaves it intact.
      // Bytes for everything EXCEPT a Google-native doc (which exports to text); OneDrive,
      // SharePoint, and Dropbox have no native-export types, so all their files take bytes.
      const useBytes = !(source.provider === 'google' && f.mimeType.startsWith('application/vnd.google-apps.'));
      const ingestInput = useBytes
        ? await (async () => {
            const b = await fetchKnowledgeSourceBytes(fetchDeps, { provider: source.provider, ref: f.fileId, mimeType: f.mimeType });
            return { title: f.name || b.title, contentBase64: b.contentBase64, contentType: b.contentType };
          })()
        : await (async () => {
            const t = await fetchKnowledgeSource(fetchDeps, { provider: source.provider, ref: f.fileId });
            return { title: f.name || t.title, text: t.text };
          })();
      // Clean re-ingest: drop any prior doc (CHANGED) so no stale chunks remain.
      await deleteDocument(source.tenantId, source.orgId, source.collectionId, f.documentId).catch(() => undefined);
      await ingestDocument(source.tenantId, source.orgId, actor, source.collectionId, {
        ...ingestInput,
        contentTrust: 'untrusted', // ADR 0027 — synced drive content is never trusted
        documentId: f.documentId,
      });
      await upsertFileState({ sourceId: source.id, externalFileId: f.fileId, documentId: f.documentId, revision: f.revision });
      ingested += 1;
    } catch (err) {
      errors.push(`ingest ${f.fileId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const p of diff.toPrune) {
    try {
      await deleteDocument(source.tenantId, source.orgId, source.collectionId, p.documentId).catch(() => undefined);
      await deleteFileState(source.id, p.fileId);
      pruned += 1;
    } catch (err) {
      errors.push(`prune ${p.fileId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (skippedMedia > 0) log.info('knowledge_sync_skipped_media', { sourceId: source.id, skippedMedia });
  return { ingested, pruned, unchanged: diff.unchanged, failed: errors.length, skippedMedia, errors };
}

/**
 * "Sync now" — load the source, run one pass, and record the outcome
 * (`status`/`lastSyncedAt`/`lastError`). A whole-run failure (e.g. the connection
 * is gone, or the folder listing 4xx'd) flips the source to `error`; a pass that
 * completed (even with some per-file failures) records `active`. Returns the result.
 */
export async function syncNow(deps: { storage: Storage }, tenantId: string, sourceId: string, now: string): Promise<SyncRunResult> {
  const source = await getSyncSource(tenantId, sourceId);
  if (!source) throw new Error('sync source not found');
  try {
    const result = await runKnowledgeSyncOnce(deps, source);
    await setSyncStatus(tenantId, sourceId, 'active', now, {
      lastSyncedAt: now,
      lastError: result.errors.length > 0 ? result.errors.slice(0, 5).join('; ') : undefined,
    });
    log.info('knowledge_sync_completed', { tenantId, sourceId, ingested: result.ingested, pruned: result.pruned, unchanged: result.unchanged, failed: result.failed });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setSyncStatus(tenantId, sourceId, 'error', now, { lastError: msg });
    log.warn('knowledge_sync_failed', { tenantId, sourceId, error: msg });
    throw err;
  }
}
