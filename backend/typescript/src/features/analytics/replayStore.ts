/**
 * ADR 0951 P0 — the session-replay store: an index row per recorded session in
 * `host_ext_kv`, and the recording's masked chunks in BLOB storage. Replay bytes
 * never go into Postgres (the ADR 0868/0871 growth lesson: one session is
 * 50–500 KB compressed).
 *
 * P0 ships the store's privacy machinery BEFORE anything can write to it (the
 * recorder and the chunk ingest are P2): the storage-configured gate, the DSAR
 * eraser (in the boot manifest), the consent-withdrawal hook, the retention
 * purger and the default 30-day window, and tenant teardown.
 *
 * Blob placement — a RESERVED host root, never the tenant's run-visible root.
 * `buildHostSurfaceBundle({tenantId}).storage.blob` is the same per-tenant root
 * the `core.storage.blob-*` nodes read and write, so chunks stored there would be
 * readable by any workflow the tenant runs — bypassing `host:analytics:replay`
 * and the per-view access log (D4). Chunks go under `REPLAY_BLOB_ROOT` (the
 * `__openwop_boot_check__` precedent) with the real tenant and org in the key:
 * `replay/<tenant>/<org>/<sessionId>/<n>`.
 */

import { DurableCollection, registerTenantPurgeHook } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerRetentionPurger, registerDefaultWindowSweep, type PurgeOutcome } from '../../host/retentionPurger.js';
import { getRetentionHold } from '../../host/retentionHold.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { resolveBackendId, hasAdapter, MEMORY_BACKEND } from '../../host/surfaceBackends.js';
import { buildHostSurfaceBundle, type BlobSurface } from '../../host/inMemorySurfaces.js';
import { registerConsentWithdrawalHook } from '../consent/consentService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('feature.analytics.replay');

/** The sub-toggles (ADR 0941 D5: dotted id, parent `analytics` AND-gated in code). */
export const HEATMAPS_TOGGLE = 'analytics.heatmaps';
export const SESSION_REPLAY_TOGGLE = 'analytics.session-replay';

/** The reserved blob root no tenant run can address. */
export const REPLAY_BLOB_ROOT = '__openwop_session_replay__';

/** D3 — default retention for a recording (operator/plan-tunable in P4, max 90). */
export const REPLAY_DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

export interface ReplayFlags { rage?: boolean; dead?: boolean; error?: boolean; converted?: boolean }

/** D3 — one recorded session's index row. Content lives in blob, never here. */
export interface ReplaySession {
  tenantId: string;
  orgId: string;
  sessionId: string;
  /** The consented subject (`visitor:<uuid>` from the consent token) — the key
   *  `analytics.replay` was granted under, and the key DSAR erasure arrives on. */
  subjectKey: string;
  /** The analytics session key of the same visit, when the beacon carried one —
   *  so an erasure arriving on either identity reaches the recording. */
  sessionKey?: string;
  pageIds: string[];
  startedAt: string;
  updatedAt: string;
  durationMs: number;
  bytes: number;
  chunkCount: number;
  flags: ReplayFlags;
}

const sessionId = (tenantId: string, orgId: string, id: string): string => `${tenantId}:${orgId}:${id}`;
const sessions = new DurableCollection<ReplaySession>(
  'analytics:replay',
  (r) => sessionId(r.tenantId, r.orgId, r.sessionId),
  undefined,
  (r) => r.tenantId,
);

// ADR 0077 — the index row names a person's visit; chunks are masked but are still
// a recording of one person (confidential-pii).
declarePiiFields('analytics.replay', ['subjectKey', 'sessionKey'], { maskGloballyByFieldName: false });
declarePiiFields('analytics.replay', ['pageIds'], { maskGloballyByFieldName: false });

// ───────────────────────── storage gate ─────────────────────────────────────

export type ReplayStorageStatus =
  | { configured: true; backend: string }
  | { configured: false; reason: 'memory_backend' | 'adapter_missing' };

/**
 * D1 — replay is "not configured" unless a DURABLE blob backend is selected.
 * The process-local `memory` blob loses every recording on restart and is
 * per-instance, so it never counts — except under the dev/test allowance
 * `OPENWOP_REPLAY_ALLOW_MEMORY_BLOB=true`, which production refuses. A selected
 * network backend has already passed the ADR 0867 boot round trip (a failing one
 * exits the revision before it serves), so "configured" here means "verified".
 */
export function replayStorageStatus(): ReplayStorageStatus {
  const backend = resolveBackendId('blob');
  if (backend === MEMORY_BACKEND) {
    const allowMemory = process.env.OPENWOP_REPLAY_ALLOW_MEMORY_BLOB === 'true' && process.env.NODE_ENV !== 'production';
    return allowMemory ? { configured: true, backend } : { configured: false, reason: 'memory_backend' };
  }
  return hasAdapter('blob', backend) ? { configured: true, backend } : { configured: false, reason: 'adapter_missing' };
}

