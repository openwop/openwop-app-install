/**
 * Knowledge-sync feature (ADR 0107) — the CONFIG layer: a `SyncSource` binds an
 * external-drive folder (via a Connection) to a target KB collection, and per-file
 * `SyncFileState` is the diff cursor the sync pass reads/writes. This module owns
 * the durable stores + CRUD; it composes existing owners (Connections, KB).
 *
 * WF-KB-3 / KSWF-1 (was ADR 0605 Tier 7 correction) — the recurring sync IS now a
 * `knowledge-sync.run` workflow. Each `SyncSource` registers a per-source, tenant-
 * owned, replayable workflow (`ensureKnowledgeSyncWorkflow`) fired by the ONE host
 * scheduler via `registerKnowledgeSyncJob` → `startWorkflowRun` — the exact
 * sanctioned seam its isomorphic twin `crm/gmailSyncService` rides. The bespoke
 * self-rescheduling `knowledgeSyncDaemon` (the parallel infra `KSWF-1` named) is
 * DELETED; its pure/hygiene helpers (`isSyncDue`, the claim prune) moved here and
 * its per-tenant spend gate + dispatch moved to the `knowledge-sync` surface's
 * `runOnce`. This did NOT need `WF-KB-10`: the run wraps `runKnowledgeSyncOnce`,
 * which writes directly via `kbService.ingestDocument`/`deleteDocument`, not the
 * read-only `ctx.features.kb` surface — so no KB-write NODE was required (that was
 * only the blocker for a multi-node decomposition). See ADR 0605 § R2.
 *
 * @see docs/adr/0107-knowledge-sync-sources.md
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import type { Storage } from '../../storage/storage.js';
import { OpenwopError } from '../../types.js';
import { getConnection } from '../connections/connectionsService.js';
import { createLogger } from '../../observability/logger.js';
// WF-KB-3 / KSWF-1 — the sanctioned chain+scheduler-job seam this feature now
// rides (replacing the retired knowledgeSyncDaemon), isomorphic to gmailSyncService.
import { getChain, expandChain } from '../../host/workflowChainPackLoader.js';
import { registerWorkflowDurable } from '../../host/workflowsRegistry.js';
import { recordOwnership } from '../../host/workflowOwnership.js';
import { recordRevision } from '../../host/workflowRevisions.js';
import { registerJob, updateJob, deleteJob } from '../../host/schedulingService.js';

const log = createLogger('features.knowledgeSync.service');

/** Sync providers wired: Google Drive, OneDrive (`microsoft-graph`), and SharePoint
 *  (`microsoft-sharepoint` — same Graph connection, a document-library drive). */
const SYNC_PROVIDERS = ['google', 'microsoft-graph', 'microsoft-sharepoint', 'dropbox', 'box'] as const;
export type SyncProvider = (typeof SYNC_PROVIDERS)[number];

/** Allowed sync cadences (mapped to the scheduler in Phase 3). */
const SYNC_CADENCES = ['15m', 'hourly', 'daily'] as const;
export type SyncCadence = (typeof SYNC_CADENCES)[number];

export type SyncStatus = 'active' | 'paused' | 'error';

/**
 * ADR 0605 Tier 6 (`KSU-3`) — WHY a source is paused.
 *
 * A REVOKED credential was painted as an ordinary user pause: the same muted
 * "Paused" chip, plus a Resume button that cannot work, with the real reason only
 * in a `title`/`aria-label` on a non-focusable `<span>` — hover-only and
 * keyboard-unreachable. Two states that need two different user actions
 * ("un-pause" vs "reconnect your account") must not render as one.
 *
 * Absent ⇒ a pause the user performed, which is the backward-compatible reading
 * for every row written before this field.
 *
 * ADR 0605 R2 (`KSC-21`) adds `creator-erased` — a DSAR erased the member whose
 * identity every pass acts as. See `eraseKnowledgeSyncSubject`.
 */
export type PausedReason = 'user' | 'connection-revoked' | 'creator-erased';

/** The outcome of one sync pass, persisted so a SCHEDULED run can be reported. */
export interface SyncRunSummary {
  /** ISO time the pass finished. */
  at: string;
  ingested: number;
  /** Documents DELETED from the collection. The number this whole ADR is about. */
  pruned: number;
  unchanged: number;
  failed: number;
  skippedMedia: number;
  /** Present when the provider listing could not be proved complete (Tier 1), in
   *  which case `pruned` is 0 BY REFUSAL rather than because nothing was deleted. */
  listingIncomplete?: string;
}

