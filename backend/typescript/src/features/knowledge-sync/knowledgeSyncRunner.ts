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
import type { SubjectCaller } from '../../host/subjectAccess.js';
import {
  listFolder, fetchKnowledgeSource, fetchKnowledgeSourceBytes, MAX_LIST_FILES,
  type KnowledgeFetchDeps, type ListingIncompleteReason,
} from '../../host/knowledgeSourceFetch.js';
import { ingestDocument, deleteDocument, getCollection } from '../kb/kbService.js';
import { kbMutated } from '../kb/emit.js'; // ADR 0643 D3 — silent per-file re-ingest + ONE batch event
import { getConnection } from '../connections/connectionsService.js';
import { OpenwopError } from '../../types.js';
import {
  diffFolderListing, listFileStates, upsertFileState, deleteFileState,
  getSyncSource, setSyncStatus, retryDelayMs, MAX_CONSECUTIVE_FAILURES,
  beginSyncAttempt, syncLeaseHeld, statusAfterPass, SYNC_LEASE_MS, ERASED_CREATOR,
  type SyncSource,
  // WF-KB-3 — `claimSyncRun` lives in the service (the daemon only re-exported it);
  // import it directly so the runner does not depend on the daemon module being
  // deleted by this migration.
  claimSyncRun,
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
  /** ADR 0605 — the provider listing could not be proved to be the WHOLE folder,
   *  so this pass ingested what it saw and PRUNED NOTHING. Surfaced so the UI and
   *  the source row can say "partially synced" instead of reporting a clean run. */
  listingIncomplete?: ListingIncompleteReason;
}

/** Human-readable reason for a partial listing, for `lastError` + the toast. */
function incompleteListingMessage(reason: ListingIncompleteReason): string {
  if (reason === 'file_cap') {
    return `This folder has more than ${MAX_LIST_FILES} files. Only the first ${MAX_LIST_FILES} were synced, and nothing was removed from the collection.`;
  }
  if (reason === 'bad_page_token') {
    return 'The provider reported more files but returned an unusable continuation token. Part of the folder was synced, and nothing was removed from the collection.';
  }
  return 'The folder was too large to read in one pass. Part of it was synced, and nothing was removed from the collection.';
}


/** image/audio/video — the types that need a paid LLM extraction (OCR/transcription). */
const MEDIA_MIME_RE = /^(image|audio|video)\//i;