/** Whether session replay may run for this tenant at all: the parent `analytics`
 *  toggle AND `analytics.session-replay` AND configured storage. Fail-closed on
 *  any read error. (`consent` ON is also required, and is enforced where it
 *  matters: with it OFF the public consent lane 404s, so `analytics.replay` can
 *  never be granted, and the strict category has no toggle-off escape.) */
export async function replayEnabled(tenantId: string): Promise<boolean> {
  if (!replayStorageStatus().configured) return false;
  const [parent, replay] = await Promise.all([
    resolveOne('analytics', { tenantId }).catch(() => null),
    resolveOne(SESSION_REPLAY_TOGGLE, { tenantId }).catch(() => null),
  ]);
  return Boolean(parent?.enabled && replay?.enabled);
}

// ───────────────────────── blob placement ───────────────────────────────────

function replayBlob(): BlobSurface {
  return buildHostSurfaceBundle({ tenantId: REPLAY_BLOB_ROOT }).storage.blob;
}

/** `replay/<tenant>/<org>/<sessionId>/` — every component encoded, so a `/` in an
 *  id can never reach a sibling prefix. */
export function replayChunkPrefix(tenantId: string, orgId: string, id: string): string {
  return `replay/${encodeURIComponent(tenantId)}/${encodeURIComponent(orgId)}/${encodeURIComponent(id)}/`;
}

// ───────────────────────── reads/writes (P2 builds on these) ─────────────────

export async function getReplaySession(tenantId: string, orgId: string, id: string): Promise<ReplaySession | null> {
  const row = await sessions.get(sessionId(tenantId, orgId, id));
  return row && row.tenantId === tenantId && row.orgId === orgId ? row : null;
}

export async function listReplaySessionsForTenant(tenantId: string): Promise<ReplaySession[]> {
  if (!tenantId) return [];
  return (await sessions.listForTenantIndexed(tenantId)).filter((r) => r.tenantId === tenantId);
}

/** Write the index row and one chunk. The chunk goes first, so a crash leaves an
 *  orphan blob (which the prefix delete below still finds), never a row that
 *  points at nothing. Test-reachable in P0; the public ingest arrives in P2. */
export async function putReplayChunk(row: ReplaySession, chunkIndex: number, contentBase64: string): Promise<void> {
  if (!replayStorageStatus().configured) {
    throw new OpenwopError('service_unavailable', 'Session replay storage is not configured.', 503, { feature: SESSION_REPLAY_TOGGLE });
  }
  const res = (await replayBlob().put({
    key: `${replayChunkPrefix(row.tenantId, row.orgId, row.sessionId)}${chunkIndex}`,
    contentBase64,
    contentType: 'application/octet-stream',
  })) as { ok?: boolean };
  if (res.ok === false) throw new OpenwopError('internal_error', 'Session replay chunk was not stored.', 500, {});
  await sessions.put(row);
}

/** Every chunk key stored for a session (all pages). */
async function listChunkKeys(prefix: string): Promise<string[]> {
  const blob = replayBlob();
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r = (await blob.list({ prefix, ...(cursor ? { cursor } : {}) })) as { entries?: Array<{ key?: unknown }>; nextCursor?: string };
    for (const e of r.entries ?? []) if (typeof e.key === 'string') keys.push(e.key);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return keys;
}

/**
 * D4 — delete one recording: its blobs FIRST (listed by prefix, so an orphan
 * chunk written before a crash is found too), then the index row. A chunk that
 * will not delete keeps the row, so the next erasure or sweep retries it; the
 * failure throws (an erasure that left content behind must not report success).
 */
export async function deleteReplaySession(row: ReplaySession): Promise<void> {
  const prefix = replayChunkPrefix(row.tenantId, row.orgId, row.sessionId);
  if (replayStorageStatus().configured) {
    const blob = replayBlob();
    let failed = 0;
    for (const key of await listChunkKeys(prefix)) {
      const r = (await blob.delete({ key }).catch(() => ({ ok: false }))) as { ok?: boolean };
      if (r.ok === false) failed += 1;
    }
    if (failed > 0) {
      throw new OpenwopError('internal_error', `session replay: ${failed} chunk(s) of a recording were not deleted.`, 500, {});
    }
  } else {
    // Storage was un-configured after recording (operator change). The chunks are
    // unreachable from here; keep the row so the recording is not silently
    // forgotten — the failure is the operator's signal to restore the backend.
    throw new OpenwopError('service_unavailable', 'session replay: blob storage is not configured, so recorded chunks cannot be deleted.', 503, {});
  }
  await sessions.delete(sessionId(row.tenantId, row.orgId, row.sessionId));
}