export interface SyncSource {
  id: string;
  tenantId: string;
  orgId: string;
  connectionId: string;
  provider: SyncProvider;
  externalFolderId: string;
  collectionId: string;
  cadence: SyncCadence;
  /** When false, image/audio/video files in the folder are SKIPPED (not fetched or
   *  transcribed) — the per-source opt-out for the media-ingest cost blast (ADR 0108
   *  OQ-3). Absent ⇒ true (backward-compat: existing sources keep ingesting media).
   *  Turning it off prunes already-synced media from the collection on the next pass. */
  includeMedia?: boolean;
  status: SyncStatus;
  /** WF-KB-3 / KSWF-1 — the ONE host scheduler job that fires this source's
   *  `knowledge-sync.run` workflow on cadence (replaces the retired daemon).
   *  Absent on pre-migration rows until the boot backfill stamps it. */
  jobId?: string;
  lastSyncedAt?: string;
  lastError?: string;
  /**
   * ADR 0605 Tier 5 (`KSWF-2`) — consecutive whole-run failures, and the earliest
   * time the cadence may try again.
   *
   * Before this, ONE transient failure was terminal: the run set `status:'error'`,
   * and `listActiveSyncSourcesForTenant` and `isSyncDue` each independently
   * excluded anything not `active`. Measured by the assessment as
   * `processDueSyncs(now + 365 days) === 0`. There was no backoff, no attempt
   * counter, and no field to hold one — so the only recovery was a human noticing
   * and clicking, on a surface that reports the failure nowhere.
   *
   * The source now STAYS `active` through a bounded run of failures with an
   * exponential `nextAttemptAt`, and reaches `error` only after
   * `MAX_CONSECUTIVE_FAILURES` — at which point "a human must look" is true rather
   * than assumed. A clean pass clears both.
   */
  consecutiveFailures?: number;
  /** ISO time before which the cadence must not retry. See `consecutiveFailures`. */
  nextAttemptAt?: string;
  /**
   * ADR 0605 R1 (review HIGH 1) — WHEN THE PASS CURRENTLY IN FLIGHT STARTED.
   *
   * Stamped immediately after the claim is won and cleared by every terminal
   * write. It is the `scheduleDaemon` **advance-before-dispatch** shape, and it
   * exists because Tier 5 removed the only crash-recovery mechanism this feature
   * had without replacing it.
   *
   * Tier 5 deleted the wall-clock claim slot as *"not a safety property, it was
   * the defect"*. The first half was wrong: `claimOnce` is CONTRACTUALLY never
   * released on failure (`storage/storage.ts` — *"one skipped tick is the cheaper
   * error"*), which is safe only for a key that ROTATES. `syncStateVersion`
   * rotated only when `setSyncStatus` wrote at the END of a pass, so a lane that
   * claimed and died — scale-in, OOM, or ANY backend deploy landing mid-pass —
   * left the key unchanged and held the claim forever. MEASURED by the review:
   * `syncNow` at +1 min / +1 h / +1 day / +30 days all returned `conflict`, the
   * row stayed `active` with `lastSyncedAt:'never'`, and two `processDueSyncs` a
   * day apart both returned 0, while the UI said *"A sync is already running…
   * Try again once it finishes"* — untruthfully, forever. `scheduleDaemon` warns
   * about exactly this twelve lines from its own key: advancing only after
   * dispatch leaves a slot *"perpetually due AND un-claimable"*.
   *
   * Stamping BEFORE the run does three things at once:
   *  1. it rotates `syncStateVersion`, so a crashed pass's claim key is dead and
   *     the NEXT attempt mints a fresh one — the wedge cannot form;
   *  2. it makes `isSyncDue` false for the lease window, so a daemon tick cannot
   *     start a second lane over a pass that is genuinely running (the racer
   *     suppression `scheduleDaemon` gets from its advanced `nextFireAt`); and
   *  3. it makes `syncNow`'s 409 message TRUE — bounded by `SYNC_LEASE_MS`
   *     rather than permanent.
   *
   * NO WALL-CLOCK EDGE IS REINTRODUCED, which is the thing to check given what
   * Tier 5 removed. `KSWF-5` was a claim KEY derived from the clock, so two lanes
   * either side of a boundary computed DIFFERENT keys and both won. This is a
   * bound on a FIELD; the key stays data-derived, so two lanes arriving at the
   * moment the lease lapses read the same row, compute the same key, and
   * `claimOnce` still admits exactly one.
   */
  syncStartedAt?: string;
  /** ADR 0605 Tier 6 (`KSU-3`) — why this source is paused. Absent ⇒ the user did
   *  it, which is the correct reading for every row written before this existed. */
  pausedReason?: PausedReason;
  /**
   * ADR 0605 Tier 6 (`KSU-1`/`KSU-7`/`KSU-8`) — what the LAST pass actually did.
   *
   * A SCHEDULED sync deletes KB documents and reported it NOWHERE in the product:
   * the daemon discarded the run result in a bare `catch {}`, the row stored no
   * summary, and the only deletion report anywhere was a 4-second auto-dismissing
   * toast on a MANUAL run — i.e. on the one lane the feature does not exist for.
   *
   * Persisting the summary is what lets a scheduled run be reported at all. It also
   * ends two silent states: a pass with per-file errors was recorded `active` and
   * was chip-identical to a clean one, and a media-opted-out source over a folder
   * of images reported "0 updated, 0 removed, 0 failed" — a total no-op that read
   * as a clean full sync.
   */
  lastRun?: SyncRunSummary;
  /**
   * ~~The most recent `knowledge-sync.run` (Phase 3).~~
   *
   * ADR 0605 Tier 7 (`KSWF-8`) — DEAD FIELD, recorded rather than removed. There is
   * no `knowledge-sync.run` and no run of any kind, so nothing has ever written
   * this: `git grep runId -- features/knowledge-sync` returns this declaration and
   * nothing else. It is nevertheless serialised onto every `GET`/`POST` response as
   * `undefined`, so a client author reading the response type reasonably concludes
   * a run id will appear once a sync has happened. It never will.
   *
   * NOT deleted here because deleting it changes the shape of a shipped host-
   * extension response, which is a behaviour change and belongs with a witness, not
   * with a records tier. Left OPEN as `KSWF-8`; it goes away with `KSWF-1` (which
   * would give this feature a real run id) or on its own with a response-shape test.
   */
  runId?: string;
  /**
   * ADR 0605 Tier 3 (`KSC-2`) — the user who created this binding, which is also
   * the identity every subsequent pass is permitted to act as.
   *
   * The route refuses a connection that is not the caller's, but a gate on the
   * CREATION lane is not a gate on the USE lane: the daemon re-reads the connection
   * on every pass and adopts `conn.userId` with no caller present to compare
   * against. Recording the creator gives the run a fixed expectation to check, so a
   * connection that later resolves to a DIFFERENT user fails the run instead of
   * silently acting as that person.
   *
   * OPTIONAL because sources created before this field existed do not have one.
   * Those keep the pre-ADR-0605 behaviour — retro-attributing an owner would be
   * inventing the very fact the check depends on. See `runKnowledgeSyncOnce`.
   */
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SyncFileState {
  sourceId: string;
  externalFileId: string;
  /** The KB doc id this file maps to (`sync:<sourceId>:<fileId>`). */
  documentId: string;
  /** The provider revision (Drive `modifiedTime`) last ingested. */
  revision: string;
  /**
   * ADR 0605 Tier 2 (`KSWF-6`) — the owning tenant, so TEARDOWN can find this row.
   *
   * The row key is `<sourceId>:<fileId>`, which carries NO tenant. `purgeTenantRows`
   * (`host/hostExtPersistence.ts`) is a CONTENT-filtered walk: with no `tenantOf` on
   * the collection it falls back to `jsonTenantId(parsed)`, which reads exactly this
   * field. Without it `rowTenant` was `undefined` for every row, so a tenant purge
   * deleted the `SyncSource` and orphaned its cursors FOREVER — rows carrying the
   * external provider file id, the provider revision, and the KB document id, with
   * no remaining route to a tenant because their only one was the parent row the
   * walk had just deleted. Witnessed by the assessment's `PROBE-KS-4`.
   *
   * OPTIONAL in the type because rows written before this field existed do not have
   * it; see `purgeTenantSyncCursors`, which is what reaches those.
   */
  tenantId?: string;
}

// Tenant-prefixed id ⇒ `listForTenant` is a bounded scan (ADR 0015 / hostExtPersistence).
const sources = new DurableCollection<SyncSource>('knowledge-sync:source', (s) => `${s.tenantId}:${s.id}`);
// Source-prefixed id ⇒ `listByPrefix('<sourceId>:')` is bounded to one source.
const fileStates = new DurableCollection<SyncFileState>('knowledge-sync:filestate', (f) => `${f.sourceId}:${f.externalFileId}`);

function newId(): string {
  return `sync-${randomUUID()}`;
}

export interface CreateSyncSourceInput {
  connectionId: string;
  provider: string;
  externalFolderId: string;
  collectionId: string;
  cadence: string;
  /** Optional; absent ⇒ true (media included). See `SyncSource.includeMedia`. */
  includeMedia?: boolean;
  /** ADR 0605 Tier 3 — the creating user, recorded as the identity later passes
   *  are permitted to act as. See `SyncSource.createdBy`. */
  createdBy?: string;
}

/** Validate + create a sync source. Caller MUST have already authorized
 *  `workspace:write` on `orgId` and validated the connection + collection exist. */
export async function createSyncSource(tenantId: string, orgId: string, input: CreateSyncSourceInput, now: string): Promise<SyncSource> {
  const provider = input.provider;
  if (!(SYNC_PROVIDERS as readonly string[]).includes(provider)) {
    throw new OpenwopError('validation_error', `provider must be one of: ${SYNC_PROVIDERS.join(', ')}.`, 400, { field: 'provider' });
  }
  const cadence = input.cadence;
  if (!(SYNC_CADENCES as readonly string[]).includes(cadence)) {
    throw new OpenwopError('validation_error', `cadence must be one of: ${SYNC_CADENCES.join(', ')}.`, 400, { field: 'cadence' });
  }
  const connectionId = req(input.connectionId, 'connectionId');
  const externalFolderId = req(input.externalFolderId, 'externalFolderId');
  const collectionId = req(input.collectionId, 'collectionId');
  const id = newId();
  const source: SyncSource = {
    id, tenantId, orgId,
    connectionId, provider: provider as SyncProvider, externalFolderId, collectionId,
    cadence: cadence as SyncCadence,
    // Only persist the flag when explicitly false (opt-out); absent ⇒ true.
    ...(input.includeMedia === false ? { includeMedia: false } : {}),
    // ADR 0605 Tier 3 — omit rather than write an empty string, so "unknown owner"
    // (a legacy row) and "owned by nobody" stay the same, checkable fact.
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    status: 'active',
    // WF-KB-3 — the per-source scheduler job that fires this source's sync workflow.
    jobId: knowledgeSyncJobId(id),
    createdAt: now, updatedAt: now,
  };
  // Register the workflow + scheduler job BEFORE persisting the row, so a failure
  // leaves neither a job nor an orphaned source (fail-closed, the gmailSync shape).
  await registerKnowledgeSyncJob(source);
  await sources.put(source);
  return source;
}

function req(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new OpenwopError('validation_error', `\`${field}\` is required.`, 400, { field });
  }
  return v.trim();
}

