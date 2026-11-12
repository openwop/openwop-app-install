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
import { ingestDocument, deleteDocument, getCollection } from '../kb/kbService.js'; // `deleteDocument`: the CHANGED-file clean re-ingest
import { kbMutated } from '../kb/emit.js'; // ADR 0643 D3 — silent per-file re-ingest + ONE batch event
import { getConnection } from '../connections/connectionsService.js';
import { OpenwopError } from '../../types.js';
import {
  diffFolderListing, listFileStates, upsertFileState,
  getSyncSource, beginSyncAttempt, syncLeaseHeld, SYNC_LEASE_MS, ERASED_CREATOR,
  recordPassOutcome, bindingChangedSinceLease, deleteSyncedFile, isDocumentMiss, mutateSource,
  type SyncSource, type PausedReason, type SyncErrorCode, type SyncErrorParams, type PassOutcome,
  // WF-KB-3 — `claimSyncRun` lives in the service (the daemon only re-exported it);
  // import it directly so the runner does not depend on the daemon module being
  // deleted by this migration.
  claimSyncRun,
} from './knowledgeSyncService.js';
import { passActorMayWrite } from './knowledgeSyncAccess.js';
import { assertNoRetentionHold } from '../../host/retentionHold.js';

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
  /** ADR 1101 D1 — the prune phase stopped because the source changed under the
   *  pass (paused, rebound, erased, re-targeted or deleted): nothing more was removed. */
  pruneSkipped?: 'changed';
}

/**
 * ADR 1101 D7 — a whole-run failure with a CODE the panel can render in the
 * reader's language. The message stays the English detail.
 */
export class SyncPassError extends Error {
  constructor(readonly code: SyncErrorCode, message: string, readonly params?: SyncErrorParams) {
    super(message);
    this.name = 'SyncPassError';
  }
}

/**
 * ADR 1101 D3 — the pass may not act at all, and it is nobody's transient fault: the
 * person it acts as was erased, or no longer holds write on the source's org. NOT a
 * failure — counting it would burn the retry budget on a pass that cannot succeed and
 * end on a raw "error". The source is PAUSED with this reason instead, before any
 * egress.
 */
export class SyncPassRefusal extends Error {
  constructor(readonly pausedReason: PausedReason, readonly code: SyncErrorCode, message: string) {
    super(message);
    this.name = 'SyncPassRefusal';
  }
}

/** The code a whole-run failure is recorded under (D7). */
function failureCodeOf(err: unknown): { code: SyncErrorCode; params?: SyncErrorParams } {
  if (err instanceof SyncPassError) return { code: err.code, ...(err.params ? { params: err.params } : {}) };
  // The pinned broker refusing the bound connection (D2) — `no_connection`.
  if (err instanceof OpenwopError && err.code === 'credential_required') return { code: 'connection_unusable' };
  return { code: 'sync_failed' };
}

