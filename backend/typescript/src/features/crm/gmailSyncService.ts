/**
 * Gmail inbox → CRM activity sync — the opt-in store + scheduler wiring
 * (ADR 0252 P1/P2). A user with a connected `google` connection (carrying
 * `gmail.readonly`) explicitly opts in, binding `{orgId, connectionId,
 * cadence}` — off until they do (ADR 0252 §3).
 *
 * Scheduler-driven, NOT a bespoke daemon (ADR 0252 §4 — the architectural
 * correction): opting in registers a PER-USER scheduler job
 * (`host/schedulingService`, `ownerSubject = {kind:'user', id:userId}`) that
 * fires a single-node workflow chain (`crm-ops.gmail-sync`) on cadence. The
 * scheduler daemon fires it as a real run acting as the user — replay-safe (a
 * real run with events), same pattern `features/projects/projectScheduleService.ts`
 * uses for a project's schedules.
 *
 * The workflow's `gmailSyncId` reaches the node via the chain's OWN declared
 * parameter, FROZEN into the node config at expansion (RFC 0013 Path A): when
 * `ensureGmailSyncWorkflow` calls `expandChain(chain, { params: { gmailSyncId } })`,
 * `expandChain` substitutes the `{{params.gmailSyncId}}` config token with the
 * literal syncId and persists ZERO run-time tokens (no `variables[]`, no
 * `{{inputs.*}}`) — the definition is portable and the node simply reads
 * `ctx.config.gmailSyncId`. Under Path A the deterministic `workflowId` hash
 * folds the params in, so each sync already expands to a distinct id;
 * `ensureGmailSyncWorkflow` still overrides it to a STABLE, syncId-derived id
 * (`crm-ops.gmail-sync:<syncId>`) so the scheduler job and "sync now" can
 * address the per-sync workflow by recomputing the id from the syncId alone,
 * without re-hashing params (mirrors `routes/workflows.ts`'s
 * `POST .../workflows/from-chain` owned-instance override).
 *
 * @see docs/adr/0252-gmail-inbox-crm-activity-sync.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { findUserConnection, getConnection, reviveConnection, type Connection } from '../connections/connectionsService.js';
import { registerJob, updateJob, deleteJob } from '../../host/schedulingService.js';
import { personSubject } from '../../host/subject.js';
import { getChain, expandChain } from '../../host/workflowChainPackLoader.js';
import { registerWorkflowDurable, getRegisteredWorkflowAsync } from '../../host/workflowsRegistry.js';
import { recordRevision } from '../../host/workflowRevisions.js';
import { recordOwnership } from '../../host/workflowOwnership.js';
import { lifecycleOf, withLifecycle } from '../../host/workflowLifecycle.js';
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { createActivity, getActivity, type LinkValidators } from './crmEntitiesService.js';
import type { CrmEmitOptions } from './emit.js';

const log = createLogger('features.crm.gmailSync');

/** The published chain the scheduler fires (`examples/workflow-chain-packs/crm-ops`). */
const GMAIL_SYNC_CHAIN_ID = 'crm-ops.gmail-sync';

export const GMAIL_SYNC_CADENCES = ['15m', 'hourly', 'daily'] as const;
export type GmailSyncCadence = (typeof GMAIL_SYNC_CADENCES)[number];

/**
 * ADR 0627 D5 — `paused` is the user's (or a revoke's) stop; `needs-reconsent`
 * means the bound connection itself is dead (refresh failed / refused at the
 * broker). Both refuse a run (`syncGmailNow` + the node) with a typed error —
 * the scheduler has no failure count or backoff, so a failure that did not
 * self-pause would re-fail on every tick forever.
 *
 * HOW A DEAD PIN GETS OUT (review BLOCKER-2 — the first cut had no exit): a
 * revoke DELETES the connection row and a re-consent mints a NEW connectionId,
 * so the pinned id can name a row that no longer exists. Two exits, both
 * owner-verified, neither a fall-through to an org/workspace credential:
 *   - a re-consent on the SAME row (the ADR 0024 identity tuple keeps the id)
 *     fires `fireConnectionStatusChanged(→ active)` and the consumer RESUMES
 *     every `needs-reconsent` sync pinned to it — re-consent IS the resume;
 *   - a user resume (`PATCH status:'active'`) RE-VERIFIES the pin and, when it
 *     is dead, RE-BINDS to the owner's current active google user connection
 *     (`findUserConnection`) — or refuses 422 `credential_unavailable` when the
 *     owner has none, naming the action that fixes it.
 */