/** All sync sources in `orgId` for `tenantId` (tenant-bounded scan + org filter). */
export async function listSyncSources(tenantId: string, orgId: string): Promise<SyncSource[]> {
  return (await sources.listForTenant(tenantId)).filter((s) => s.orgId === orgId);
}

/** All ACTIVE sync sources for a tenant (across orgs) — the cadence daemon's scan
 *  input (ADR 0107 Phase 3b). Bounded tenant-prefix scan. */
export async function listActiveSyncSourcesForTenant(tenantId: string): Promise<SyncSource[]> {
  return (await sources.listForTenant(tenantId)).filter((s) => s.status === 'active');
}

/** ALL sync sources for a tenant regardless of status — the boot backfill's scan
 *  input (a PAUSED source still needs a job, registered disabled). WF-KB-3. */
async function listAllSyncSourcesForTenant(tenantId: string): Promise<SyncSource[]> {
  return sources.listForTenant(tenantId);
}

/** Distinct tenants that have ≥1 sync source — the cadence daemon's tenant
 *  enumerator. A daemon-only full scan (mirrors `listGovernedTenants`), run once
 *  per tick. Decouples auto-sync coverage from roster presence: a tenant can sync
 *  its KB without any agents, so enumerating by sync-source presence (not
 *  `listRosterTenants`) is what makes scheduled sync actually fire for them. */
export async function listSyncSourceTenants(): Promise<string[]> {
  const tenants = new Set<string>();
  for (const s of await sources.list()) tenants.add(s.tenantId);
  return [...tenants];
}

// ── WF-KB-3 / KSWF-1 — the chain + scheduler-job wiring (the gmailSyncService twin) ──
// A SyncSource's recurring pass is now a registered, owned, replayable
// `knowledge-sync.run` workflow fired by the ONE host scheduler (`scheduleDaemon`),
// not the retired bespoke `knowledgeSyncDaemon`. Inline here (not a sibling module)
// to avoid a service↔wiring import cycle — the exact shape `gmailSyncService` uses.

const KNOWLEDGE_SYNC_CHAIN_ID = 'knowledge-sync.run';

/** Stable per-source workflow id (mirrors `gmailSyncWorkflowId`). */
export function knowledgeSyncWorkflowId(sourceId: string): string {
  return `${KNOWLEDGE_SYNC_CHAIN_ID}:${sourceId}`;
}
/** Stable per-source scheduler job id. */
export function knowledgeSyncJobId(sourceId: string): string {
  return `ksync:${sourceId}`;
}

function cronForCadence(cadence: SyncCadence): string {
  switch (cadence) {
    case '15m': return '*/15 * * * *';
    case 'hourly': return '0 * * * *';
    case 'daily': return '0 7 * * *';
    default: { const exhaustive: never = cadence; throw new Error(`unreachable cadence: ${String(exhaustive)}`); }
  }
}

/** Idempotently register (+ own + first-revision) the source's
 *  `knowledge-sync.run` workflow so a run resolves as-run on replay/`:fork`. */
export async function ensureKnowledgeSyncWorkflow(tenantId: string, sourceId: string): Promise<string> {
  const workflowId = knowledgeSyncWorkflowId(sourceId);
  const found = getChain(KNOWLEDGE_SYNC_CHAIN_ID);
  if (!found) {
    throw new OpenwopError(
      'internal_error',
      `Workflow chain '${KNOWLEDGE_SYNC_CHAIN_ID}' is not loaded on this host — the knowledge-sync workflow-chain pack must be installed.`,
      500,
      { chainId: KNOWLEDGE_SYNC_CHAIN_ID },
    );
  }
  const expanded = expandChain(found.chain, { params: { sourceId } });
  const def = { ...expanded, workflowId };
  await registerWorkflowDurable(def);
  await recordRevision(tenantId, def);
  await recordOwnership(tenantId, workflowId, { name: found.chain.label, nodeCount: expanded.nodes.length });
  return workflowId;
}

/** Register/refresh the per-source scheduler job (enabled ⇔ source `active`). The
 *  scheduler fires it on cadence → `knowledge-sync.run` → the run node → the
 *  `knowledge-sync` surface's `runOnce` (WF-KB-4 gated). */