/** Run ONE sync pass over a source. Pure of HTTP — composes the host seams above. */
export async function runKnowledgeSyncOnce(deps: { storage: Storage }, source: SyncSource): Promise<SyncRunResult> {
  const conn = await getConnection(source.tenantId, source.connectionId);
  if (!conn) {
    throw new Error(`connection ${source.connectionId} not found`);
  }
  // ADR 0605 Tier 3 (`KSC-2`) — the USE lane's half of the confused-deputy fix.
  //
  // The create route refuses a connection that is not the caller's, but that gate
  // only fires once. This runs on every pass, with no caller present, and it is
  // here that `conn.userId` becomes the acting identity. So check the connection
  // still resolves to the person who bound it; if it does not, FAIL rather than
  // quietly act as whoever it resolves to now.
  //
  // Sources created before `createdBy` existed carry none, and keep the previous
  // behaviour: there is no recorded owner to compare against, and inventing one
  // would fabricate the fact the check depends on. Those rows acquire an owner only
  // by being re-created, which is stated as a residual in ADR 0605 rather than
  // papered over here.
  // Same narrow predicate as the route: a connection that names NO user makes the
  // run act as the bare tenant, so there is no identity to have drifted.
  //
  // ADR 0605 R2 (`KSC-21`) — the creator-ERASED case gets its own message, and it
  // is the same predicate, not a new one. `eraseKnowledgeSyncSubject` tombstones
  // `createdBy` rather than deleting it precisely so this guard stays armed; the
  // generic message below would then say the connection "no longer belongs to the
  // user who created this source", which is true and useless — the user was erased,
  // and the exit is to re-bind, not to reconnect. A PAUSE with an illegible exit is
  // the wedge R1 already caught once in this batch, so say what to do.
  //
  // Guarded by `conn.userId` for the same reason the check below is: a TENANT-LEVEL
  // connection names no person, so an erased CREATOR leaves nothing to impersonate
  // and the source keeps running. The eraser does not pause those either — one
  // predicate, both lanes.
  if (conn.userId && source.createdBy === ERASED_CREATOR) {
    throw new Error(
      `the member who set up sync source ${source.id} has been erased — add the folder again with your own connected account`,
    );
  }
  if (conn.userId && source.createdBy && conn.userId !== source.createdBy) {
    throw new Error(
      `connection ${source.connectionId} no longer belongs to the user who created this sync source — refusing to act as a different user`,
    );
  }
  const fetchDeps: KnowledgeFetchDeps = {
    storage: deps.storage,
    tenantId: source.tenantId,
    // The credential is the connection owner's; a scheduled (system) run acts as them.
    actingUserId: conn.userId ?? source.tenantId,
    orgId: source.orgId,
  };
  // ADR 0643 R3 review (Blocker 2) — every KB write below is taken AS THE CONNECTION
  // OWNER, re-resolved at use, not `PREAUTHORIZED_CALLER`. The source's creation door
  // already resolves the creator against the target collection; this is the half that
  // keeps that decision from outliving the membership behind it: a project-bound
  // collection whose sync owner has since left the project is REFUSED here (the pass
  // records the error, the same way a revoked token would), rather than written into
  // and pruned from PREAUTHORIZED forever. A tenant-level connection has no `userId`
  // and resolves as "no acting user" — fail-closed on a bound collection, unchanged
  // on an ordinary org collection.
  const caller: SubjectCaller = { subject: conn.userId };
  // R4 review (Should 3) — RESOLVE BEFORE PAYING. Readability used to be checked only
  // inside the per-file `deleteDocument`/`ingestDocument`, so a source whose owner had
  // left the project still listed the folder and fetched/downloaded/transcribed every
  // changed file on every pass, forever, then recorded N errors. One read here, one
  // error, no fetch. Thrown (not recorded) so it rides the whole-run failure
  // accounting: `syncNow` backs off and retires the source after
  // MAX_CONSECUTIVE_FAILURES (5) consecutive refusals — the same K a revoked token gets —
  // rather than a bespoke pause the operator would have to learn separately.
  if (!(await getCollection(source.tenantId, source.orgId, source.collectionId, caller))) {
    throw new Error(
      `the target collection ${source.collectionId} is not readable by the connection owner of sync source ${source.id} (a project-bound collection whose owner is no longer a member, or a collection that was deleted) — nothing was fetched`,
    );
  }
  const listed = await listFolder(fetchDeps, source.provider, source.externalFolderId);
  // ADR 0108 OQ-3: when a source opts out of media, filter image/audio/video OUT of the
  // listing BEFORE the diff — so they're never fetched/transcribed, and any previously
  // synced media drops to `toPrune` (the collection mirrors the folder's selected view).
  // The media filter is a DELIBERATE exclusion by the source's owner, so it does not
  // affect the listing's completeness — `complete` rides through unchanged.
  const skipMedia = source.includeMedia === false;
  const files = skipMedia ? listed.files.filter((f) => !MEDIA_MIME_RE.test(f.mimeType)) : listed.files;
  const skippedMedia = listed.files.length - files.length;
  const states = await listFileStates(source.id);
  // ADR 0605 — `diffFolderListing`, not `diffFolder`: an incomplete listing yields
  // an EMPTY `toPrune`, so a folder we could not fully read can never delete the
  // customer's KB documents. The guard is at the one composition owner.
  const diff = diffFolderListing(source.id, { files, complete: listed.complete }, states);

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
      // ADR 0643 D3 — silent per file (a BULK lane); ONE `document.ingested { count }`
      // is emitted for the pass below.
      await deleteDocument(source.tenantId, source.orgId, source.collectionId, f.documentId, caller, { silent: true }).catch(() => undefined); // KBC-1
      await ingestDocument(source.tenantId, source.orgId, actor, source.collectionId, ingestInput, {
        contentTrust: 'untrusted', // ADR 0027 — synced drive content is never trusted
        documentId: f.documentId,
        silent: true,
      }, caller); // KBC-1
      // ADR 0605 Tier 2 — stamp the owning tenant so teardown can find this row.
      // It also BACKFILLS in place: a legacy cursor is rewritten with its tenant
      // the first time its file changes.
      await upsertFileState({
        sourceId: source.id, externalFileId: f.fileId, documentId: f.documentId,
        revision: f.revision, tenantId: source.tenantId,
      });
      ingested += 1;
    } catch (err) {
      errors.push(`ingest ${f.fileId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const p of diff.toPrune) {
    try {
      await deleteDocument(source.tenantId, source.orgId, source.collectionId, p.documentId, caller, { silent: true }).catch(() => undefined); // KBC-1; ADR 0643 D3 bulk lane
      await deleteFileState(source.id, p.fileId);
      pruned += 1;
    } catch (err) {
      errors.push(`prune ${p.fileId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // ADR 0643 D3 — the ONE batch event for this pass (only when it ingested something).
  if (ingested > 0) await kbMutated({ entity: 'document', verb: 'ingested', tenantId: source.tenantId, orgId: source.orgId, collectionId: source.collectionId, count: ingested });

  if (skippedMedia > 0) log.info('knowledge_sync_skipped_media', { sourceId: source.id, skippedMedia });
  if (listed.complete !== true) {
    // Observability for the destructive class: a pass that DECLINED to prune is a
    // materially different event from a clean one, and it must be reconstructible.
    log.warn('knowledge_sync_listing_incomplete', {
      sourceId: source.id, tenantId: source.tenantId,
      reason: listed.incompleteReason ?? 'unknown', listed: listed.files.length, knownFiles: states.length,
    });
  }
  return {
    ingested, pruned, unchanged: diff.unchanged, failed: errors.length, skippedMedia, errors,
    ...(listed.complete !== true ? { listingIncomplete: listed.incompleteReason ?? 'page_budget' } : {}),
  };
}

/**
 * "Sync now" — load the source, TAKE THE SINGLE-RUNNER CLAIM, run one pass, and
 * record the outcome.
 *
 * THIS IS THE ONE CHOKE BOTH LANES PASS THROUGH (ADR 0605 Tier 5, `KSWF-4`). The
 * claim used to live in `processDueSyncs`, so it covered the daemon and not the
 * manual `POST /:id/sync` route — while two code comments asserted it covered both.
 * A guard placed on one of two callers is not a guard on the invariant; putting it
 * at the shared choke is what makes the promise structural rather than a comment.
 *
 * A LOST CLAIM THROWS `conflict` (409) and deliberately does NOT touch the source's
 * status: another lane is running this very pass, so recording an error here would
 * report a failure that did not happen and would clobber that lane's bookkeeping.
 *
 * ADR 0605 R1 (review HIGH 1) — the claim is taken UNDER A LEASE. `claimOnce` is
 * never released on failure, so before the lease the FIRST crash mid-pass wedged
 * the source permanently: the key is derived from the row, the row only moves at
 * the end of a pass, and a pass that died never got there. `beginSyncAttempt`
 * stamps `syncStartedAt` between winning the claim and running, which rotates the
 * key immediately — the `scheduleDaemon` advance-before-dispatch shape. See
 * `SyncSource.syncStartedAt`.
 *
 * ADR 0605 R1 (review HIGH 3) — a pass NEVER changes whether the source is
 * scheduled. `statusAfterPass` preserves `paused`; a `connection-revoked` pause
 * additionally refuses the run outright, below.
 *
 * OUTCOMES (ADR 0605 Tier 5, `KSWF-2`; schedule lane preserved by `statusAfterPass`):
 *  - clean pass                -> `active`, `lastSyncedAt` stamped, retry state CLEARED
 *  - whole-run failure, n < N  -> stays `active` with `consecutiveFailures` + an
 *                                 exponential `nextAttemptAt`, so the cadence
 *                                 re-arms itself instead of stopping forever
 *  - whole-run failure, n >= N -> `error`, which now means "a human must look"
 *                                 rather than "one 502 happened once"
 *  - any of the above on a PAUSED source -> stays `paused`, reason intact
 */
export async function syncNow(deps: { storage: Storage }, tenantId: string, sourceId: string, now: string): Promise<SyncRunResult> {
  const source = await getSyncSource(tenantId, sourceId);
  if (!source) throw new Error('sync source not found');
  const at = Date.parse(now) || Date.now();
  // ADR 0605 R1 (`KSC-17`) — a source paused because its CREDENTIAL was revoked
  // cannot succeed, and the only durable effect of trying is to overwrite the one
  // sentence that tells the user what to do ("Connection revoked — reconnect to
  // resume syncing") with a raw provider error. Refuse the pass instead. This is
  // narrow on purpose: a USER pause is a scheduling preference, and a deliberate
  // one-off manual run is a legitimate override of it now that a pass can no
  // longer re-arm the cadence. Resume clears the reason, so the refusal always
  // has an exit — a gate with no exit is a defect in its own right.
  if (source.status === 'paused' && source.pausedReason === 'connection-revoked') {
    throw new OpenwopError(
      'conflict',
      'This sync source is paused because its connection was revoked. Reconnect the account, then resume the source.',
      409,
      { sourceId, pausedReason: source.pausedReason },
    );
  }
  // A pass believed to be IN FLIGHT. Checked before the claim so the 409 names the
  // real reason, and bounded by `SYNC_LEASE_MS` so it can never be permanent.
  if (syncLeaseHeld(source, at)) {
    throw new OpenwopError(
      'conflict',
      'A sync is already running for this source. Try again once it finishes.',
      409,
      { sourceId, syncStartedAt: source.syncStartedAt, retryAfterMs: SYNC_LEASE_MS },
    );
  }
  if (!(await claimSyncRun(deps.storage, tenantId, source, at))) {
    throw new OpenwopError(
      'conflict',
      'A sync is already running for this source. Try again once it finishes.',
      409,
      { sourceId },
    );
  }
  // Take the lease BEFORE the run — a crash after this point is recoverable.
  await beginSyncAttempt(tenantId, sourceId, now);
  try {
    const result = await runKnowledgeSyncOnce(deps, source);
    // ADR 0605 — a partial listing is a REPORTED outcome, not a silent one. It rides
    // `lastError` (the one field the row already surfaces) ahead of any per-file
    // errors, because "part of your folder was not read and nothing was deleted" is
    // the fact that changes what the user should do.
    const notices = [
      ...(result.listingIncomplete ? [incompleteListingMessage(result.listingIncomplete)] : []),
      ...result.errors.slice(0, 5),
    ];
    await setSyncStatus(tenantId, sourceId, statusAfterPass(source.status, 'ok'), now, {
      lastSyncedAt: now,
      lastError: notices.length > 0 ? notices.join('; ') : undefined,
      retry: null, // a completed pass clears any backoff (ADR 0605 `KSWF-2`)
      syncStartedAt: null, // the pass finished — release the in-flight lease
      // ADR 0605 Tier 6 (`KSU-1`) — PERSIST what the pass did. Without this a
      // SCHEDULED run's deletions were reported nowhere in the product: the daemon
      // discards the return value, and the only report was a 4s toast on a MANUAL run.
      lastRun: {
        at: now,
        ingested: result.ingested, pruned: result.pruned, unchanged: result.unchanged,
        failed: result.failed, skippedMedia: result.skippedMedia,
        ...(result.listingIncomplete ? { listingIncomplete: result.listingIncomplete } : {}),
      },
    });
    log.info('knowledge_sync_completed', {
      tenantId, sourceId, ingested: result.ingested, pruned: result.pruned,
      unchanged: result.unchanged, failed: result.failed,
      ...(result.listingIncomplete ? { listingIncomplete: result.listingIncomplete } : {}),
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // ADR 0605 Tier 5 (`KSWF-2`) — a whole-run failure no longer retires the source
    // on the first try. It counts, backs off, and only becomes terminal after a
    // bounded run of failures.
    const failures = (source.consecutiveFailures ?? 0) + 1;
    const terminal = failures >= MAX_CONSECUTIVE_FAILURES;
    const nextAttemptAt = new Date(at + retryDelayMs(failures)).toISOString();
    // ADR 0605 R1 (review HIGH 3) — `statusAfterPass`, NOT `terminal ? 'error' :
    // 'active'`. The bare form UN-PAUSED a paused source on any failing pass.
    await setSyncStatus(tenantId, sourceId, statusAfterPass(source.status, terminal ? 'terminal' : 'retry'), now, {
      syncStartedAt: null, // the pass ended — release the in-flight lease
      lastError: terminal
        ? `${msg} (stopped after ${failures} consecutive failures — fix the problem, then use Sync now)`
        : `${msg} (attempt ${failures} of ${MAX_CONSECUTIVE_FAILURES}; retrying automatically)`,
      // Keep the counter on the terminal row too: it is the evidence for WHY the
      // source stopped, and clearing it would erase the reason at the moment a
      // human is first asked to look.
      retry: { consecutiveFailures: failures, nextAttemptAt },
    });
    log.warn('knowledge_sync_failed', { tenantId, sourceId, error: msg, consecutiveFailures: failures, terminal });
    throw err;
  }
}