/** How often the prune phase re-reads the source (ADR 1101 D1). */
const PRUNE_RECHECK_EVERY = 50;

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
    throw new SyncPassError('connection_missing', `connection ${source.connectionId} not found`);
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
    // ADR 1101 D3 — a refusal, not a failure (it pauses; the exit is Rebind, D5b).
    throw new SyncPassRefusal(
      'creator-erased', 'creator_erased',
      `the member who set up sync source ${source.id} has been erased — switch it to your own connected account to resume`,
    );
  }
  if (conn.userId && source.createdBy && conn.userId !== source.createdBy) {
    throw new SyncPassError(
      'connection_owner_changed',
      `connection ${source.connectionId} no longer belongs to the user who created this sync source — refusing to act as a different user`,
    );
  }
  // ADR 1101 D2 — the BOUND connection must be usable. The broker below is pinned to
  // it (no fall-through), so a `needs-reconsent`/`error` row would refuse anyway;
  // failing here names the cause and spends nothing. It backs off like any whole-run
  // failure, because a refresh or a reconnect recovers it.
  if (conn.status !== 'active') {
    throw new SyncPassError('connection_unusable', `connection ${source.connectionId} is ${conn.status} — reconnect the account to resume syncing`, { status: conn.status });
  }
  // ADR 1101 D3 (`KS2WF-3`) — the person every pass acts as must STILL hold write on
  // the source's org. Nothing re-checked it: a member removed from the org (or from a
  // tenant the broker's CHAN-F1 presence check does not reach) kept having their
  // personal drive mirrored into the org's KB every cadence, under their own token.
  // Same predicate as the routes (`holdsOrgScope`), over every spelling of the
  // person. A TENANT-LEVEL connection names no person — no check (ADR 0605). A
  // membership read that ERRORS propagates as an ordinary failure, never a refusal.
  if (conn.userId && !(await passActorMayWrite(source.tenantId, conn.userId, source.orgId))) {
    throw new SyncPassRefusal(
      'creator-no-access', 'creator_no_access',
      `the member whose account sync source ${source.id} uses no longer has write access to this workspace — switch it to your own connected account, or restore their access, to resume`,
    );
  }
  const fetchDeps: KnowledgeFetchDeps = {
    storage: deps.storage,
    tenantId: source.tenantId,
    // The credential is the connection owner's; a scheduled (system) run acts as them.
    actingUserId: conn.userId ?? source.tenantId,
    orgId: source.orgId,
    // ADR 1101 D2 (`KS2WF-2`) — PIN the bound connection on every brokered call. The
    // unpinned broker ran its user → org → workspace fall-through, so a bound token
    // that stopped being `active` silently read the folder as the org's or the
    // workspace's account — and a "complete" listing under THAT account's view prunes
    // every document the bound user could see and it cannot.
    connectionId: source.connectionId,
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
    throw new SyncPassError('collection_unreadable', 
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

  // ADR 1101 D1 — RE-CHECK BEFORE DESTROYING, and again every PRUNE_RECHECK_EVERY
  // prunes. A Pause (or a revocation, an erasure, a rebind, a delete) that landed
  // while this pass ran must stop the deletions, not merely survive them. Compared
  // field by field against the row this pass leased — the eraser and the revocation
  // hook leave an ALREADY-paused row paused, so "is it paused now" would miss them.
  let pruneSkipped: 'changed' | undefined;
  for (let i = 0; i < diff.toPrune.length; i++) {
    if (i % PRUNE_RECHECK_EVERY === 0 && bindingChangedSinceLease(source, await getSyncSource(source.tenantId, source.id))) {
      pruneSkipped = 'changed';
      break;
    }
    const p = diff.toPrune[i]!;
    try {
      // ADR 1101 D6 (`KS2CD-6`) — the document, THEN its cursor; only a document-level
      // miss counts as removed. This used to swallow EVERY delete failure, then drop
      // the cursor and count the file as pruned: a reindex lock or a collection gate
      // left the document in place forever, behind a "N removed" summary.
      await deleteSyncedFile(source, { sourceId: source.id, externalFileId: p.fileId, documentId: p.documentId, revision: '' }, caller); // KBC-1; ADR 0643 D3 bulk lane
      pruned += 1;
    } catch (err) {
      // The connection owner lost the collection mid-pass: stop pruning, keep every
      // cursor, and say so — the per-file lane would record N identical errors.
      if (err instanceof OpenwopError && err.code === 'not_found' && !isDocumentMiss(err)) {
        throw new SyncPassError('collection_unreadable', `the target collection ${source.collectionId} stopped being readable by the connection owner during the sync — nothing more was removed`);
      }
      errors.push(`prune ${p.fileId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (pruneSkipped) log.info('knowledge_sync_prune_skipped', { sourceId: source.id, tenantId: source.tenantId, reason: pruneSkipped });
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
    ...(pruneSkipped ? { pruneSkipped } : {}),
  };
}

/**
 * ADR 1101 D1 — the source was deleted while this pass ran (only a pass that
 * outlived its lease can get here: removal refuses while the lease is held). Remove
 * what the pass wrote, as the identity it wrote it as, so no cursor or document
 * outlives its source. Best-effort per file; a failure keeps that cursor and is
 * logged (the Tier 2 residual, now only on a double failure).
 */
async function sweepAfterDelete(source: SyncSource): Promise<void> {
  // A held tenant's documents are not destroyed by any lane (grade-code #9): keep the
  // cursors, which are then the record of what to remove once the hold lifts.
  try { await assertNoRetentionHold(source.tenantId); }
  catch { log.warn('knowledge_sync_orphan_sweep_held', { sourceId: source.id, tenantId: source.tenantId }); return; }
  let caller: SubjectCaller = { subject: undefined };
  try { caller = { subject: (await getConnection(source.tenantId, source.connectionId))?.userId }; }
  catch { /* the sweep below then fails closed per file */ }
  for (const fs of await listFileStates(source.id)) {
    try { await deleteSyncedFile(source, fs, caller); }
    catch (err) { log.warn('knowledge_sync_orphan_sweep_failed', { sourceId: source.id, error: err instanceof Error ? err.message : String(err) }); }
  }
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
export async function syncNow(
  deps: { storage: Storage },
  tenantId: string,
  sourceId: string,
  now: string,
  /** ADR 1101 D9 — the workflow run this pass runs inside (the scheduled lane). */
  opts: { runId?: string } = {},
): Promise<SyncRunResult> {
  const source = await getSyncSource(tenantId, sourceId);
  if (!source) throw new OpenwopError('not_found', 'sync source not found', 404, { sourceId, reason: 'not_found' });
  const at = Date.parse(now) || Date.now();
  // ADR 0605 R1 (`KSC-17`) — a source paused because its CREDENTIAL was revoked
  // cannot succeed, and the only durable effect of trying is to overwrite the one
  // sentence that tells the user what to do ("Connection revoked — reconnect to
  // resume syncing") with a raw provider error. Refuse the pass instead. This is
  // narrow on purpose: a USER pause is a scheduling preference, and a deliberate
  // one-off manual run is a legitimate override of it now that a pass can no
  // longer re-arm the cadence. Resume clears the reason, so the refusal always
  // has an exit — a gate with no exit is a defect in its own right.
  //
  // Every refusal below carries `details.reason`: the surface maps only these NAMED
  // 409s to a benign skip (ADR 1101 D1). It used to map ANY 409 — including the
  // broker's `credential_required` — so a failed pass was reported as "skipped".
  if (source.status === 'paused' && source.pausedReason === 'connection-revoked') {
    throw new OpenwopError(
      'conflict',
      'This sync source is paused because its connection was revoked. Reconnect the account, then resume the source.',
      409,
      { sourceId, pausedReason: source.pausedReason, reason: 'paused_revoked' },
    );
  }
  if (source.status === 'paused' && source.pausedReason === 'removing') {
    throw new OpenwopError('conflict', 'This sync source is being removed.', 409, { sourceId, reason: 'removing' });
  }
  // A pass believed to be IN FLIGHT. Checked before the claim so the 409 names the
  // real reason, and bounded by `SYNC_LEASE_MS` so it can never be permanent.
  if (syncLeaseHeld(source, at)) {
    throw new OpenwopError(
      'conflict',
      'A sync is already running for this source. Try again once it finishes.',
      409,
      { sourceId, syncStartedAt: source.syncStartedAt, retryAfterMs: SYNC_LEASE_MS, reason: 'in_flight' },
    );
  }
  const inFlight = (): OpenwopError => new OpenwopError(
    'conflict', 'A sync is already running for this source. Try again once it finishes.', 409, { sourceId, reason: 'in_flight' },
  );
  if (!(await claimSyncRun(deps.storage, tenantId, source, at))) throw inFlight();
  // Take the lease BEFORE the run — a crash after this point is recoverable. ADR
  // 1101 D1: ONE compare-and-swap against the very row the claim key was computed
  // from; a lost swap means another write landed since (the key has rotated, so
  // nothing wedges). The pass runs on the LEASED row.
  const leased = await beginSyncAttempt(source, now);
  if (!leased) throw inFlight();

  let result: SyncRunResult | undefined;
  let failure: unknown;
  let outcome: PassOutcome;
  try {
    result = await runKnowledgeSyncOnce(deps, leased);
    // ADR 0605 — a partial listing is a REPORTED outcome, not a silent one. It rides
    // `lastError` (the one field the row already surfaces) ahead of any per-file
    // errors, because "part of your folder was not read and nothing was deleted" is
    // the fact that changes what the user should do. ADR 1101 D7 — with its code.
    const notices = [
      ...(result.listingIncomplete ? [incompleteListingMessage(result.listingIncomplete)] : []),
      ...result.errors.slice(0, 5),
    ];
    outcome = {
      kind: 'ok',
      // ADR 0605 Tier 6 (`KSU-1`) — PERSIST what the pass did. Without this a
      // SCHEDULED run's deletions were reported nowhere in the product.
      lastRun: {
        at: now,
        ingested: result.ingested, pruned: result.pruned, unchanged: result.unchanged,
        failed: result.failed, skippedMedia: result.skippedMedia,
        ...(result.listingIncomplete ? { listingIncomplete: result.listingIncomplete } : {}),
        ...(result.pruneSkipped ? { pruneSkipped: result.pruneSkipped } : {}),
        ...(opts.runId ? { runId: opts.runId } : {}),
      },
      ...(notices.length > 0 ? {
        notice: result.listingIncomplete
          ? { message: notices.join('; '), code: 'listing_incomplete' as const, params: { reason: result.listingIncomplete, max: MAX_LIST_FILES } }
          : { message: notices.join('; '), code: 'files_failed' as const, params: { count: result.failed } },
      } : {}),
    };
  } catch (err) {
    failure = err;
    const msg = err instanceof Error ? err.message : String(err);
    outcome = err instanceof SyncPassRefusal
      ? { kind: 'refused', pausedReason: err.pausedReason, message: err.message, code: err.code }
      : { kind: 'failed', message: msg, at, ...failureCodeOf(err) };
  }

  // ADR 1101 D1 — the TERMINAL write, OUTSIDE the try that classified the pass: a
  // bookkeeping write that throws must never re-classify a pass that succeeded as a
  // failure. Decided on the FRESH row (`recordPassOutcome`): a pause made by any lane
  // during the pass survives it; a pass that outlived its lease writes nothing.
  let recorded: Awaited<ReturnType<typeof recordPassOutcome>>;
  try {
    recorded = await recordPassOutcome(tenantId, sourceId, now, now, outcome);
  } catch (err) {
    // The outcome could not be written (every swap lost). Release THIS pass's lease
    // at least, best-effort, so the source is not blocked for `SYNC_LEASE_MS` by a
    // pass that already ended (grade-code #7) — then report the write failure.
    await mutateSource(tenantId, sourceId, (cur) => {
      if (cur.syncStartedAt !== now) return null;
      const next: SyncSource = { ...cur, updatedAt: now };
      delete next.syncStartedAt;
      return next;
    }).catch((releaseErr: unknown) => {
      // Best-effort by design (re-grade N5): the lease then lapses on its own within
      // SYNC_LEASE_MS. Logged so a source blocked for that long is explainable.
      log.warn('knowledge_sync_lease_release_failed', { tenantId, sourceId, error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr) });
    });
    throw err;
  }
  if (recorded === 'missing') await sweepAfterDelete(leased);
  if (recorded === 'superseded') log.warn('knowledge_sync_pass_superseded', { tenantId, sourceId, startedAt: now });

  if (outcome.kind === 'ok' && result) {
    log.info('knowledge_sync_completed', {
      tenantId, sourceId, ingested: result.ingested, pruned: result.pruned,
      unchanged: result.unchanged, failed: result.failed,
      ...(result.listingIncomplete ? { listingIncomplete: result.listingIncomplete } : {}),
      ...(result.pruneSkipped ? { pruneSkipped: result.pruneSkipped } : {}),
    });
    return result;
  }
  if (outcome.kind === 'refused') {
    log.info('knowledge_sync_refused', { tenantId, sourceId, reason: outcome.code });
    throw new OpenwopError('conflict', outcome.message, 409, { sourceId, reason: outcome.code });
  }
  log.warn('knowledge_sync_failed', { tenantId, sourceId, error: outcome.kind === 'failed' ? outcome.message : 'unknown', code: outcome.kind === 'failed' ? outcome.code : undefined });
  throw failure;
}