export async function registerKnowledgeSyncJob(source: SyncSource): Promise<void> {
  const workflowId = await ensureKnowledgeSyncWorkflow(source.tenantId, source.id);
  const res = await registerJob({
    jobId: knowledgeSyncJobId(source.id),
    tenantId: source.tenantId,
    cronExpr: cronForCadence(source.cadence),
    workflowId,
    enabled: source.status === 'active',
    metadata: { sourceId: source.id },
    featureId: 'knowledge-sync',
  });
  if (!res.ok) throw new OpenwopError('validation_error', res.error.message, 400, { code: res.error.code });
}

/** Re-cadence / pause-resume the per-source job after a config change. */
async function updateKnowledgeSyncJob(source: SyncSource): Promise<void> {
  await updateJob(knowledgeSyncJobId(source.id), {
    cronExpr: cronForCadence(source.cadence),
    enabled: source.status === 'active',
  });
}

/** Remove the per-source job (source deleted). Best-effort — a missing job is fine. */
async function deleteKnowledgeSyncJob(sourceId: string): Promise<void> {
  await deleteJob(knowledgeSyncJobId(sourceId));
}

/** Stamp a source's `jobId` (the backfill's write-back; a point update). */
async function setSyncJobId(tenantId: string, id: string, jobId: string): Promise<void> {
  const current = await sources.get(`${tenantId}:${id}`);
  if (!current || current.tenantId !== tenantId) return;
  await sources.put({ ...current, jobId, updatedAt: new Date().toISOString() });
}

/**
 * Boot backfill (WF-KB-3) — give every pre-migration source (no `jobId`) a
 * registered workflow + scheduler job, idempotently, in place of the deleted
 * daemon start. A PAUSED source is registered with its job DISABLED. Deterministic
 * ids mean a re-run upserts rather than duplicates. Best-effort per source — one
 * bad source must not abort the boot backfill.
 */