export type GmailSyncStatus = 'active' | 'paused' | 'needs-reconsent';
/** Why a sync is `paused` when the pause was NOT the user's own PATCH. */
export type GmailSyncPausedReason = 'capped' | 'connection-revoked';

/** The typed outcome of one metadata-only append (ADR 0627 D5(b)). The node
 *  advances its cursor only on `logged | duplicate`; `capped` pauses the sync;
 *  `failed` leaves the cursor where it was so the message is retried next pass. */
export type GmailActivityOutcome = 'logged' | 'duplicate' | 'capped' | 'failed';

/** An open truncation window (ADR 0627 D5, review SHOULD-1): the node listed
 *  more than its per-pass cap after the cursor. `before` = the oldest message
 *  date it reached (later passes query `after:cursor before:this`); `newest` =
 *  the newest settled date across the window's passes (the cursor advances past
 *  it once a pass is not truncated). */
export interface GmailSyncScanWindow { before: string; newest: string }
/** One unsettled message's hold budget (review SHOULD-3): how many passes it has
 *  held the cursor, and its date when known. Released past the node's budget. */
export interface GmailSyncUnsettled { passes: number; at?: string }
export const GMAIL_SYNC_UNSETTLED_MAX = 200;

export interface GmailSync {
  syncId: string;
  tenantId: string;
  orgId: string;
  userId: string;
  connectionId: string;
  cadence: GmailSyncCadence;
  jobId: string;
  status: GmailSyncStatus;
  /** Present only while `status === 'paused'` for a SYSTEM reason (cap hit,
   *  connection revoked); absent on a user pause. Cleared on resume. */
  pausedReason?: GmailSyncPausedReason;
  /** ISO-8601 timestamp — the messages-`after:` cursor. Absent on a fresh
   *  opt-in, so the first pass pulls a bounded recent window (the node
   *  defaults to the last 7 days) instead of a user's entire mailbox. */
  cursor?: string;
  /** Present only while a truncation window is open (see `GmailSyncScanWindow`). */
  scan?: GmailSyncScanWindow;
  /** Messages currently holding the cursor, by Gmail message id (bounded). */
  unsettled?: Record<string, GmailSyncUnsettled>;
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// Tenant-prefixed id ⇒ `listForTenant` is a bounded scan (mirrors knowledge-sync's SyncSource).
const syncs = new DurableCollection<GmailSync>('crm:gmailsync', (s) => `${s.tenantId}:${s.syncId}`);

function cronForCadence(cadence: GmailSyncCadence): string {
  switch (cadence) {
    case '15m': return '*/15 * * * *';
    case 'hourly': return '0 * * * *';
    case 'daily': return '0 7 * * *';
    default: {
      const exhaustive: never = cadence;
      throw new Error(`unreachable cadence: ${String(exhaustive)}`);
    }
  }
}

function assertCadence(value: unknown): GmailSyncCadence {
  if (typeof value !== 'string' || !(GMAIL_SYNC_CADENCES as readonly string[]).includes(value)) {
    throw new OpenwopError('validation_error', `cadence must be one of: ${GMAIL_SYNC_CADENCES.join(', ')}.`, 400, { field: 'cadence' });
  }
  return value as GmailSyncCadence;
}

/** Deterministic per-sync workflowId — stable across retries so re-deriving it
 *  (e.g. on a cold instance) is a byte-identical no-op re-registration. */
function gmailSyncWorkflowId(syncId: string): string {
  return `${GMAIL_SYNC_CHAIN_ID}:${syncId}`;
}

/**
 * Idempotently register the per-sync workflow instance the scheduler job (or
 * "sync now") fires — expands `crm-ops.gmail-sync` with `gmailSyncId`, which
 * RFC 0013 Path A freezes into the node config (see file header), then overrides
 * the expanded definition's `workflowId` to a stable, syncId-derived id so the
 * scheduler/sync-now can address it by recomputing the id from the syncId (rather
 * than re-hashing the frozen params).
 *
 * WF-CRM-1 — this now records OWNERSHIP, and that is not bookkeeping. The
 * ownership index is what `/builder` and the `/` picker list, and
 * `purgeTenantOwnedWorkflowDefs` walks it — it is the ONLY thing that reaches
 * `wfreg:` rows at account deletion. Without an ownership row this workflow was a
 * runnable, side-effectful, tenant-scoped definition that was invisible and
 * uneditable, SURVIVED tenant teardown, and leaked a durable def on every opt-out.
 * `features/strategy/cadence.ts` is the identical `expandChain → registerWorkflow`
 * shape and does all three; this is now the same.
 *
 * WF-CRM-2 — and the existence check is ASYNC. It short-circuited on the
 * synchronous, process-local `getRegisteredWorkflow`, whose Map has no boot
 * hydration, so on a fresh Cloud Run instance the check always missed and the
 * re-registration OVERWROTE the shared durable `wfreg:` row. That is byte-for-byte
 * the RI-1 defect `host/seedWorkflows.ts` already fixed by switching to
 * `getRegisteredWorkflowAsync`. It was inert only while the chain's content AND
 * version stayed frozen: a `crm-ops` chain edit re-points `expansionId`, every node
 * id moves, and a prior run replays against a definition whose node ids no longer
 * match (`replay_source_missing`). `recordRevision` pins the as-run definition for
 * the same reason — without it every gmail-sync run replays `resolvedFrom: 'head'`.
 *
 * WF-CRM-3 (fold-in M3) — the existence check SHORT-CIRCUITS, so a sync that opted
 * in before WF-CRM-1 shipped returned here and never reached
 * `recordRevision`/`recordOwnership`: every pre-deploy sync stayed unowned
 * (invisible to `/builder`, unreachable by `purgeTenantOwnedWorkflowDefs`, surviving
 * tenant teardown) and unpinned FOREVER, because nothing else ever calls this for an
 * already-registered sync. The short-circuit now BACKFILLS both from the definition
 * it just read. Both writes are idempotent — `recordRevision` is content-hash keyed
 * (same content ⇒ upsert, no history noise) and `recordOwnership` is a CAS upsert
 * that preserves `createdAt` — so the hot path (scheduler fire, "sync now") pays two
 * point writes and changes nothing observable.
 */
async function ensureGmailSyncWorkflow(tenantId: string, syncId: string): Promise<string> {
  const workflowId = gmailSyncWorkflowId(syncId);
  const existing = await getRegisteredWorkflowAsync(workflowId);
  if (existing) {
    await recordRevision(tenantId, existing);
    const archivedAt = lifecycleOf(existing).archivedAt;
    await recordOwnership(tenantId, workflowId, {
      nodeCount: existing.nodes.length,
      ...(typeof existing.metadata?.name === 'string' ? { name: existing.metadata.name } : {}),
      // Preserve an archive stamp. An opted-out sync's definition is ARCHIVED,
      // never deleted (see `deleteGmailSync`), and a backfill that dropped the
      // flag would silently resurrect it into `/builder` and the `/` picker.
      ...(archivedAt !== undefined ? { archivedAt } : {}),
    });
    return workflowId;
  }
  const found = getChain(GMAIL_SYNC_CHAIN_ID);
  if (!found) {
    throw new OpenwopError(
      'internal_error',
      `Workflow chain '${GMAIL_SYNC_CHAIN_ID}' is not loaded on this host — the crm-ops workflow-chain pack must be installed.`,
      500,
      { chainId: GMAIL_SYNC_CHAIN_ID },
    );
  }
  const expanded = expandChain(found.chain, { params: { gmailSyncId: syncId } });
  const def = { ...expanded, workflowId };
  await registerWorkflowDurable(def);
  // ADR 0474 — instantiation is the first revision, so a run resolves as-run
  // rather than against whatever `head` happens to be at replay time.
  await recordRevision(tenantId, def);
  await recordOwnership(tenantId, workflowId, { name: found.chain.label, nodeCount: expanded.nodes.length });
  return workflowId;
}

/** The caller's gmail-sync opt-ins, optionally narrowed to an org and/or a
 *  user (the profile-scoped "my Gmail sync" read). */
export async function listGmailSyncs(tenantId: string, filter: { orgId?: string; userId?: string } = {}): Promise<GmailSync[]> {
  const all = await syncs.listForTenant(tenantId);
  return all
    .filter((s) => (filter.orgId === undefined || s.orgId === filter.orgId) && (filter.userId === undefined || s.userId === filter.userId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** One sync, scoped to tenant (fail-closed cross-tenant: returns null). */
export async function getGmailSync(tenantId: string, syncId: string): Promise<GmailSync | null> {
  const s = await syncs.get(`${tenantId}:${syncId}`);
  return s && s.tenantId === tenantId ? s : null;
}

export interface CreateGmailSyncInput {
  tenantId: string;
  orgId: string;
  /** The AUTHENTICATED caller's id — never client-supplied (ADR 0252 §6 IDOR guard). */
  userId: string;
  connectionId: string;
  cadence: unknown;
}

/**
 * Opt in: validate the connection exists, belongs to THIS caller, and is a
 * `google` connection (the provider carrying `gmail.readonly`; the narrower
 * `gmail` provider is draft/send-only and unusable for reads — ADR 0252 §3),
 * then register a per-user scheduler job that fires the gmail-sync workflow
 * on cadence. Fail-closed 403 on a foreign connection (IDOR); 400 on a
 * non-google provider or a bad cadence.
 */
export async function createGmailSync(input: CreateGmailSyncInput): Promise<GmailSync> {
  const cadence = assertCadence(input.cadence);
  const conn = await getConnection(input.tenantId, input.connectionId);
  if (!conn) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: input.connectionId });
  if (conn.userId !== input.userId) {
    throw new OpenwopError('forbidden', 'The connection must belong to the caller.', 403, { connectionId: input.connectionId });
  }
  if (conn.provider !== 'google') {
    throw new OpenwopError(
      'validation_error',
      "Gmail sync requires a `google` provider connection (carrying the gmail.readonly scope).",
      400,
      { field: 'connectionId', provider: conn.provider },
    );
  }
  const syncId = `gmailsync:${randomUUID()}`;
  const workflowId = await ensureGmailSyncWorkflow(input.tenantId, syncId);
  const jobId = `gmailsync:${syncId}`;
  const res = await registerJob({
    jobId,
    tenantId: input.tenantId,
    cronExpr: cronForCadence(cadence),
    ownerSubject: personSubject(input.userId),
    workflowId,
    enabled: true,
    // Rides straight onto `run.metadata` for every fire (scheduleDaemon.ts
    // spreads job.metadata onto the run) — `actingUserId` is what the
    // Connections broker keys the user's Gmail credential off; `gmailSyncId`
    // is carried too for observability even though the node itself reads it
    // off its frozen-in config (RFC 0013 Path A — see file header).
    metadata: { actingUserId: input.userId, gmailSyncId: syncId },
  });
  if (!res.ok) throw new OpenwopError('validation_error', res.error.message, 400, { code: res.error.code });
  const now = new Date().toISOString();
  const row: GmailSync = {
    syncId,
    tenantId: input.tenantId,
    orgId: input.orgId,
    userId: input.userId,
    connectionId: input.connectionId,
    cadence,
    jobId,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await syncs.put(row);
  log.info('gmail_sync_created', { tenantId: input.tenantId, orgId: input.orgId, syncId, jobId, cadence });
  return row;
}

/** The pinned connection is usable iff it exists, is the sync owner's own
 *  google USER row and is `active`. Otherwise the owner's current active google
 *  user row (a re-consent after a revoke mints a new id) — never an org or
 *  workspace credential — or a typed 422 naming the fix. */
async function resolveResumablePin(sync: GmailSync): Promise<Connection> {
  const pinned = await getConnection(sync.tenantId, sync.connectionId);
  if (pinned && pinned.userId === sync.userId && pinned.provider === 'google') {
    if (pinned.status === 'active') return pinned;
    // Review SHOULD-2 — the row is OWNED and present but parked non-active: a
    // transient refresh failure looks exactly like a real one. Retry the
    // credential once (a success patches `active` + fires `→ active`) before
    // telling the user to re-consent.
    const revived = await reviveConnection(sync.tenantId, pinned.connectionId);
    if (revived && revived.status === 'active') {
      log.info('gmail_sync_pin_revived', { tenantId: sync.tenantId, syncId: sync.syncId, connectionId: pinned.connectionId });
      return revived;
    }
    throw new OpenwopError(
      'credential_unavailable',
      'This Gmail sync cannot resume: its Google connection needs re-consent (the token could not be refreshed). Re-consent Google — the sync resumes on its own — then try again.',
      422,
      { syncId: sync.syncId, connectionId: sync.connectionId, reason: 'needs-reconsent' },
    );
  }
  const rebound = await findUserConnection(sync.tenantId, 'google', sync.userId);
  if (rebound) {
    log.info('gmail_sync_rebound', { tenantId: sync.tenantId, syncId: sync.syncId, from: sync.connectionId, to: rebound.connectionId });
    return rebound;
  }
  throw new OpenwopError(
    'credential_unavailable',
    'This Gmail sync cannot resume: its Google connection is gone and you have no active Google connection. Connect Google, then resume.',
    422,
    { syncId: sync.syncId, connectionId: sync.connectionId, reason: 'gone' },
  );
}

/** Pause/resume (job `enabled`) and/or re-cadence (job `cronExpr`) an existing
 *  sync. Returns null when the sync doesn't exist for this tenant. */
export async function updateGmailSync(
  tenantId: string,
  syncId: string,
  patch: { status?: unknown; cadence?: unknown },
): Promise<GmailSync | null> {
  const existing = await getGmailSync(tenantId, syncId);
  if (!existing) return null;
  const next: GmailSync = { ...existing, updatedAt: new Date().toISOString() };
  if (patch.status !== undefined) {
    if (patch.status !== 'active' && patch.status !== 'paused') {
      throw new OpenwopError('validation_error', '`status` must be `active` or `paused`.', 400, { field: 'status' });
    }
    if (patch.status === 'active') {
      // ADR 0627 D5 (review BLOCKER-2) — a resume re-verifies the pin and
      // re-binds a dead one to the owner's CURRENT google user row, so a
      // revoke → reconnect (new id) → resume actually runs on the new pin.
      next.connectionId = (await resolveResumablePin(existing)).connectionId;
    }
    next.status = patch.status;
    // A user-driven status write owns the row's reason: a resume clears it, a
    // user pause carries none (the reason field is for SYSTEM pauses only).
    delete next.pausedReason;
    await updateJob(existing.jobId, { enabled: patch.status === 'active' });
  }
  if (patch.cadence !== undefined) {
    next.cadence = assertCadence(patch.cadence);
    await updateJob(existing.jobId, { cronExpr: cronForCadence(next.cadence) });
  }
  await syncs.put(next);
  return next;
}

/**
 * ADR 0285 — pause (never delete) every gmail sync riding a REVOKED connection:
 * the opt-in survives visibly paused, its scheduler job disabled (the
 * `updateGmailSync` status path already handles the job), and re-connecting is
 * a resume. Idempotent.
 */
export async function pauseGmailSyncsForRevokedConnection(tenantId: string, connectionId: string): Promise<number> {
  let paused = 0;
  // `needs-reconsent` rows flip too (review BLOCKER-2): a revoke of a dead
  // connection must read as "revoked — resume re-binds", not "re-consent THIS
  // (deleted) connection" forever.
  for (const s of (await syncs.listByPrefix(`${tenantId}:`)).filter((x) => x.connectionId === connectionId && (x.status === 'active' || x.status === 'needs-reconsent'))) {
    await markGmailSyncStatus(tenantId, s.syncId, 'paused', 'connection-revoked');
    paused += 1;
  }
  return paused;
}

/**
 * ADR 0627 D5 — a SYSTEM stop (the run itself, or the connection seam): write
 * the row's status (+ reason) and disable the scheduler job in the same step, so
 * a sync that paused itself is never fired again until a user resumes it.
 * Returns null when the sync doesn't exist for this tenant. Idempotent.
 */
export async function markGmailSyncStatus(
  tenantId: string,
  syncId: string,
  status: 'paused' | 'needs-reconsent',
  pausedReason?: GmailSyncPausedReason,
): Promise<GmailSync | null> {
  const existing = await getGmailSync(tenantId, syncId);
  if (!existing) return null;
  const next: GmailSync = { ...existing, status, updatedAt: new Date().toISOString() };
  if (status === 'paused' && pausedReason) next.pausedReason = pausedReason;
  else delete next.pausedReason;
  await updateJob(existing.jobId, { enabled: false });
  await syncs.put(next);
  log.info('gmail_sync_status_marked', { tenantId, syncId, status, ...(pausedReason ? { pausedReason } : {}) });
  return next;
}

/**
 * ADR 0627 D5 — the `onConnectionStatusChanged` consumer: every ACTIVE sync
 * bound to a connection that just flipped to `needs-reconsent` is marked the
 * same, so the scheduler stops firing a dead credential and the Gmail tab shows
 * the user what to reconnect. Idempotent (a re-fire finds no active rows).
 */
export async function markGmailSyncsNeedsReconsent(tenantId: string, connectionId: string): Promise<number> {
  let marked = 0;
  for (const s of (await syncs.listByPrefix(`${tenantId}:`)).filter((x) => x.connectionId === connectionId && x.status === 'active')) {
    await markGmailSyncStatus(tenantId, s.syncId, 'needs-reconsent');
    marked += 1;
  }
  return marked;
}

/**
 * ADR 0627 D5 (review SHOULD-3) — the `onConnectionStatusChanged(→ active)`
 * consumer: a re-consent on the SAME connection row revives every
 * `needs-reconsent` sync pinned to it (row + job). Only that state — a user
 * pause stays a user pause. Idempotent.
 */
export async function resumeGmailSyncsForReconsentedConnection(tenantId: string, connectionId: string): Promise<number> {
  let resumed = 0;
  for (const s of (await syncs.listByPrefix(`${tenantId}:`)).filter((x) => x.connectionId === connectionId && x.status === 'needs-reconsent')) {
    try {
      await updateGmailSync(tenantId, s.syncId, { status: 'active' });
      resumed += 1;
    } catch (e) {
      // One sync's refusal (its own re-verify failed) must not abort its siblings.
      log.warn('gmail_sync_resume_failed', { tenantId, syncId: s.syncId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return resumed;
}

/**
 * ADR 0627 D5 — the typed refusal every run-starting lane applies (`syncGmailNow`
 * here; the node re-checks the row it reads, because the scheduler fires the
 * workflow directly). A `paused` sync is a 409 `validation_error` carrying the
 * reason; a `needs-reconsent` sync is a 422 `credential_unavailable` — the fix
 * is a different action (resume vs re-consent), so the codes differ.
 */
function assertGmailSyncRunnable(sync: GmailSync): void {
  if (sync.status === 'paused') {
    throw new OpenwopError(
      'validation_error',
      sync.pausedReason === 'capped'
        ? 'This Gmail sync paused itself: the org reached its activity cap. Free space, then resume it.'
        : sync.pausedReason === 'connection-revoked'
          ? 'This Gmail sync is paused: its Google connection was revoked. Connect Google again, then resume — resuming re-binds the sync to your current Google connection.'
          : 'This Gmail sync is paused. Resume it to run.',
      409,
      { syncId: sync.syncId, status: sync.status, ...(sync.pausedReason ? { pausedReason: sync.pausedReason } : {}) },
    );
  }
  if (sync.status === 'needs-reconsent') {
    throw new OpenwopError(
      'credential_unavailable',
      'This Gmail sync needs re-consent: its Google connection can no longer be refreshed. Re-consent Google (the sync resumes on its own) or connect Google again and resume — resuming re-binds to your current Google connection.',
      422,
      { syncId: sync.syncId, status: sync.status, connectionId: sync.connectionId },
    );
  }
}

/**
 * Opt out: delete the scheduler job, ARCHIVE the per-sync workflow definition it
 * fired, then delete the row (a mid-way crash leaves an orphaned but harmless
 * disabled-lookup job, never a row with no job).
 * Returns false when the sync didn't exist for this tenant.
 *
 * WF-CRM-1 — the workflow teardown is new. Every opt-out used to leak a durable
 * `wfreg:crm-ops.gmail-sync:<syncId>` row: the sync row and its job went, the
 * definition stayed forever, and because nothing recorded ownership even account
 * deletion could not reach it (`purgeTenantOwnedWorkflowDefs` walks ownership rows).
 *
 * ARCHIVE, NEVER DELETE — corrected in the fold-in (B1). The first cut called
 * `deleteRegisteredWorkflow` + `removeOwnership` unguarded, and that is precisely
 * what the sanctioned lane REFUSES: `routes/workflows.ts`'s DELETE returns a 409
 * `workflow_referenced` when `hasRunForWorkflow` is true, because runs re-resolve
 * their definition BY ID at replay/`:fork` (there is no per-run snapshot) — so
 * hard-deleting a referenced definition orphans every run this sync ever produced.
 * `host/runRetentionSweeper.ts` honours the same rule. Worse, the delete cascades
 * through `onWorkflowDeleted` into `deleteWorkflowRevisions`, destroying the exact
 * `recordRevision` pin WF-CRM-2 added one function above.
 *
 * And the leak it was meant to close does not need a delete: the ownership record
 * ALONE is what `purgeTenantOwnedWorkflowDefs` walks, and this lane now writes one.
 * So teardown reclaims the definition on account deletion, while an opt-out leaves
 * an archived, catalog-hidden, still-resolvable definition — the ADR 0369 posture
 * ("Archive, never dispose"). The ownership row is KEPT and re-stamped `archivedAt`
 * for the same reason: removing it would put the definition right back out of
 * teardown's reach, which is the leak.
 */
export async function deleteGmailSync(tenantId: string, syncId: string): Promise<boolean> {
  const existing = await getGmailSync(tenantId, syncId);
  if (!existing) return false;
  await deleteJob(existing.jobId);
  const workflowId = gmailSyncWorkflowId(syncId);
  const def = await getRegisteredWorkflowAsync(workflowId);
  if (def && !lifecycleOf(def).archivedAt) {
    const archivedAt = new Date().toISOString();
    const archived = withLifecycle(def, { archivedAt });
    await registerWorkflowDurable(archived);
    await recordOwnership(tenantId, workflowId, {
      nodeCount: archived.nodes.length,
      ...(typeof archived.metadata?.name === 'string' ? { name: archived.metadata.name } : {}),
      archivedAt,
    });
  }
  await syncs.delete(`${tenantId}:${syncId}`);
  return true;
}

/** Advance the sync's time cursor after a pass (called by the gmail-sync node
 *  via `ctx.features.crm.advanceGmailSyncCursor`). Returns null when the sync
 *  doesn't exist for this tenant (the node treats this as "sync was deleted
 *  mid-run" and skips, never throws). */
export async function advanceGmailSyncCursor(tenantId: string, syncId: string, cursor: string): Promise<GmailSync | null> {
  const existing = await getGmailSync(tenantId, syncId);
  if (!existing) return null;
  const now = new Date().toISOString();
  const next: GmailSync = { ...existing, cursor, lastSyncedAt: now, updatedAt: now };
  await syncs.put(next);
  return next;
}

/**
 * ADR 0627 D5 (review SHOULD-1/-3) — persist the node's scan state after a pass:
 * the truncation window (`null` closes it) and the per-message hold budget.
 * `released` names messages the node STOPPED holding for (budget exhausted, map
 * full, or no longer listed) — each is logged at warn with its id, so a lost
 * message is visible in the operator log, never silent. Returns null when the
 * sync doesn't exist for this tenant.
 */
export async function recordGmailSyncScan(
  tenantId: string,
  syncId: string,
  patch: { scan?: GmailSyncScanWindow | null; unsettled?: Record<string, GmailSyncUnsettled>; released?: string[] },
): Promise<GmailSync | null> {
  const existing = await getGmailSync(tenantId, syncId);
  if (!existing) return null;
  const next: GmailSync = { ...existing, updatedAt: new Date().toISOString() };
  if (patch.scan !== undefined) {
    if (patch.scan === null) delete next.scan;
    else next.scan = { before: patch.scan.before, newest: patch.scan.newest };
  }
  if (patch.unsettled !== undefined) {
    if (Object.keys(patch.unsettled).length === 0) delete next.unsettled;
    else next.unsettled = patch.unsettled;
  }
  for (const messageId of patch.released ?? []) {
    log.warn('gmail_sync_message_released', { tenantId, syncId, messageId, reason: 'unsettled past the hold budget (or no longer listed) — the cursor will advance past it' });
  }
  await syncs.put(next);
  return next;
}

/**
 * "Sync now" — start a real run of the sync's per-user workflow immediately
 * (mirrors `knowledgeSyncRunner.syncNow`'s on-demand posture, but as a REAL
 * run rather than an inline pass, per ADR 0252 §4/§5). Returns the new runId,
 * or null when the workflow somehow doesn't resolve (see `startWorkflowRun`).
 */
export async function syncGmailNow(deps: StartRunDeps, tenantId: string, syncId: string): Promise<string | null> {
  const sync = await getGmailSync(tenantId, syncId);
  if (!sync) throw new OpenwopError('not_found', 'Gmail sync not found.', 404, { syncId });
  assertGmailSyncRunnable(sync); // ADR 0627 D5 — paused / needs-reconsent is a typed refusal, never a run.
  const workflowId = await ensureGmailSyncWorkflow(sync.tenantId, sync.syncId);
  return startWorkflowRun(deps, {
    tenantId,
    workflowId,
    metadata: { actingUserId: sync.userId, gmailSyncId: sync.syncId },
  });
}

/**
 * Append a metadata-only Gmail email activity to a matched contact's timeline
 * (ADR 0252 §1/§5) — the SAME idempotent, best-effort pattern as
 * `features/email/emailService.ts`'s `appendEmailActivity` (the ADR 0211
 * inbound counterpart this one un-parks): a point-read existence check before
 * the append (so a re-sync of the same message+contact skips both the append
 * AND the `crmMutated` re-emit), a deterministic `activityId` (`act:gmail:
 * <orgId>:<messageId>:<contactId>` — orgId included so the same message+
 * contact can land in two orgs' timelines without a cross-org id collision),
 * and NEVER subject/body/snippet/email — only that an exchange happened, its
 * direction, and a Gmail deep-link id. Never throws — one bad message must never
 * abort the sync pass — but the outcome is TYPED (ADR 0627 D5(b)): the node
 * advances its cursor only past `logged | duplicate`, pauses the sync on
 * `capped` (the 5,000-per-org activity cap used to be a warn-and-continue that
 * silently dropped every later message while the cursor kept advancing), and
 * leaves the cursor in place on `failed` so the message is retried next pass.
 */
export async function appendGmailActivity(
  tenantId: string,
  orgId: string,
  args: { contactId: string; messageId: string; threadId: string; direction: 'in' | 'out'; at: string },
  actor: string,
  validators: LinkValidators,
  /** ADR 0617 D1a — the RUN's origin (stamped by the workflow surface): a chain
   *  bound to `host.crm.activity.logged` whose run performs a gmail sync must
   *  not re-trigger itself through the activities it appends. */
  emit: Pick<CrmEmitOptions, 'origin'> = {},
): Promise<GmailActivityOutcome> {
  try {
    const activityId = `act:gmail:${orgId}:${args.messageId}:${args.contactId}`;
    if (await getActivity(tenantId, orgId, activityId)) return 'duplicate'; // already logged — idempotent re-sync.
    const body = args.direction === 'in'
      ? `Email received from contact · Gmail ${args.messageId}`
      : `Email sent to contact · Gmail ${args.messageId}`;
    await createActivity({
      tenantId,
      orgId,
      kind: 'email',
      body,
      contactId: args.contactId,
      threadId: args.threadId,      // opaque ref for grouping/deep-link (ADR 0252 §1).
      createdAt: args.at,           // back-date to the email's own time, not sync time.
      createdBy: actor,
      ...(emit.origin ? { origin: emit.origin } : {}),
      activityId,
      // NOT skipCapCheck: this verb is surfaced on ctx.features.crm, so an
      // in-tenant node could otherwise write unbounded activities into any org
      // (cap evasion). The deterministic-id point-read above already short-
      // circuits re-syncs, so the cap scan is paid only on a genuinely new row.
      // `validators` re-verifies the contact exists (never a phantom link).
      validators,
    });
    // ADR 0627 D2 — `activity.logged` is emitted by `createActivity` on its
    // CREATED branch (the ONE site); the point-read above keeps a re-sync from
    // even reaching it, so this lane emits nothing of its own.
    return 'logged';
  } catch (e) {
    const outcome = gmailAppendOutcomeOf(e);
    log.warn('gmail→activity bridge append failed', {
      messageId: args.messageId,
      contactId: args.contactId,
      outcome,
      error: e instanceof Error ? e.message : String(e),
    });
    return outcome;
  }
}

/** Classify an `appendGmailActivity` failure. The per-org entity cap is the ONE
 *  409 `createActivity` raises (`entities/shared.ts` `assertUnderCap`); every
 *  other error (a phantom contact, a storage fault) is a per-message `failed`. */
export function gmailAppendOutcomeOf(err: unknown): Exclude<GmailActivityOutcome, 'logged' | 'duplicate'> {
  return err instanceof OpenwopError && err.httpStatus === 409 && err.code === 'validation_error' ? 'capped' : 'failed';
}