// ───────────────────────── erasure (D4) ─────────────────────────────────────

/**
 * DSAR — delete every recording of this subject in this tenant, whichever
 * identity the request arrives on (the consented `visitor:` subject or the
 * session's analytics key). NAMED, and listed in `EXPECTED_SUBJECT_ERASERS`, so
 * a build that forgets to import it fails the manifest test and every erasure
 * counts it as missing. Throws when any recording could not be fully deleted.
 */
export async function eraseSubjectReplays(tenantId: string, subjectKey: string): Promise<{ rowsTouched: number }> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  const rows = (await listReplaySessionsForTenant(tenantId)).filter((r) => r.subjectKey === subjectKey || r.sessionKey === subjectKey);
  let rowsTouched = 0;
  let failed = 0;
  for (const row of rows) {
    try { await deleteReplaySession(row); rowsTouched += 1; }
    catch (err) {
      failed += 1;
      log.error('replay_erase_failed', { tenantId, orgId: row.orgId, sessionId: row.sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (failed > 0) {
    throw new OpenwopError('internal_error', `session replay: ${failed} recording(s) targeted for erasure were not deleted.`, 500, {});
  }
  return { rowsTouched };
}
registerSubjectEraser(eraseSubjectReplays);

// D4 — withdrawing `analytics.replay` deletes the recordings already made, not
// only future capture. Same eraser, same subject key the grant was recorded under.
registerConsentWithdrawalHook('analytics.replay', 'eraseSubjectReplays', eraseSubjectReplays);

// D1 — the banner asks about recording only where replay can actually run.
// The recorder registers its visitor-choice provider when capture is installed.
// P0 supplies storage/privacy machinery only: do not offer recording yet.

// ───────────────────────── retention (D3/D4) ────────────────────────────────

async function purgeOlderThan(rows: readonly ReplaySession[], cutoffIso: string): Promise<PurgeOutcome> {
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    if (!(row.updatedAt < cutoffIso)) continue; // strict `<`, as purgeRowsByAge
    try { await deleteReplaySession(row); deleted += 1; }
    catch (err) {
      failed += 1;
      log.error('replay_retention_delete_failed', { tenantId: row.tenantId, orgId: row.orgId, sessionId: row.sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { deleted, failed };
}

function defaultCutoffIso(nowMs: number): string {
  return new Date(nowMs - REPLAY_DEFAULT_RETENTION_DAYS * DAY_MS).toISOString();
}

// ADR 0077 governance lane: a tenant's confidential-pii window, never LONGER than
// the replay default (the later — stricter — cutoff wins). No `dryRun`: it
// deletes blobs outside `purgeRowsByAge`, so a dry run reports it as not counted.
registerRetentionPurger({
  feature: 'analytics-replay',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    const own = defaultCutoffIso(Date.now());
    return purgeOlderThan(await listReplaySessionsForTenant(tenantId), cutoffIso > own ? cutoffIso : own);
  },
});

/** D3 — the default window, enforced on every posture (the governance lane above
 *  runs only for governed tenants behind an env opt-in). Legal holds skip their
 *  tenant's rows. A full scan of the index: rows are small and bounded by the
 *  per-org session caps (D3); the tenant index takes over if it ever is not. */
export async function sweepExpiredReplays(nowMs: number = Date.now()): Promise<PurgeOutcome> {
  const cutoff = defaultCutoffIso(nowMs);
  const expired = (await sessions.list()).filter((r) => r.updatedAt < cutoff);
  if (expired.length === 0) return { deleted: 0, failed: 0 };
  const held = new Map<string, boolean>();
  const eligible: ReplaySession[] = [];
  for (const row of expired) {
    if (!held.has(row.tenantId)) held.set(row.tenantId, Boolean(await getRetentionHold(row.tenantId)));
    if (!held.get(row.tenantId)) eligible.push(row);
  }
  return purgeOlderThan(eligible, cutoff);
}
registerDefaultWindowSweep({ feature: 'analytics-replay', sweep: sweepExpiredReplays });

// ADR 0284 — tenant teardown: the generic walk deletes the index rows, but the
// chunks live in blob, outside it. Runs FIRST (pre-hook), while the rows that
// name the chunks still exist. Failures propagate.
registerTenantPurgeHook('analytics-replay-blobs', async (tenantId) => {
  const rows = await listReplaySessionsForTenant(tenantId);
  for (const row of rows) await deleteReplaySession(row);
  return rows.length;
});

/** Test-only: clear the index (blobs are per-process in the memory backend). */
export async function __resetReplayStoreForTests(): Promise<void> { await sessions.__clear(); }