export async function backfillKnowledgeSyncJobs(): Promise<number> {
  let backfilled = 0;
  for (const tenantId of await listSyncSourceTenants()) {
    let list: SyncSource[];
    try { list = await listAllSyncSourcesForTenant(tenantId); }
    catch (err) { log.warn('knowledge_sync_backfill_scan_failed', { tenantId, error: err instanceof Error ? err.message : String(err) }); continue; }
    for (const source of list) {
      if (source.jobId) continue; // already migrated
      try {
        await registerKnowledgeSyncJob(source);
        await setSyncJobId(source.tenantId, source.id, knowledgeSyncJobId(source.id));
        backfilled += 1;
      } catch (err) {
        log.warn('knowledge_sync_backfill_source_failed', { tenantId, sourceId: source.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  if (backfilled > 0) log.info('knowledge_sync_backfill_done', { backfilled });
  return backfilled;
}

/** One source, scoped to tenant (fail-closed cross-tenant: returns null). */
export async function getSyncSource(tenantId: string, id: string): Promise<SyncSource | null> {
  const s = await sources.get(`${tenantId}:${id}`);
  return s && s.tenantId === tenantId ? s : null;
}

export async function setSyncStatus(
  tenantId: string,
  id: string,
  status: SyncStatus,
  now: string,
  opts: {
    lastError?: string;
    lastSyncedAt?: string;
    /** ADR 0605 — explicit retry bookkeeping. `null` CLEARS both fields. */
    retry?: { consecutiveFailures: number; nextAttemptAt: string } | null;
    /** ADR 0605 Tier 6 — why a pause happened. `null` CLEARS it (a resume). */
    pausedReason?: PausedReason | null;
    /** ADR 0605 Tier 6 — the last pass's summary, so a SCHEDULED run is reportable. */
    lastRun?: SyncRunSummary;
    /** ADR 0605 R1 — `null` RELEASES the in-flight lease (`syncStartedAt`). Only a
     *  terminal write passes it: pause/resume and the revocation hook must NOT
     *  release a lease they know nothing about, or they would let a second lane
     *  start over a pass that is still running. */
    syncStartedAt?: null;
  } = {},
): Promise<SyncSource | null> {
  const s = await getSyncSource(tenantId, id);
  if (!s) return null;
  const next: SyncSource = {
    ...s,
    status,
    updatedAt: now,
    // A run sets lastError to the message OR clears it on a clean pass; pause/resume
    // leave it untouched (they pass no opts ⇒ lastError preserved via the spread).
    ...('lastError' in opts ? { lastError: opts.lastError } : {}),
    ...(opts.lastSyncedAt !== undefined ? { lastSyncedAt: opts.lastSyncedAt } : {}),
  };
  // Retry state is only touched when the caller says so, so pause/resume and the
  // revocation hook cannot silently reset a backoff they know nothing about.
  if (opts.retry === null) {
    delete next.consecutiveFailures;
    delete next.nextAttemptAt;
  } else if (opts.retry) {
    next.consecutiveFailures = opts.retry.consecutiveFailures;
    next.nextAttemptAt = opts.retry.nextAttemptAt;
  }
  if (opts.pausedReason === null) delete next.pausedReason;
  else if (opts.pausedReason) next.pausedReason = opts.pausedReason;
  // A source that is no longer paused cannot carry a pause reason — otherwise a
  // resumed row keeps saying "reconnect needed" forever.
  if (status !== 'paused') delete next.pausedReason;
  if (opts.lastRun) next.lastRun = opts.lastRun;
  // ADR 0605 R1 — release the in-flight lease only when the caller says so.
  if (opts.syncStartedAt === null) delete next.syncStartedAt;
  await sources.put(next);
  // WF-KB-3 — keep the scheduler job's `enabled` in step with the source status,
  // but ONLY on a real transition (a per-pass status refresh that leaves the status
  // unchanged skips this, so a normal sync does not rewrite the job). Best-effort:
  // the surface's own `status !== 'active'` skip is the correctness authority (a
  // disabled tenant / paused source never spends), so a job-sync failure must never
  // fail the status write — it only trims no-op runs for a long-paused source.
  if (s.status !== status && next.jobId) {
    try { await updateKnowledgeSyncJob(next); }
    catch (err) { log.warn('knowledge_sync_job_sync_failed', { tenantId, id, error: err instanceof Error ? err.message : String(err) }); }
  }
  return next;
}

/**
 * ADR 0605 R1 (review HIGH 1) — TAKE the in-flight lease, BEFORE the pass runs.
 *
 * Deliberately NOT `setSyncStatus`: this write must carry no status semantics at
 * all. A pass is an OUTCOME, not a schedule decision (see `statusAfterPass`), and
 * routing the lease through the status writer is how a "record that we started"
 * turns into a "resume this source" — the review's HIGH 3, which this file's own
 * `setSyncStatus` committed.
 *
 * `updatedAt` moves with it, so `syncStateVersion` — and therefore the claim key
 * — rotates the instant the pass begins. That is the whole anti-wedge property:
 * a crash between here and the terminal write leaves a claim key nothing will
 * ever compute again.
 */
export async function beginSyncAttempt(tenantId: string, id: string, now: string): Promise<SyncSource | null> {
  const s = await getSyncSource(tenantId, id);
  if (!s) return null;
  const next: SyncSource = { ...s, syncStartedAt: now, updatedAt: now };
  await sources.put(next);
  return next;
}

/**
 * How long a stamped `syncStartedAt` is believed to mean "a pass is running".
 *
 * A crash is not observable from outside the dead instance, so a time bound is
 * the only instrument available — the same trade every lease makes. The number
 * is chosen from the two failure modes it sits between, both of which are stated
 * rather than implied:
 *  - TOO SHORT and a genuinely long pass (up to `MAX_LIST_FILES` files fetched,
 *    extracted and embedded) is joined by a second lane over one diff cursor;
 *  - TOO LONG and a crashed source is unrunnable for that long.
 * An hour is comfortably longer than any pass measured, and it bounds a wedge
 * that was previously PERMANENT. The residual — a lease that a pass outlives is
 * still a double-run window — is filed as `KSWF-20` rather than papered over; a
 * renewing heartbeat is the full cure and is not this fix.
 */
export const SYNC_LEASE_MS = 60 * 60 * 1000;

/** Is a pass believed to be in flight for this source at `now` (ms)? PURE.
 *  An unparseable stamp is treated as NO lease — a corrupt field must never be
 *  able to become the permanent wedge this mechanism exists to remove. */
export function syncLeaseHeld(source: SyncSource, now: number): boolean {
  if (!source.syncStartedAt) return false;
  const started = Date.parse(source.syncStartedAt);
  return Number.isFinite(started) && now - started < SYNC_LEASE_MS;
}

/**
 * ADR 0605 R1 (review HIGH 3) — the status a completed pass is allowed to write.
 *
 * A pass reports an OUTCOME. It must never change whether the source is
 * SCHEDULED. Before this, `syncNow` wrote `terminal ? 'error' : 'active'`
 * unconditionally, so ONE failing "Sync now" click on a PAUSED source set it
 * `active` and (via the non-paused branch of `setSyncStatus`) DELETED its
 * `pausedReason` — the daemon then resumed deleting documents from a source the
 * user had explicitly paused. On a `connection-revoked` pause the same click
 * erased Tier 6's entire `KSU-3` deliverable, and nothing re-applies it: there is
 * no `onConnectionRestored`, only `onConnectionRevoked`.
 *
 * Pre-batch this wrote `'error'`, which both `listActiveSyncSourcesForTenant` and
 * `isSyncDue` exclude — destructive of the pause but NOT self-resuming. **Tier 5
 * upgraded it into an auto-resume**, which is this batch's own diagnosis applied
 * to itself: a gate on one lane is not a gate on the invariant.
 *
 * PURE and exported so the rule has one definition the tests read directly.
 */
export function statusAfterPass(current: SyncStatus, outcome: 'ok' | 'retry' | 'terminal'): SyncStatus {
  if (current === 'paused') return 'paused';
  return outcome === 'terminal' ? 'error' : 'active';
}

/**
 * ADR 0605 Tier 5 (`KSWF-2`) — how long to wait after `n` consecutive failures,
 * and when to give up on the cadence entirely.
 *
 * EXPORTED and pure so the daemon, the runner and their tests all read ONE
 * definition rather than three agreeing constants.
 */
export const RETRY_BASE_MS = 15 * 60 * 1000;
const RETRY_MAX_MS = 24 * 60 * 60 * 1000;
/** After this many consecutive failures the source is genuinely `error`: a human
 *  must look. Below it, retiring the source would be a guess. */
export const MAX_CONSECUTIVE_FAILURES = 5;

export function retryDelayMs(consecutiveFailures: number): number {
  const n = Math.max(1, Math.floor(consecutiveFailures));
  // 15m, 30m, 1h, 2h, 4h … capped. `2 ** n` is bounded by the cap, and `n` is
  // bounded by MAX_CONSECUTIVE_FAILURES before it ever reaches this.
  return Math.min(RETRY_BASE_MS * 2 ** (n - 1), RETRY_MAX_MS);
}

/** Patch mutable per-source settings (ADR 0108 OQ-3 follow-on). Currently `includeMedia`
 *  only — flipping it to false makes the next sync prune already-synced media; back to true
 *  re-ingests it. Returns the updated source, or null if it doesn't exist. */
export async function updateSyncSource(
  tenantId: string,
  id: string,
  patch: { includeMedia?: boolean },
  now: string,
): Promise<SyncSource | null> {
  const s = await getSyncSource(tenantId, id);
  if (!s) return null;
  const next: SyncSource = { ...s, updatedAt: now };
  // Persist includeMedia only when explicitly false (opt-out); true ⇒ drop the field so the
  // row matches a default source (absent ⇒ media included). undefined ⇒ leave unchanged.
  if (patch.includeMedia === false) next.includeMedia = false;
  else if (patch.includeMedia === true) delete next.includeMedia;
  await sources.put(next);
  return next;
}

/** Delete a source + cascade its per-file diff state (Phase-3 ingest cleanup is
 *  separate — this only drops the cursor rows). Returns true when it existed. */
/**
 * ADR 0285 — pause (never delete) every source riding a REVOKED connection: the
 * user-authored folder→collection binding survives, visibly paused with the
 * reason on `lastError`, and re-connecting is a resume. The sync daemon only
 * runs `active` sources, so retries stop. Idempotent.
 */
export async function pauseSourcesForRevokedConnection(tenantId: string, connectionId: string, now: string): Promise<number> {
  let paused = 0;
  for (const s of (await sources.listByPrefix(`${tenantId}:`)).filter((x) => x.connectionId === connectionId && x.status === 'active')) {
    // ADR 0605 Tier 6 — mark WHY, so the UI can offer "Reconnect" instead of a
    // Resume button that cannot work.
    await setSyncStatus(tenantId, s.id, 'paused', now, {
      lastError: 'Connection revoked — reconnect to resume syncing.',
      pausedReason: 'connection-revoked',
    });
    paused += 1;
  }
  return paused;
}

// ── DSAR subject erasure (ADR 0605 R2, `KSC-21`) ─────────────────────────────

/**
 * What `createdBy` becomes when its subject is erased. NOT `undefined`, and the
 * difference is the whole point.
 *
 * `runKnowledgeSyncOnce`'s Tier 3 guard is `conn.userId && source.createdBy &&
 * conn.userId !== source.createdBy`, so a row with NO `createdBy` is the LEGACY
 * shape and the guard SKIPS it entirely. Deleting the field on erasure would
 * therefore hand the source back the pre-ADR-0605 behaviour — the confused deputy
 * `KSC-2` closed, re-opened by the erasure itself. **Deletion becomes a grant.**
 * A tombstone keeps the guard armed and fail-closed: no live connection can ever
 * resolve to this value, so every later pass over such a source refuses.
 *
 * Not `''` either — an empty creator reads as "created by nobody", a legacy row,
 * which is the same substitution one character smaller. Mirrors the
 * `ERASED_VALUE` sentinel in `crm/`, `forms/` and `marketplace/erasure.ts`.
 */
export const ERASED_CREATOR = 'erased:subject';

/** The `lastError` a creator-erased pause writes. It must name the EXIT: Resume
 *  flips the schedule back on but the run still refuses (the tombstone above), so
 *  the only way back is a live member binding their own connection. Saying
 *  "paused" without saying that is the wedge R1 already caught once in this batch. */
const ERASED_CREATOR_MESSAGE =
  'The member who set up this sync was erased. Add the folder again with your own connected account to resume syncing.';

/**
 * ADR 0605 R2 (`KSC-21`) — the DSAR eraser for `knowledge-sync:source`.
 *
 * WHY THIS EXISTS. Tier 3 added `SyncSource.createdBy`, which made this store
 * ACTOR-ATTRIBUTED and therefore visible to the ADR 0464 feature-store ratchet for
 * the first time — with no eraser reaching it. The first attempt at closing that
 * recorded a line in `ACTOR_ATTRIBUTED_DEBT`, which the ratchet correctly refused:
 * the ceiling exists precisely to stop a batch growing the ledger to pay for a
 * field the same batch introduced.
 *
 * WHY DISABLE RATHER THAN RE-ATTRIBUTE OR DELETE. `createdBy` here is not
 * provenance — the ledger's usual "an org record its author happens to have
 * created, so re-attribute" reasoning does not apply. It is the confused-deputy
 * GUARD: create validates only the connection's tenant, while every later pass
 * adopts the connection owner's identity, so `createdBy` is the fixed expectation
 * each pass re-checks (`knowledgeSyncRunner`).
 *
 *   - RE-ATTRIBUTE is wrong: the source binds THAT person's Drive credential, so
 *     naming a different member as creator would leave a sync running on a token
 *     whose owner no longer exists to authorise it — the same deputy confusion the
 *     field was added to prevent, re-created by the erasure.
 *   - DELETE is wrong: it silently stops an org's folder sync, and a sync pass
 *     DELETES KB documents, so a half-understood erasure here has destructive
 *     reach into a collection that is not the erased person's data.
 *   - DISABLE is conservative and reversible: pause the schedule, tombstone the
 *     identifier, and require a live member to re-bind their own connection.
 *
 * WHAT THIS DOES, per matching row:
 *   1. TOMBSTONES `createdBy` — the actual erasure. Always, unconditionally.
 *   2. PAUSES the source, but ONLY when the bound connection names a PERSON.
 *
 * (2) IS THE TIER 3 PREDICATE, NOT A NEW ONE. A TENANT-LEVEL connection carries no
 * `userId`, so the run acts as the bare tenant (`conn.userId ?? source.tenantId`):
 * there is nobody to impersonate, hence no deputy to confuse, and pausing it would
 * stop a legitimate org sync in the name of a hole it does not have. That is the
 * exact over-reach `requireOwnConnection`'s first draft made and `routes.ts` calls
 * out. A MISSING or unreadable connection fails CLOSED (pause) — an unknown
 * credential owner is the case we must not keep syncing under.
 *
 * A source that is ALREADY paused keeps its existing `pausedReason`: overwriting a
 * `connection-revoked` pause would destroy the reconnect instruction Tier 6 exists
 * to show, and the row is already in the safe state this eraser wants.
 *
 * KEYED ON `createdBy` ONLY, by exact match, tenant-scoped. RESIDUAL, stated
 * rather than implied (the `marketplace/erasure.ts` precedent): a DSAR arriving
 * only as an email or a CRM `contactId` does not reach this store, because the
 * one shipped resolver (`crm/erasure.ts resolveCrmSubjectKeys`) is one-directional
 * email/phone → contactId. Matching a non-userId key heuristically would pause a
 * STRANGER'S sync on a coincidence, and over-pausing an org's document pipeline is
 * not a harm this eraser gets to trade away.
 *
 * BLIND SPOT, stated: `knowledge-sync:filestate` carries no subject field of any
 * shape (`sourceId`/`externalFileId`/`documentId`/`revision`/`tenantId`), so no
 * widening of the ratchet can see it and this eraser does not touch it. It is a
 * derived cursor over the FOLDER, not over a person; it is reclaimed by
 * `deleteSyncSource`'s cascade and by `purgeTenantSyncCursors` on teardown.
 *
 * IDEMPOTENT BY CONSTRUCTION (the `SubjectEraser` contract requires it — it is
 * invoked once per resolved identity key): after the first pass `createdBy` is the
 * tombstone, so the subject no longer matches and a second call is a no-op.
 * Returns `void` rather than a `SubjectEraseReport` deliberately: `foundNothing`
 * is a fan-out-wide aggregate, and opting a new eraser into it changes what an
 * unrelated DSAR reports.
 */
export async function eraseKnowledgeSyncSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return; // fail closed — never an unscoped sweep
  // The tombstone is not a subject. Without this, a DSAR whose key happened to be
  // the sentinel would re-pause every already-erased source in the tenant.
  if (subjectKey === ERASED_CREATOR) return;
  const now = new Date().toISOString();
  let disowned = 0;
  let paused = 0;
  for (const s of await sources.listByPrefix(`${tenantId}:`)) {
    // Belt-and-braces on the prefix scan: the key is `<tenantId>:<id>`, and the
    // row's own field is the authority (`getSyncSource` makes the same check).
    if (s.tenantId !== tenantId) continue;
    if (s.createdBy !== subjectKey) continue;
    // Does this source's credential belong to a PERSON? Unknown ⇒ yes ⇒ pause.
    let bindsAPerson = true;
    try {
      const conn = await getConnection(tenantId, s.connectionId);
      bindsAPerson = !conn || Boolean(conn.userId);
    } catch {
      bindsAPerson = true; // an unreadable connection is not a reason to keep syncing
    }
    const pause = bindsAPerson && s.status !== 'paused';
    // The TOMBSTONE is unconditional — that is the erasure, and it applies to a
    // tenant-level binding exactly as much as to a personal one.
    const next: SyncSource = { ...s, createdBy: ERASED_CREATOR, updatedAt: now };
    if (pause) {
      next.status = 'paused';
      next.pausedReason = 'creator-erased';
      next.lastError = ERASED_CREATOR_MESSAGE;
    }
    // `syncStartedAt` deliberately rides through untouched: this write knows
    // nothing about a pass that may be in flight, and clearing the lease would let
    // a second lane start over one diff cursor (the `setSyncStatus` contract).
    await sources.put(next);
    disowned += 1;
    if (pause) paused += 1;
  }
  if (disowned > 0) log.info('knowledge_sync_subject_erased', { tenantId, disowned, paused });
}

export async function deleteSyncSource(tenantId: string, id: string): Promise<boolean> {
  const s = await getSyncSource(tenantId, id);
  if (!s) return false;
  // WF-KB-3 — stop the scheduler job first so it can never fire against a
  // half-deleted source (the surface would skip it anyway, but no orphan runs).
  await deleteKnowledgeSyncJob(id);
  for (const fs of await listFileStates(id)) {
    await fileStates.delete(`${fs.sourceId}:${fs.externalFileId}`);
  }
  await sources.delete(`${tenantId}:${id}`);
  return true;
}

// ── the diff (ADR 0107 Phase 3 core — pure, the correctness heart of the run) ──

/** A remote file as `listFolder` reports it (Phase 1 shape). */
export interface RemoteFile {
  fileId: string;
  name: string;
  mimeType: string;
  revision: string;
}

export interface SyncDiff {
  /** NEW (no prior state) or CHANGED (revision differs) — fetch + (re)ingest. */
  toIngest: { fileId: string; name: string; mimeType: string; revision: string; documentId: string; reason: 'new' | 'changed' }[];
  /** DELETED — a prior state exists but the file is gone from the folder. */
  toPrune: { fileId: string; documentId: string }[];
  /** UNCHANGED — counted for the run summary, no action. */
  unchanged: number;
}

/** The KB doc id a synced file maps to — STABLE per (source, file) so a CHANGED
 *  file re-ingests deterministically (delete+re-ingest) and a fork is idempotent
 *  (ADR 0107 / ADR 0100 stable-documentId). */
export function syncDocumentId(sourceId: string, externalFileId: string): string {
  return `sync:${sourceId}:${externalFileId}`;
}

/**
 * Diff a folder listing against the per-file cursor — PURE, so it's exhaustively
 * testable independent of any network/KB. NEW = no state; CHANGED = revision
 * differs; DELETED = state exists but the file is gone; UNCHANGED = revision
 * matches. The drive is the source of truth (one-way, ADR 0107 OQ-5).
 */
export function diffFolder(sourceId: string, remote: readonly RemoteFile[], states: readonly SyncFileState[]): SyncDiff {
  const stateByFile = new Map(states.map((s) => [s.externalFileId, s]));
  const seen = new Set<string>();
  const toIngest: SyncDiff['toIngest'] = [];
  let unchanged = 0;
  for (const f of remote) {
    if (!f.fileId) continue;
    seen.add(f.fileId);
    const prev = stateByFile.get(f.fileId);
    const documentId = syncDocumentId(sourceId, f.fileId);
    if (!prev) {
      toIngest.push({ fileId: f.fileId, name: f.name, mimeType: f.mimeType, revision: f.revision, documentId, reason: 'new' });
    } else if (prev.revision !== f.revision) {
      toIngest.push({ fileId: f.fileId, name: f.name, mimeType: f.mimeType, revision: f.revision, documentId, reason: 'changed' });
    } else {
      unchanged += 1;
    }
  }
  const toPrune = states
    .filter((s) => !seen.has(s.externalFileId))
    .map((s) => ({ fileId: s.externalFileId, documentId: s.documentId }));
  return { toIngest, toPrune, unchanged };
}

/** The completeness-carrying listing shape `diffFolderListing` consumes. Kept
 *  structural (not an import of `host/knowledgeSourceFetch`) so this feature
 *  module stays free of the egress seam and the function is unit-testable. */
export interface DiffableListing {
  files: readonly RemoteFile[];
  /** Anything other than literal `true` is treated as "unknown" — see below. */
  complete: boolean;
  incompleteReason?: string;
}

/**
 * The ONE composition owner for "may this diff delete anything?" (ADR 0605
 * Tier 1 — `KSC-1`/`KSC-3`/`KSC-5`/`KSWF-3`).
 *
 * `diffFolder` above is PURE and its semantics are CORRECT: given the whole
 * folder, a prior state with no matching remote file IS a deletion, and pruning
 * a genuinely empty folder is right. The defect was never in the diff — it was
 * that the runner handed it a listing it could not vouch for. So the guard lives
 * HERE, at the composition point, and `diffFolder`'s contract is untouched.
 *
 * FAIL CLOSED, by construction: the test is `listing.complete === true`, not
 * `!listing.complete`. A caller that hands us a listing with `complete`
 * undefined, missing, or any non-boolean (an older mock, a JS caller, a future
 * provider whose lister forgot to say) gets NO PRUNE rather than a silent mass
 * deletion. Unknown completeness ⇒ never prune.
 *
 * `toIngest` and `unchanged` are unaffected: ingesting the files we DID see is
 * always safe and always progress — it is only the DELETION that requires
 * knowing what we did not see.
 */
export function diffFolderListing(sourceId: string, listing: DiffableListing, states: readonly SyncFileState[]): SyncDiff {
  const diff = diffFolder(sourceId, listing.files, states);
  if (listing.complete === true) return diff;
  return { ...diff, toPrune: [] };
}

// ── diff-state helpers (Phase 3 consumes these inside the run) ────────────────

export async function listFileStates(sourceId: string): Promise<SyncFileState[]> {
  return fileStates.listByPrefix(`${sourceId}:`);
}
export async function getFileState(sourceId: string, externalFileId: string): Promise<SyncFileState | null> {
  return fileStates.get(`${sourceId}:${externalFileId}`);
}
export async function upsertFileState(state: SyncFileState): Promise<void> {
  await fileStates.put(state);
}
export async function deleteFileState(sourceId: string, externalFileId: string): Promise<void> {
  await fileStates.delete(`${sourceId}:${externalFileId}`);
}

/**
 * ADR 0605 Tier 2 (`KSWF-6`) — tenant-TEARDOWN pre-hook for the diff cursors.
 *
 * `SyncFileState.tenantId` (above) makes every row written from now on visible to
 * the generic `purgeTenantRows` content walk. This hook is what reaches the rows
 * written BEFORE that field existed: it resolves the tenant's sources — which ARE
 * tenant-prefixed and therefore enumerable — and drops each source's cursors by
 * prefix, regardless of whether the row carries a tenant marker of its own.
 *
 * It must run BEFORE the generic walk destroys the `SyncSource` rows that are a
 * legacy cursor's only route to a tenant, which is exactly what
 * `registerTenantPurgeHook` guarantees (hooks run first, inside
 * `purgeTenantHostExt`, so EVERY teardown lane is covered at the one composition
 * owner rather than per call site).
 *
 * Idempotent and strictly tenant-scoped. Returns the number of cursor rows removed.
 *
 * RESIDUAL, stated rather than implied: a cursor whose parent `SyncSource` is
 * ALREADY gone is reachable by neither mechanism — it has no `tenantId` and no
 * parent. `deleteSyncSource` cascades, so that set should be empty outside a crash
 * mid-delete; this batch does not sweep for it, and no detector for it is possible
 * from the row alone.
 */
export async function purgeTenantSyncCursors(tenantId: string): Promise<number> {
  if (!tenantId) return 0; // fail closed — never a global purge
  let deleted = 0;
  for (const s of await sources.listByPrefix(`${tenantId}:`)) {
    for (const fs of await listFileStates(s.id)) {
      await fileStates.delete(`${fs.sourceId}:${fs.externalFileId}`);
      deleted += 1;
    }
  }
  return deleted;
}

/**
 * Win the single-runner claim for one PASS over `source`.
 *
 * ADR 0605 Tier 5 (`KSWF-5`) — the key is DATA-DERIVED, not wall-clock.
 *
 * It used to be `Math.floor(now / CLAIM_SLOT_MS)` with a 10-minute slot and a
 * jittered 5-minute poll. Two ticks 200 ms apart that straddle a slot edge compute
 * DIFFERENT keys and therefore BOTH win — measured by the assessment as
 * `claimSyncRun(edge−100ms) === claimSyncRun(edge+100ms) === true`. `isSyncDue`
 * does not save it, because `lastSyncedAt` is only stamped at the END of a pass.
 *
 * Keying on the source's own `updatedAt` removes the boundary entirely, the way
 * `scheduleDaemon` keys on a job's `nextFireAt`: two lanes that read the same row
 * compute the same key and exactly one wins, no matter how their clocks line up.
 * `updatedAt` is the right field because it advances on EVERY outcome — success,
 * failure, pause, resume — so a completed pass always frees the next one. Keying on
 * `lastSyncedAt` (the obvious choice) would NOT: a failed run leaves it untouched,
 * so the key would never change and the source would be permanently unclaimable —
 * a harder wedge than the one Tier 5 is removing.
 *
 * `tenantId` is derivable from `source`, but is passed explicitly because the caller
 * has already scoped by it and a key that silently disagreed with the caller's scope
 * would be a cross-tenant claim collision.
 */
export async function claimSyncRun(storage: Storage, tenantId: string, source: SyncSource, now: number): Promise<boolean> {
  const claim = await storage.claimOnce(
    `knowledge-sync:${tenantId}:${source.id}:${syncStateVersion(source)}`,
    new Date(now).toISOString(),
  );
  return claim.claimed;
}

/**
 * The source's OBSERVABLE STATE VERSION — the value `claimSyncRun` keys on.
 *
 * `updatedAt` alone was the first draft and it is NOT sufficient. Every outcome of
 * a pass writes the row, but `updatedAt` is set to the caller's `now`, so two
 * attempts that share a millisecond — or any caller with a fixed clock — produce
 * the SAME key, and the second attempt is refused as a duplicate of the first even
 * though the first has finished. Found by a test with a frozen `now`; the
 * production window is narrow, but "narrow" is how the wall-clock slot bug
 * (`KSWF-5`) presented too, and a claim that can silently skip a scheduled run is
 * exactly the failure this key exists to prevent.
 *
 * So fold in the two fields that record what the pass DID:
 *  - `lastSyncedAt` advances on a clean pass,
 *  - `consecutiveFailures` advances on a failed one.
 * Any completed pass therefore changes the version even under a stopped clock,
 * while two lanes racing the SAME unchanged row still compute the same value and
 * exactly one wins. Pure, so it is deterministic and testable on its own.
 *
 * ADR 0605 R1 (review HIGH 1) — `syncStartedAt` is folded in as well, and it is
 * the field that makes this key SURVIVABLE. Every clause above is about a pass
 * that COMPLETES; a pass that dies mid-flight advances none of them, so the key
 * never moved and the never-released claim wedged the source permanently. The
 * lease stamp is written BEFORE the run, so a crash still leaves a version no
 * later attempt will recompute.
 */
export function syncStateVersion(source: SyncSource): string {
  return [
    source.updatedAt,
    source.lastSyncedAt ?? 'never',
    source.consecutiveFailures ?? 0,
    source.syncStartedAt ?? 'idle',
  ].join('|');
}

// ── Cadence + claim hygiene (moved from the retired knowledgeSyncDaemon, WF-KB-3) ──
// The daemon's DISPATCH loop is gone (folded onto the ONE host scheduler via
// `registerKnowledgeSyncJob`); these are the pure/hygiene helpers it also held,
// kept here so the surface + the tests reach them without the daemon module.

const CADENCE_MS: Record<SyncCadence, number> = {
  '15m': 15 * 60 * 1000,
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

/**
 * Is this source due for a scheduled sync at `now` (ms)? Pure predicate. Retained
 * as the reusable due-check (and its test coverage); the scheduled run path does
 * NOT re-consult the cadence INTERVAL here (the per-source cron enforces cadence),
 * but the surface reuses the same status/lease/backoff reasoning inline.
 */
export function isSyncDue(source: SyncSource, now: number): boolean {
  if (source.status !== 'active') return false;
  const interval = CADENCE_MS[source.cadence];
  if (!interval) return false;
  if (syncLeaseHeld(source, now)) return false;
  if (source.nextAttemptAt) {
    const next = Date.parse(source.nextAttemptAt);
    if (Number.isFinite(next) && now < next) return false;
  }
  const last = source.lastSyncedAt ? Date.parse(source.lastSyncedAt) : 0;
  return !Number.isFinite(last) || now - last >= interval;
}

/** This feature's `claimOnce` keyspace — see `claimSyncRun`. */
const CLAIM_KEY_PREFIX = 'knowledge-sync:';
/** How old a claim row must be before it is pruned — STRICTLY GREATER THAN
 *  `SYNC_LEASE_MS` so a still-running pass's claim is never re-admitted. */
const CLAIM_PRUNE_AGE_MS = 2 * SYNC_LEASE_MS;

/**
 * Delete stale per-(source,state) claim rows so the mutex table stays bounded — the
 * BELT, not the load-bearing cure (that is the pre-run lease in `syncNow`, which
 * rotates the claim key from DATA and recovers a crashed pass within
 * `SYNC_LEASE_MS`). WF-KB-3: with the daemon's per-tick prune gone, the surface
 * runs this once per scheduled `runOnce`. Best-effort — a prune failure must never
 * fail its caller.
 */
export async function pruneStaleKnowledgeSyncClaims(deps: { storage: Storage }, now: number = Date.now()): Promise<number> {
  try {
    return await deps.storage.pruneOnceByPrefix(CLAIM_KEY_PREFIX, new Date(now - CLAIM_PRUNE_AGE_MS).toISOString());
  } catch (err) {
    log.warn('knowledge_sync_claim_prune_failed', { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}
