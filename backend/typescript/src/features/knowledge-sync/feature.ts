/**
 * Knowledge-sync feature (ADR 0107) — scheduled diff-sync of an external-drive
 * folder (via a Connection) into a KB collection.
 *
 * ADR 0605 Tier 7 correction — this docblock used to end: *"Phase 2 ships the
 * config layer …; the `knowledge-sync.run` workflow, scheduler binding, and 'Add
 * sync' UI are later phases."* Every clause of that was false by the time anyone
 * read it, and two of them in OPPOSITE directions, which is why it survived:
 *   - the "later phase" UI and cadence SHIPPED, so the sentence understated what
 *     is running; and
 *   - WF-KB-3 / KSWF-1 (2026-08-31): the `knowledge-sync.run` workflow now EXISTS —
 *     each `SyncSource` registers a per-source, owned, replayable `knowledge-sync.run`
 *     workflow fired by the ONE host scheduler (the gmailSync twin). The bespoke
 *     cadence daemon is DELETED; the recurring sync produces a real run. (ADR 0605
 *     § R2 closed the deviation `KSWF-1` named.)
 *
 * WHAT IS TRUE: `SyncSource` CRUD + the diff-state store + REST (`routes.ts`), the
 * pure diff (`knowledgeSyncService.diffFolder`), the runner (`knowledgeSyncRunner`),
 * the `knowledge-sync` surface + node/chain packs, and the per-source scheduler job
 * (`registerKnowledgeSyncJob`) all ship and are wired. Composes
 * Connections (auth), `knowledgeSourceFetch` (listing/fetch) and KB ingest. OFF by
 * default (a new external-egress surface; opt-in per tenant) — but ON means a
 * schedule that DELETES KB documents when their source file disappears.
 */
import type { BackendFeature } from '../types.js';
import { registerKnowledgeSyncRoutes } from './routes.js';
import { onConnectionRevoked } from '../../host/connectionLifecycle.js';
import { registerTenantPurgeHook } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { pauseSourcesForRevokedConnection, purgeTenantSyncCursors, eraseKnowledgeSyncSubject } from './knowledgeSyncService.js';
import { buildKnowledgeSyncSurface } from './surface.js';

export const knowledgeSyncFeature: BackendFeature = {
  id: 'knowledge-sync',
  registerRoutes: (deps) => {
    registerKnowledgeSyncRoutes(deps);
    // ADR 0285 — pause (never delete) this feature's sources when their
    // connection is revoked; the scheduled run skips paused sources (surface status check + the job disabled), so retries stop.
    onConnectionRevoked('knowledge-sync', async ({ tenantId, connectionId }) => {
      await pauseSourcesForRevokedConnection(tenantId, connectionId, new Date().toISOString());
    });
    // ADR 0605 Tier 2 (`KSWF-6`) — tenant-TEARDOWN pre-hook for the `SyncFileState`
    // diff cursors, which are keyed `<sourceId>:<fileId>` and so carry no tenant in
    // their key. Rows written from now on also carry a `tenantId` FIELD, which the
    // generic content walk reads; this hook is what reaches the LEGACY rows, via the
    // parent `SyncSource` (tenant-prefixed) before the walk deletes it.
    // Registered UNCONDITIONALLY — an erasure must never depend on a feature toggle
    // being on today (the priority-matrix precedent, ADR 0590).
    registerTenantPurgeHook('knowledge-sync', purgeTenantSyncCursors);
    // ADR 0605 R2 (`KSC-21`) — the DSAR eraser for `knowledge-sync:source`.
    // Tier 3's `createdBy` made this store actor-attributed with nothing erasing
    // it: a data-subject deletion left a row naming the erased person AND a
    // schedule still acting as them. It DISABLES rather than deletes — the
    // reasoning is argued in full at `eraseKnowledgeSyncSubject`.
    //
    // A MODULE-LEVEL named reference, never an inline named function expression:
    // `registerSubjectEraser` dedupes BY REFERENCE, so a fresh closure per
    // `registerRoutes` call would register duplicates on repeat boots
    // (`host/subjectEraserManifest.ts`, the sales-commissions lesson).
    //
    // Registered UNCONDITIONALLY, like the purge hook above — an erasure must
    // never depend on a feature toggle being on today (ADR 0590).
    registerSubjectEraser(eraseKnowledgeSyncSubject);
  },
  // WF-KB-3 / KSWF-1 — `ctx.features['knowledge-sync']`, the surface the
  // `knowledge-sync.run` node calls to execute one scheduled sync pass. The id
  // MATCHES the toggle id, so the surface seam (`host/featureSurfaces.ts`) gates
  // every call on the tenant's `knowledge-sync` toggle (a disabled tenant gets
  // `host_capability_disabled`, which the node converts to a clean skip).
  surface: { id: 'knowledge-sync', build: buildKnowledgeSyncSurface },
  toggleDefault: {
    id: 'knowledge-sync',
    label: 'Knowledge sync',
    // ADR 0605 Tier 7 — the sentence a tenant admin reads BEFORE enabling a
    // paid-egress, document-DELETING surface. It used to end "Phase 2 manages sync
    // sources; the scheduled sync run + UI are later phases", which was stale in
    // both halves: the scheduled cadence runs (per-source scheduler jobs) and the UI shipped. It is
    // the single most consequential of the four doc-rot sites in `KSC-13` because
    // it is the only one rendered to a customer. Say what turning this ON does.
    description:
      'Scheduled diff-sync of an external drive folder (Google Drive, OneDrive, SharePoint, Dropbox or Box, via a Connection) into a KB collection (ADR 0107). One-way (drive → KB), content untrusted-fenced, SSRF-guarded egress. Once a source is added it syncs on its own cadence (15m / hourly / daily) with no further action — each pass fetches changed files over paid egress and DELETES KB documents whose source file was removed or renamed, including documents uploaded to that collection by hand. New external-egress surface — OFF by default, opt-in per tenant.',
    category: 'Content',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'knowledge-sync',
  },
};
