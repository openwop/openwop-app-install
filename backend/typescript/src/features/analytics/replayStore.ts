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

import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection, registerTenantPurgeHook } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerRetentionPurger, registerDefaultWindowSweep, type PurgeOutcome } from '../../host/retentionPurger.js';
import { getRetentionHold } from '../../host/retentionHold.js';
import {
  registerToggleWriteIntent, registerToggleWriteListener, resolveOne, resolveWrittenToggle, type ToggleWrite, type ToggleWriteIntent,
} from '../../host/featureToggles/service.js';
import type { ToggleConfig } from '../../host/featureToggles/types.js';
import { resolveBackendId, hasAdapter, MEMORY_BACKEND } from '../../host/surfaceBackends.js';
import { buildHostSurfaceBundle, type BlobSurface } from '../../host/inMemorySurfaces.js';
import { getStrictGrantGeneration, registerConsentWithdrawalHook, registerVisitorChoiceProvider } from '../consent/consentService.js';
import { createLogger } from '../../observability/logger.js';
import { assertOrgScope } from '../../host/accessControlService.js';
import { appendAudit as appendChainAudit } from '../../host/auditChainService.js';
import { recordGovernanceDecision } from '../../host/governanceDecisionLog.js';

const log = createLogger('feature.analytics.replay');

/** The sub-toggles (ADR 0941 D5: dotted id, parent `analytics` AND-gated in code). */
export const HEATMAPS_TOGGLE = 'analytics.heatmaps';
export const SESSION_REPLAY_TOGGLE = 'analytics.session-replay';

/** The reserved blob root no tenant run can address. */
export const REPLAY_BLOB_ROOT = '__openwop_session_replay__';

/** D3 — default retention for a recording (operator/plan-tunable in P4, max 90). */
export const REPLAY_DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
/** P2.3: byte counts are decoded base64 storage bytes, not the encoded string.
 * The event decoder separately bounds decompressed JSON before this store. */
export const REPLAY_MAX_CHUNK_BYTES = 256 * 1024;
export const REPLAY_MAX_SESSION_BYTES = 5 * 1024 * 1024;
export const REPLAY_MAX_SESSION_CHUNKS = 2048;
/** P2.3 admission (David 2026-10-28): a sample of consented visits, a per-org
 *  daily ceiling and a fixed session length. Ceilings, not promises. */
export const REPLAY_SAMPLE_PERCENT = 10;
/** The operator may set the sample (`OPENWOP_REPLAY_SAMPLE_PERCENT`, an integer
 *  0–100). Anything else falls back to the approved default. Sampling changes
 *  how many consented visits are kept, never who may be recorded. */
export function replaySamplePercent(): number {
  const raw = process.env.OPENWOP_REPLAY_SAMPLE_PERCENT;
  const n = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : REPLAY_SAMPLE_PERCENT;
}
export const REPLAY_MAX_SESSIONS_PER_ORG_DAY = 2_000;
export const REPLAY_MAX_SESSION_MS = 30 * 60_000;
/** P2.5: a replay chunk upload is aborted after this long. */
export const REPLAY_PUT_DEADLINE_MS = 60_000;
/** P2.5: an unsettled receipt older than this cannot still land: the upload was
 * aborted at the deadline, and the rest covers provider commit lag and clock skew. */
export const REPLAY_SETTLE_AFTER_MS = 10 * 60_000;
/** Backends whose `put` honours the abort signal (or completes synchronously),
 * so the deadline above is a real bound. Any other backend keeps its receipts. */
const SETTLEABLE_BACKENDS = new Set(['gcs', 's3', MEMORY_BACKEND]);

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
  /** Host UTC time of the first durable reservation; input timestamps are ignored. */
  startedAt: string;
  /** Host finalization time, never earlier than the persisted value. */
  updatedAt: string;
  durationMs: number;
  bytes: number;
  chunkCount: number;
  flags: ReplayFlags;
}

const sessionId = (tenantId: string, orgId: string, id: string): string => `${tenantId}:${orgId}:${id}`;
type ChunkReceipt = { digest: string; bytes: number };
/** `reservedAt` is host time at reservation. A receipt from before P2.5 has
 * none; the first settlement pass stamps `observedAt` instead and waits from there. */
type PendingWrite = ChunkReceipt & { id: string; chunkIndex: number; reservedAt?: string; observedAt?: string };
type Recording = ReplaySession & {
  privacy?: { state: 'active' | 'erasing'; committed: boolean; pending: PendingWrite[]; chunks?: Record<string, ChunkReceipt>; consentGeneration?: string; enablementEpoch?: string; eligibilityId?: string };
};
type ErasedRecording = Pick<ReplaySession, 'tenantId' | 'orgId' | 'sessionId'> & { privacy: { state: 'erased'; erasedAt?: string } };
type StoredRecording = Recording | ErasedRecording;
const sessions = new DurableCollection<StoredRecording>(
  'analytics:replay',
  (r) => sessionId(r.tenantId, r.orgId, r.sessionId),
  undefined,
  (r) => r.tenantId,
);

function hasRecording(row: StoredRecording): row is Recording { return 'subjectKey' in row; }
async function visibleRecording(row: StoredRecording | null): Promise<ReplaySession | null> {
  if (!row || !hasRecording(row) || row.privacy?.state === 'erasing' || row.privacy?.committed === false) return null;
  if (!await fencesHold(row)) return null;
  const { privacy: _privacy, ...recording } = row;
  return recording;
}
const currentGeneration = (row: ReplaySession): Promise<string | null> =>
  getStrictGrantGeneration(row.tenantId, row.subjectKey, 'analytics.replay', row.sessionKey);
const consentMatches = async (row: ReplaySession, generation: string): Promise<boolean> =>
  await currentGeneration(row) === generation;
const pendingWrites = (row: Recording): PendingWrite[] => row.privacy?.pending ?? [];

// ───────────────────────── enablement epoch (P2.5 disable) ──────────────────
/** A tenant's replay epoch. It changes each time replay is observed OFF, and a
 * recording is readable or writable only under the epoch it was reserved in,
 * so turning replay off fences every recording at once and turning it back on
 * cannot revive one. The sweep then deletes the fenced recordings. */
/** `applied`: the toggle writes (ADR 0951 P2 review #1) already applied to this
 *  tenant, so a pending write is applied once and never re-fences a recording
 *  made after it. A row exists for every tenant that ever reserved a recording
 *  (written before the first reservation), so it is also the list of tenants the
 *  sweep and a global toggle write visit, instead of a scan of every recording. */
type Enablement = { tenantId: string; epoch: string; disabled: boolean; applied?: Record<string, string> };
const ENABLEMENT_INITIAL = 'initial';
/** `applied` maps a write id to its marker time. A marker is dropped by the
 *  sweep after the settle window (hourly), so an entry older than this can no
 *  longer match a pending write and is pruned. If a marker outlives it (its
 *  sweep kept failing), applying it again only fences again: the safe side. */
const APPLIED_KEEP_MS = 3 * 60 * 60_000;
const APPLIED_MAX = 512;
function withApplied(current: Enablement['applied'], add: ReadonlyArray<Pick<PendingToggleWrite, 'writeId' | 'at'>>, nowMs = Date.now()): Record<string, string> {
  const keepFrom = new Date(nowMs - APPLIED_KEEP_MS).toISOString();
  const entries = [...Object.entries(current ?? {}), ...add.map((w): [string, string] => [w.writeId, w.at])]
    .filter(([, at]) => at >= keepFrom)
    .sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0))
    .slice(-APPLIED_MAX);
  return Object.fromEntries(entries);
}
const enablements = new DurableCollection<Enablement>('analytics:replay-enablement', (e) => e.tenantId, undefined, (e) => e.tenantId);
const epochOf = (row: Recording): string => row.privacy?.enablementEpoch ?? ENABLEMENT_INITIAL;
type EnablementState = { state: 'on' | 'off' | 'unknown'; epoch: string; exists?: boolean; pending?: readonly PendingToggleWrite[] };

/** Every toggle replay needs: the parent, the sub-toggle, and consent management. */
const REPLAY_TOGGLES = ['analytics', SESSION_REPLAY_TOGGLE, 'consent'] as const;
const isReplayToggle = (id: string): boolean => (REPLAY_TOGGLES as readonly string[]).includes(id);

// ───────────────────────── toggle writes (P2 review #1) ─────────────────────
/** A replay toggle write, recorded BEFORE the toggle store is written and kept
 *  until a sweep has applied it everywhere after the settle window. While it is
 *  pending, every read and sweep applies it first: if the written row resolves
 *  OFF for the tenant, the epoch rotates, whatever the live state is by then.
 *  So an OFF is recorded from what was written, never from a later re-read
 *  that may already see the admin's next write, a crashed listener or an outage. */
type PendingToggleWrite = { writeId: string; scope: string; rows: Record<string, ToggleConfig | null>; at: string };
const GLOBAL_WRITE_SCOPE = '*';
const toggleWrites = new DurableCollection<PendingToggleWrite>('analytics:replay-toggle-writes', (w) => `${w.scope}:${w.writeId}`);

function replayRows(write: ToggleWrite): Record<string, ToggleConfig | null> | null {
  const ids = write.ids.filter(isReplayToggle);
  if (ids.length === 0) return null;
  const rows: Record<string, ToggleConfig | null> = {};
  for (const id of ids) {
    const row = write.rows[id] ?? null;
    // A tenant-scoped write is applied to that tenant only: keep its override, not every tenant's.
    rows[id] = row && write.tenantId && row.tenantOverrides
      ? { ...row, tenantOverrides: write.tenantId in row.tenantOverrides ? { [write.tenantId]: row.tenantOverrides[write.tenantId]! } : {} }
      : row;
  }
  return rows;
}
const writeTurnsReplayOff = (write: Pick<PendingToggleWrite, 'rows'>, tenantId: string): boolean =>
  Object.keys(write.rows).some((id) => isReplayToggle(id) && resolveWrittenToggle(write, id, { tenantId })?.enabled === false);

/** The pending writes that can affect this tenant, oldest first. */
async function pendingToggleWrites(tenantId: string): Promise<PendingToggleWrite[]> {
  const [global, own] = await Promise.all([toggleWrites.listByPrefix(`${GLOBAL_WRITE_SCOPE}:`), toggleWrites.listByPrefix(`${tenantId}:`)]);
  return [...global.filter((w) => w.scope === GLOBAL_WRITE_SCOPE), ...own.filter((w) => w.scope === tenantId)]
    .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
}

/** Rotate the tenant's epoch for every write that turned replay OFF for it and
 *  has not been applied yet. A tenant with no row never reserved a recording,
 *  so there is nothing to fence. Returns the row after applying. */
async function applyToggleWrites(tenantId: string, writes: ReadonlyArray<Pick<PendingToggleWrite, 'writeId' | 'rows' | 'at'>>): Promise<Enablement | null> {
  const off = writes.filter((w) => writeTurnsReplayOff(w, tenantId));
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await enablements.get(tenantId);
    const todo = off.filter((w) => !current?.applied?.[w.writeId]);
    if (!current || todo.length === 0) return current;
    const applied = withApplied(current.applied, todo);
    const next: Enablement = current.disabled ? { ...current, applied } : { tenantId, epoch: randomUUID(), disabled: true, applied };
    if (await enablements.compareAndSwap(current, next)) {
      if (!current.disabled) log.info('replay_disabled_fenced', { tenantId, writes: todo.length });
      return next;
    }
  }
  throw contention();
}

/** Marker times order a toggle's writes ("the newest write of a toggle"), so two
 *  writes in one millisecond on this instance still get distinct, increasing times. */
let lastMarkerMs = 0;
function markerTime(): string {
  lastMarkerMs = Math.max(Date.now(), lastMarkerMs + 1);
  return new Date(lastMarkerMs).toISOString();
}

/** Registered as the toggle write INTENT: the marker lands before the toggle row,
 *  so a crash at any later point still leaves the write on record. */
export const recordReplayToggleIntent: ToggleWriteIntent = {
  async prepare(write) {
    const rows = replayRows(write);
    if (!rows) return;
    await toggleWrites.put({ writeId: write.writeId, scope: write.tenantId ?? GLOBAL_WRITE_SCOPE, rows, at: markerTime() });
  },
  async abandon(write) {
    if (!replayRows(write)) return;
    await toggleWrites.delete(`${write.tenantId ?? GLOBAL_WRITE_SCOPE}:${write.writeId}`);
  },
};

/** Run `fn` over `items`, at most `limit` at a time. */
async function forEachBounded<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => { while (next < items.length) await fn(items[next++]!); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
/** Toggle + storage state. A read error or an unregistered toggle is `unknown`,
 *  never `off`: an outage must not start deleting recordings. */
async function toggleState(tenantId: string): Promise<EnablementState['state']> {
  if (!replayStorageStatus().configured) return 'unknown';
  try {
    // `consent` too: with consent management off a visitor cannot withdraw (the
    // public consent lane 404s), so replay is off.
    const resolved = await Promise.all(REPLAY_TOGGLES.map((id) => resolveOne(id, { tenantId })));
    if (resolved.some((r) => !r)) return 'unknown';
    // An entitlement read that FAILED resolves `enabled:false, blockedBy:'unresolved'`:
    // an outage, not an answer. Only a real OFF (or a plan refusal) moves the epoch.
    if (resolved.some((r) => r!.blockedBy === 'unresolved')) return 'unknown';
    return resolved.every((r) => r!.enabled) ? 'on' : 'off';
  } catch { return 'unknown'; }
}

/** Observe the tenant's replay state and record a new epoch on an observed OFF. */
export async function observeReplayEnablement(tenantId: string): Promise<EnablementState> {
  // Pending toggle writes first, so an ON can never be accepted ahead of an OFF
  // that was written before it (P2 review #1).
  const pending = await pendingToggleWrites(tenantId);
  let current = await applyToggleWrites(tenantId, pending);
  const state = await toggleState(tenantId);
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) current = await enablements.get(tenantId);
    const epoch = current?.epoch ?? ENABLEMENT_INITIAL;
    if (state === 'unknown' || (state === 'on') === !current?.disabled) return { state, epoch, exists: Boolean(current), pending };
    // An OFF with no epoch row fences nothing: no recording was ever reserved
    // here (the row is written before the first reservation). Write nothing:
    // account deletion purges the tenant, then a toggle-override purge
    // notifies, and writing here would re-create a row for a deleted tenant.
    if (!current) return { state, epoch, exists: false };
    const next: Enablement = state === 'off'
      ? { ...current, epoch: randomUUID(), disabled: true }
      : { ...current, disabled: false };
    if (await enablements.compareAndSwap(current, next)) {
      if (state === 'off') log.info('replay_disabled_fenced', { tenantId });
      return { state, epoch: next.epoch, exists: true };
    }
  }
  throw contention();
}

/** Before a tenant's first reservation: the row that makes the tenant visible to
 *  global toggle writes and the sweep. Insert-if-absent; a concurrent creator
 *  writes the same initial row, and an OFF never creates one.
 *
 *  The OFF writes this observation saw are recorded as already applied, so a
 *  tenant's first recording after an OFF-then-ON is not fenced by that old OFF
 *  when the pending marker is applied later. Except the NEWEST pending write of
 *  a toggle: its marker lands before its row, so it may not have been written
 *  yet when replay read ON; it stays unapplied and fences when it lands. */
async function ensureEnablementRow(tenantId: string, observed: EnablementState): Promise<void> {
  const pending = observed.pending ?? [];
  const newest = new Map<string, PendingToggleWrite>();
  for (const write of pending) for (const id of Object.keys(write.rows)) newest.set(id, write); // oldest first
  const latest = new Set(newest.values());
  const seen = pending.filter((w) => !latest.has(w) && writeTurnsReplayOff(w, tenantId));
  await enablements.putIfAbsent({ tenantId, epoch: observed.epoch, disabled: false, ...(seen.length ? { applied: withApplied(undefined, seen) } : {}) });
}

// ───────────────────────── client-org eligibility (David: health/finance excluded) ─────
/** An owner/admin's attestation that a client organization is NOT in a health
 *  or finance category. Without one, nothing is offered, recorded or played back
 *  for that org: there is no reliable signal to infer it from, so the safe
 *  default is "excluded until a person says otherwise". */
type OrgEligibility = { tenantId: string; orgId: string; notHealthOrFinance: true; attestationId: string; attestedBy: string; attestedAt: string };
const eligibility = new DurableCollection<OrgEligibility>(
  'analytics:replay-org-eligibility', (e) => `${e.tenantId}:${e.orgId}`, undefined, (e) => e.tenantId,
);
export async function isReplayOrgEligible(tenantId: string, orgId: string): Promise<boolean> {
  return (await eligibility.get(`${tenantId}:${orgId}`))?.notHealthOrFinance === true;
}
/** The attestation in force for an org, or null. */
async function currentAttestation(tenantId: string, orgId: string): Promise<string | null> {
  const current = await eligibility.get(`${tenantId}:${orgId}`);
  return current?.notHealthOrFinance === true ? current.attestationId : null;
}
/** A recording is covered only by the attestation it was reserved under (its
 *  pinned id, never a clock comparison): a withdrawn then renewed attestation
 *  mints a new id, so earlier recordings stay excluded. */
/** Record or withdraw the attestation. Withdrawing fences the org's recordings at
 *  once (every read and write re-checks it) and the sweep deletes them.
 *
 *  P2 review #5: both are decisions about whether a client's visitors may be
 *  recorded, so each goes on the tenant's hash chain BEFORE it takes effect (an
 *  audit failure refuses it), and a withdrawal records the attestation it
 *  supersedes: who attested, and when, survive the row's deletion. A CAS that
 *  loses to a concurrent change leaves its entry as a recorded attempt; the
 *  attestation in force is the id pinned on the recordings. A no-op (attesting an
 *  attested org, withdrawing an unattested one) records nothing. */
export async function setReplayOrgEligibility(tenantId: string, orgId: string, eligible: boolean, actor: string): Promise<void> {
  const id = `${tenantId}:${orgId}`;
  const audit = async (payload: Record<string, unknown>): Promise<void> => {
    try { await appendChainAudit(tenantId, 'analytics.replay.eligibility', { orgId, eligible, actor, at: new Date().toISOString(), ...payload }); }
    catch { throw new OpenwopError('service_unavailable', 'The attestation record could not be saved, so nothing was changed.', 503, {}); }
  };
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await eligibility.get(id);
    if (eligible) {
      // Idempotent: re-attesting keeps the attestation in force, so it does not
      // fence that org's existing recordings. Insert-if-absent: two concurrent
      // attestations mint ONE id, so neither fences recordings reserved under the other.
      if (current?.notHealthOrFinance === true) return;
      const next: OrgEligibility = { tenantId, orgId, notHealthOrFinance: true, attestationId: randomUUID(), attestedBy: actor, attestedAt: new Date().toISOString() };
      await audit({ attestationId: next.attestationId });
      if (await eligibility.compareAndSwap(current, next)) { log.info('replay_org_eligibility_set', { tenantId, orgId, eligible }); return; }
    } else {
      if (!current) return;
      await audit({ supersedes: { attestationId: current.attestationId, attestedBy: current.attestedBy, attestedAt: current.attestedAt } });
      if (await eligibility.compareAndDelete(current)) { log.info('replay_org_eligibility_set', { tenantId, orgId, eligible }); return; }
    }
  }
  throw contention();
}

/** Every recording fence at once, against the pins of the row in hand (P2
 *  review #3: no re-read of the session row): the org's attestation, the live
 *  epoch AND the live consent generation. */
async function fencesHold(row: Recording): Promise<boolean> {
  const pins = row.privacy;
  if (!pins?.consentGeneration || !pins.eligibilityId) return false;
  const [attestation, enablement] = await Promise.all([currentAttestation(row.tenantId, row.orgId), observeReplayEnablement(row.tenantId)]);
  if (attestation !== pins.eligibilityId) return false;
  if (enablement.state !== 'on' || enablement.epoch !== epochOf(row)) return false;
  return consentMatches(row, pins.consentGeneration);
}
const keyOf = (row: Pick<ReplaySession, 'tenantId' | 'orgId' | 'sessionId'>): string => sessionId(row.tenantId, row.orgId, row.sessionId);
/** One counter per (tenant, org, UTC day). Incremented by CAS before a new
 *  session's first reservation, so the ceiling holds across instances. A
 *  reservation that then fails leaves the count high, never low. */
type Admission = { tenantId: string; orgId: string; day: string; sessions: number };
const admissions = new DurableCollection<Admission>(
  'analytics:replay-admission', (a) => `${a.tenantId}:${a.orgId}:${a.day}`, undefined, (a) => a.tenantId,
);

/** Deterministic, so a retried first chunk gets the same answer. Bound to the
 *  consented subject as well as the visit, so a client choosing session ids is
 *  still capped by the daily ceiling, which is the hard bound. */
export function replaySampled(row: Pick<ReplaySession, 'tenantId' | 'orgId' | 'subjectKey' | 'sessionId'>): boolean {
  const digest = createHash('sha256').update([row.tenantId, row.orgId, row.subjectKey, row.sessionId].join('\u0000')).digest();
  return digest.readUInt32BE(0) % 100 < replaySamplePercent();
}

async function admitNewSession(row: ReplaySession, nowMs: number): Promise<void> {
  if (!replaySampled(row)) {
    throw new OpenwopError('conflict', 'Session replay is not recording this visit.', 409, { reason: 'not_sampled' });
  }
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const id = `${row.tenantId}:${row.orgId}:${day}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await admissions.get(id);
    const sessions = current?.sessions ?? 0;
    if (sessions >= REPLAY_MAX_SESSIONS_PER_ORG_DAY) {
      throw new OpenwopError('rate_limited', 'Session replay reached this organization\'s daily recording limit.', 429, { reason: 'daily_limit' });
    }
    if (await admissions.compareAndSwap(current, { tenantId: row.tenantId, orgId: row.orgId, day, sessions: sessions + 1 })) return;
  }
  throw contention();
}

const writeRefused = (): OpenwopError => new OpenwopError('conflict', 'Session replay is no longer writable or another write is in progress.', 409, {});
const contention = (): OpenwopError => new OpenwopError('conflict', 'Session replay changed concurrently; retry the operation.', 409, {});

async function erasureRows(tenantId: string): Promise<Recording[]> {
  return (await sessions.listForTenantIndexed(tenantId)).filter((row): row is Recording => row.tenantId === tenantId && hasRecording(row));
}

/** P2 review #2 — the subject→recording pointers erasure reads instead of the
 *  tenant's recordings. One per identity a recording answers to (the consented
 *  subject and the analytics session key), written BEFORE the reservation, so
 *  an erasure that runs while the first chunk is in flight still finds it. Over-
 *  inclusive is safe: a pointer to a recording that never landed fences that id
 *  and is pruned. The key carries a digest of the identity, never the identity. */
type SubjectPointer = { tenantId: string; subjectHash: string; orgId: string; sessionId: string; at: string };
const subjectHash = (tenantId: string, subjectKey: string): string =>
  createHash('sha256').update(`${tenantId}\u0000${subjectKey}`).digest('hex').slice(0, 32);
const pointerId = (p: Pick<SubjectPointer, 'tenantId' | 'subjectHash' | 'orgId' | 'sessionId'>): string => `${p.tenantId}:${p.subjectHash}:${p.orgId}:${p.sessionId}`;
const subjectPointers = new DurableCollection<SubjectPointer>('analytics:replay-subject', pointerId, undefined, (p) => p.tenantId);
const identitiesOf = (row: Pick<ReplaySession, 'subjectKey' | 'sessionKey'>): string[] =>
  [...new Set([row.subjectKey, ...(row.sessionKey ? [row.sessionKey] : [])])];
async function writeSubjectPointers(row: ReplaySession): Promise<void> {
  const at = new Date().toISOString();
  for (const key of identitiesOf(row)) {
    await subjectPointers.put({ tenantId: row.tenantId, subjectHash: subjectHash(row.tenantId, key), orgId: row.orgId, sessionId: row.sessionId, at });
  }
}
async function deleteSubjectPointers(row: Pick<ReplaySession, 'tenantId' | 'orgId' | 'sessionId' | 'subjectKey' | 'sessionKey'>): Promise<void> {
  for (const key of identitiesOf(row)) {
    await subjectPointers.delete(pointerId({ tenantId: row.tenantId, subjectHash: subjectHash(row.tenantId, key), orgId: row.orgId, sessionId: row.sessionId })).catch(() => false);
  }
}
async function pointersFor(tenantId: string, subjectKey: string): Promise<SubjectPointer[]> {
  const hash = subjectHash(tenantId, subjectKey);
  return (await subjectPointers.listByPrefix(`${tenantId}:${hash}:`)).filter((p) => p.tenantId === tenantId && p.subjectHash === hash);
}

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
  return row && row.tenantId === tenantId && row.orgId === orgId ? visibleRecording(row) : null;
}

export async function listReplaySessionsForTenant(tenantId: string): Promise<ReplaySession[]> {
  if (!tenantId) return [];
  const visible: ReplaySession[] = [];
  for (const row of await erasureRows(tenantId)) {
    const recording = await visibleRecording(row);
    if (recording) visible.push(recording);
  }
  return visible;
}

/** One page of an org's playable recordings, newest first, for the viewer list.
 *  Bounded per request: rows are narrowed to this org, committed, active and
 *  unexpired BEFORE any fence read; the org-level fences (attestation, replay
 *  state, epoch) are read once; consent is read once per visitor and only for
 *  rows on this page. `cursor` is the last row's `startedAt|sessionId`. */
export const REPLAY_LIST_PAGE = 50;
export async function listReplaySessionsForOrg(tenantId: string, orgId: string, opts: { cursor?: string; nowMs?: number } = {}): Promise<{ sessions: ReplaySession[]; nextCursor?: string }> {
  if (!tenantId || !orgId) return { sessions: [] };
  const attestation = await currentAttestation(tenantId, orgId);
  const enablement = await observeReplayEnablement(tenantId);
  if (!attestation || enablement.state !== 'on') return { sessions: [] };
  const cutoff = defaultCutoffIso(opts.nowMs ?? Date.now());
  const order = (r: Recording): string => `${r.startedAt}|${r.sessionId}`;
  // P2 review #2: the org's own slice of the primary keyspace (ids are
  // `tenant:org:session`), never the whole tenant. The prefix is a superset when
  // ids contain ':'; the exact tenant and org are checked on every row.
  const candidates = (await sessions.listByPrefix(`${tenantId}:${orgId}:`))
    .filter((r): r is Recording => r.tenantId === tenantId && hasRecording(r))
    .filter((r) => r.orgId === orgId && r.privacy?.state === 'active' && r.privacy.committed !== false
      && r.startedAt >= cutoff && r.privacy.eligibilityId === attestation && epochOf(r) === enablement.epoch
      && Boolean(r.privacy.consentGeneration) && (!opts.cursor || order(r) < opts.cursor))
    .sort((a, b) => (order(a) < order(b) ? 1 : -1));
  const generations = new Map<string, Promise<string | null>>();
  const visible: ReplaySession[] = [];
  let last: Recording | undefined;
  for (const row of candidates) {
    if (visible.length >= REPLAY_LIST_PAGE) break;
    last = row;
    const subject = JSON.stringify([row.subjectKey, row.sessionKey ?? null]);
    if (!generations.has(subject)) generations.set(subject, currentGeneration(row));
    if (await generations.get(subject) !== row.privacy?.consentGeneration) continue;
    const { privacy: _privacy, ...recording } = row;
    visible.push(recording);
  }
  const more = last !== undefined && candidates.indexOf(last) < candidates.length - 1;
  return { sessions: visible, ...(more && last ? { nextCursor: order(last) } : {}) };
}

/** P2 review #8: the analytics session key is stored in the index row (a PII
 *  field), so it is bounded like a consent subject key. */
export const REPLAY_MAX_SESSION_KEY_LENGTH = 256;
export function assertReplaySessionKey(sessionKey: unknown): asserts sessionKey is string | undefined {
  if (sessionKey === undefined) return;
  if (typeof sessionKey !== 'string' || !sessionKey.trim() || sessionKey.length > REPLAY_MAX_SESSION_KEY_LENGTH) {
    throw new OpenwopError('validation_error', `\`sessionKey\` must be a non-empty string of at most ${REPLAY_MAX_SESSION_KEY_LENGTH} characters.`, 400, { field: 'sessionKey' });
  }
}

/** The org-level fences an upload needs, read once (P2 review #9): the upload
 *  lane reads them BEFORE decoding a chunk, and hands them to `putReplayChunk`
 *  so they are not read again. Null when this org cannot record right now. */
export type ReplayOrgFences = { eligibilityId: string; enablement: EnablementState };
export async function readReplayOrgFences(tenantId: string, orgId: string): Promise<ReplayOrgFences | null> {
  if (!replayStorageStatus().configured) return null;
  const [eligibilityId, enablement] = await Promise.all([currentAttestation(tenantId, orgId), observeReplayEnablement(tenantId)]);
  return eligibilityId && enablement.state === 'on' ? { eligibilityId, enablement } : null;
}

/** Reserve durably BEFORE touching blob storage, then finalize by CAS. Erasure
 * sees the reservation even when the first put is still in flight. A crashed
 * writer leaves an unsettled receipt: an empty prefix cannot prove its put will
 * never finish. Provider-specific settlement is required before clearing one. */
export async function putReplayChunk(row: ReplaySession, chunkIndex: number, contentBase64: string, prefetched?: ReplayOrgFences): Promise<void> {
  if (!replayStorageStatus().configured) {
    throw new OpenwopError('service_unavailable', 'Session replay storage is not configured.', 503, { feature: SESSION_REPLAY_TOGGLE });
  }
  assertReplaySessionKey(row.sessionKey);
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= REPLAY_MAX_SESSION_CHUNKS) {
    throw new OpenwopError('validation_error', 'Invalid replay chunk index.', 400, {});
  }
  // Bound before allocation; Buffer.from alone silently accepts malformed base64.
  if (typeof contentBase64 !== 'string' || contentBase64.length === 0
    || contentBase64.length > 4 * Math.ceil(REPLAY_MAX_CHUNK_BYTES / 3) || contentBase64.length % 4 !== 0) {
    throw new OpenwopError('validation_error', 'Invalid or oversized replay chunk.', 400, {});
  }
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.length === 0 || bytes.length > REPLAY_MAX_CHUNK_BYTES || bytes.toString('base64') !== contentBase64) {
    throw new OpenwopError('validation_error', 'Invalid or oversized replay chunk.', 400, {});
  }
  const receipt: ChunkReceipt = { digest: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  const reservation: PendingWrite = { id: randomUUID(), chunkIndex, ...receipt, reservedAt: new Date().toISOString() };
  const fences = prefetched ?? await readReplayOrgFences(row.tenantId, row.orgId);
  if (!fences) throw writeRefused();
  const { eligibilityId, enablement } = fences;
  if (!enablement.exists) await ensureEnablementRow(row.tenantId, enablement);
  const enablementEpoch = enablement.epoch;
  const consentGeneration = await currentGeneration(row);
  if (!consentGeneration) throw writeRefused();
  let reserved = false;
  let admitted = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await sessions.get(keyOf(row));
    const nowMs = Date.now();
    if (!current && !admitted) {
      await admitNewSession(row, nowMs);
      admitted = true;
      await writeSubjectPointers(row); // before the reservation: erasure must find an in-flight first chunk
    }
    if (current && hasRecording(current) && nowMs - Date.parse(current.startedAt) > REPLAY_MAX_SESSION_MS) {
      throw new OpenwopError('conflict', 'Session replay reached its maximum length for this visit.', 409, { reason: 'session_length' });
    }
    if (current && (!hasRecording(current) || current.privacy?.state === 'erasing'
      || current.tenantId !== row.tenantId || current.orgId !== row.orgId
      || current.subjectKey !== row.subjectKey || current.sessionKey !== row.sessionKey
      || current.privacy?.consentGeneration !== consentGeneration
      || epochOf(current) !== enablementEpoch
      || current.privacy?.eligibilityId !== eligibilityId)) throw writeRefused();
    const recording = current as Recording | null;
    // A legacy row has no immutable per-sequence evidence. Never overwrite an
    // unknown old chunk or pretend its bytes are absent from the budget.
    if (recording && !recording.privacy?.chunks) throw writeRefused();
    const chunks = recording?.privacy?.chunks ?? {};
    const prior = chunks[String(chunkIndex)];
    if (prior) {
      if (prior.digest !== receipt.digest || prior.bytes !== receipt.bytes) throw writeRefused();
      // The org fences were read above this call; consent is re-read.
      if (!await consentMatches(row, consentGeneration)) throw writeRefused();
      return; // Identical retry: no new PUT, metadata update or budget charge.
    }
    const pending = recording ? pendingWrites(recording) : [];
    if (pending.length >= 32 || pending.some((write) => write.chunkIndex === chunkIndex)) throw writeRefused();
    const committedBytes = Object.values(chunks).reduce((total, chunk) => total + chunk.bytes, 0);
    const reservedBytes = pending.reduce((total, write) => total + write.bytes, 0);
    if (!Number.isSafeInteger(committedBytes) || !Number.isSafeInteger(reservedBytes)
      || committedBytes + reservedBytes + receipt.bytes > REPLAY_MAX_SESSION_BYTES) throw writeRefused();
    const now = new Date().toISOString();
    const next: Recording = { ...(recording ?? row),
      startedAt: recording?.startedAt ?? now, updatedAt: recording?.updatedAt ?? now,
      bytes: committedBytes, chunkCount: Object.keys(chunks).length, privacy: {
      state: 'active', committed: recording ? recording.privacy?.committed !== false : false,
      pending: [...pending, reservation], chunks, consentGeneration, enablementEpoch, eligibilityId,
    } };
    if (await sessions.compareAndSwap(current, next)) { reserved = true; break; }
  }
  if (!reserved) throw contention();
  const blob = replayBlob();
  const key = `${replayChunkPrefix(row.tenantId, row.orgId, row.sessionId)}${chunkIndex}`;
  let putStarted = false;
  let putAcknowledged = false;
  let refusalConfirmed = false;
  // P2 review #3: the org fences (attestation, replay state, epoch) were read
  // once, before the reservation, and are pinned on the row. A disable or a
  // withdrawn attestation that lands while this chunk is in flight leaves it
  // unreadable (every read re-checks every fence) and the sweep deletes it.
  // Consent, which a visitor can move at any moment, is re-read at each boundary.
  const requireCurrentConsent = async (recording: ReplaySession): Promise<void> => {
    if (!await consentMatches(recording, consentGeneration)) {
      refusalConfirmed = true;
      throw writeRefused();
    }
  };
  try {
    // Withdrawal can scan before the first reservation CAS lands. Recheck now
    // so that an empty scan cannot strand a newly admitted, unseen writer.
    await requireCurrentConsent(row);
    putStarted = true;
    const res = await blob.put({ key, contentBase64, contentType: 'application/octet-stream', signal: AbortSignal.timeout(REPLAY_PUT_DEADLINE_MS) }) as { ok?: boolean } | null | undefined;
    if (res?.ok !== true) throw new OpenwopError('internal_error', 'Session replay chunk storage was not acknowledged.', 500, {});
    putAcknowledged = true;
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await sessions.get(keyOf(row));
      if (!current || !hasRecording(current) || current.privacy?.state === 'erasing') throw writeRefused();
      if (!pendingWrites(current).some((write) => write.id === reservation.id)) throw writeRefused();
      if (current.privacy?.consentGeneration !== consentGeneration || epochOf(current) !== enablementEpoch) throw writeRefused();
      await requireCurrentConsent(current);
      // Sequence order owns the cumulative metadata snapshot, not a visitor's
      // clock or the order concurrent blob PUTs happen to finish.
      const latest = Math.max(-1, ...Object.keys(current.privacy?.chunks ?? {}).map(Number));
      const chunks = { ...current.privacy?.chunks, [String(chunkIndex)]: receipt };
      const now = new Date().toISOString();
      const next: Recording = { ...(chunkIndex > latest ? row : current),
        startedAt: current.startedAt, updatedAt: now > current.updatedAt ? now : current.updatedAt,
        bytes: Object.values(chunks).reduce((total, chunk) => total + chunk.bytes, 0),
        chunkCount: Object.keys(chunks).length, privacy: {
          state: 'active', committed: true, pending: pendingWrites(current).filter((write) => write.id !== reservation.id), chunks, consentGeneration, enablementEpoch, eligibilityId,
        } };
      if (await sessions.compareAndSwap(current, next)) {
        // The consent and replay rows do not share a transaction. A refusal
        // between the check and CAS must not be acknowledged as successful.
        // Read visibility independently checks the generation even if this
        // process dies before the post-check or cleanup callback runs.
        await requireCurrentConsent(next);
        return;
      }
    }
    throw contention();
  } catch (error) {
    // A CAS acknowledgement can be lost after committing. An active row from
    // which only this writer's reservation disappeared proves finalization;
    // deleting its blob here would corrupt a successfully committed recording.
    const acknowledged = await sessions.get(keyOf(row));
    if (putAcknowledged && acknowledged && hasRecording(acknowledged) && acknowledged.privacy?.state === 'active'
      && acknowledged.privacy.committed && acknowledged.privacy.chunks?.[String(chunkIndex)]?.digest === receipt.digest
      && !pendingWrites(acknowledged).some((write) => write.id === reservation.id)) {
      if (acknowledged.privacy.consentGeneration === consentGeneration && epochOf(acknowledged) === enablementEpoch
        && await fencesHold(acknowledged)) return;
      await deleteReplaySession(acknowledged);
      throw error;
    }
    // A rejected PUT can remain in flight at the provider after the local
    // response is lost. Delete currently visible bytes, but retain that receipt:
    // even an acknowledged DELETE/empty prefix cannot order the unknown PUT.
    // Never delete bytes another (retried) writer committed at this index: an
    // identical committed digest means those bytes are the recording's.
    const committedHere = acknowledged && hasRecording(acknowledged) && acknowledged.privacy?.chunks?.[String(chunkIndex)]?.digest === receipt.digest;
    const removed = committedHere ? { ok: true } : await blob.delete({ key }) as { ok?: boolean } | null | undefined;
    if (removed?.ok !== true) throw new OpenwopError('internal_error', 'Session replay write cleanup is pending.', 500, {});
    if (putStarted && !putAcknowledged) throw error;
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await sessions.get(keyOf(row));
      if (!current || !hasRecording(current) || !pendingWrites(current).some((write) => write.id === reservation.id)) break;
      const next: Recording = { ...current, privacy: {
        state: current.privacy?.state ?? 'active', committed: current.privacy?.committed !== false,
        pending: pendingWrites(current).filter((write) => write.id !== reservation.id),
        ...(current.privacy?.chunks ? { chunks: current.privacy.chunks } : {}),
        ...(current.privacy?.consentGeneration ? { consentGeneration: current.privacy.consentGeneration } : {}),
        ...(current.privacy?.enablementEpoch ? { enablementEpoch: current.privacy.enablementEpoch } : {}),
        ...(current.privacy?.eligibilityId ? { eligibilityId: current.privacy.eligibilityId } : {}),
      } };
      if (await sessions.compareAndSwap(current, next)) break;
    }
    if (refusalConfirmed) await deleteReplaySession(row);
    throw error;
  }
}

// ───────────────────────── playback (P2.4) ──────────────────────────────────

const replayNotFound = (): OpenwopError => new OpenwopError('not_found', 'Recording not found.', 404, {});

/** P2 review #4 — one audited playback grant per (viewer, recording). The first
 *  chunk a viewer reads appends ONE `analytics.replay.viewed` entry to the
 *  tenant's hash chain, then stores the grant; later chunks inside the grant's
 *  window read the grant instead of appending again (a 2048-chunk recording was
 *  2048 chain appends under the per-tenant lock). No byte is released without a
 *  current grant row, and every chunk still re-checks access and every fence. */
export const REPLAY_PLAYBACK_GRANT_MS = 10 * 60_000;
type PlaybackGrant = { tenantId: string; orgId: string; sessionId: string; viewer: string; grantId: string; grantedAt: string; expiresAt: string };
const grantKey = (g: Pick<PlaybackGrant, 'tenantId' | 'orgId' | 'sessionId' | 'viewer'>): string => `${g.tenantId}:${g.orgId}:${g.sessionId}:${g.viewer}`;
const playbackGrants = new DurableCollection<PlaybackGrant>('analytics:replay-playback-grant', grantKey, undefined, (g) => g.tenantId);
declarePiiFields('analytics.replay-playback-grant', ['viewer'], { maskGloballyByFieldName: false });

async function ensurePlaybackGrant(input: Pick<PlaybackGrant, 'tenantId' | 'orgId' | 'sessionId' | 'viewer'>, nowMs: number): Promise<void> {
  const current = await playbackGrants.get(grantKey(input));
  if (current && current.tenantId === input.tenantId && current.viewer === input.viewer && Date.parse(current.expiresAt) > nowMs) return;
  const grant: PlaybackGrant = { ...input, grantId: randomUUID(), grantedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + REPLAY_PLAYBACK_GRANT_MS).toISOString() };
  try {
    // Audit BEFORE the grant exists, so a grant (and so a byte) always has its entry.
    await appendChainAudit(input.tenantId, 'analytics.replay.viewed', {
      orgId: input.orgId, sessionId: input.sessionId, viewer: input.viewer, grantId: grant.grantId, at: grant.grantedAt, expiresAt: grant.expiresAt,
    });
    await playbackGrants.put(grant);
  } catch {
    throw new OpenwopError('service_unavailable', 'The viewing record could not be saved, so the recording was not shown.', 503, {});
  }
  void recordGovernanceDecision({ tenantId: input.tenantId, kind: 'access', outcome: 'allow', reason: 'analytics.replay.viewed', resource: `replay:${input.orgId}:${input.sessionId}`, principalId: input.viewer });
}
async function deletePlaybackGrants(row: Pick<ReplaySession, 'tenantId' | 'orgId' | 'sessionId'>): Promise<void> {
  for (const g of await playbackGrants.listByPrefix(`${row.tenantId}:${row.orgId}:${row.sessionId}:`)) {
    if (g.tenantId === row.tenantId && g.orgId === row.orgId && g.sessionId === row.sessionId) await playbackGrants.delete(grantKey(g)).catch(() => false);
  }
}
async function pruneExpiredGrants(tenantId: string, nowMs: number): Promise<void> {
  for (const g of await playbackGrants.listForTenant(tenantId)) {
    if (g.tenantId === tenantId && Date.parse(g.expiresAt) <= nowMs) await playbackGrants.delete(grantKey(g)).catch(() => false);
  }
}

/** The recording a viewer may read right now, or a uniform 404: missing, still
 *  pending, erased, fenced by consent or a disable, or past its fixed expiry
 *  all look the same, so the route cannot be used to discover anything. */
async function viewableRecording(tenantId: string, orgId: string, sessionId: string, nowMs: number): Promise<Recording> {
  const row = await sessions.get(keyOf({ tenantId, orgId, sessionId }));
  if (!row || row.tenantId !== tenantId || row.orgId !== orgId || !hasRecording(row) || !await visibleRecording(row)) throw replayNotFound();
  if (!(row.startedAt >= defaultCutoffIso(nowMs))) throw replayNotFound(); // fixed expiry from the server start
  return row;
}

/**
 * P2.4 — one chunk of one recording for a viewer, checked at the moment of
 * release. Order: the viewer must hold `host:analytics:replay` on the EXACT org;
 * the recording must be visible (consent generation, disable epoch, committed,
 * not erasing) and inside its fixed expiry; the view is persisted to the
 * tenant's hash chain BEFORE any byte is read (once per viewer per grant
 * window, P2 review #4), and an audit failure refuses the content; the bytes must match their receipt; and every check is repeated
 * after the fetch, so a revocation, withdrawal or disable that lands while the
 * bytes are in flight still wins. An earlier list or player load is never
 * permission for this read.
 */
export async function readReplayChunkForViewer(input: {
  tenantId: string; orgId: string; sessionId: string; chunkIndex: number; viewer: string; personalTenant?: string;
}): Promise<{ contentBase64: string; chunkIndex: number }> {
  const { tenantId, orgId, sessionId, chunkIndex, viewer } = input;
  if (!viewer) throw new OpenwopError('unauthenticated', 'Sign in to view recordings.', 401, {});
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= REPLAY_MAX_SESSION_CHUNKS) throw replayNotFound();
  const authorize = () => assertOrgScope(tenantId, viewer, orgId, 'host:analytics:replay',
    input.personalTenant ? { personalTenant: input.personalTenant } : {});
  await authorize();
  const row = await viewableRecording(tenantId, orgId, sessionId, Date.now());
  const receipt = row.privacy?.chunks?.[String(chunkIndex)];
  if (!receipt) throw replayNotFound();
  await ensurePlaybackGrant({ tenantId, orgId, sessionId, viewer }, Date.now());
  const got = (await replayBlob().get({ key: `${replayChunkPrefix(tenantId, orgId, sessionId)}${chunkIndex}` })) as { found?: boolean; contentBase64?: unknown };
  if (got?.found !== true || typeof got.contentBase64 !== 'string') throw replayNotFound();
  const bytes = Buffer.from(got.contentBase64, 'base64');
  if (bytes.length !== receipt.bytes || createHash('sha256').update(bytes).digest('hex') !== receipt.digest) {
    log.error('replay_chunk_integrity_failed', { tenantId, orgId, sessionId, chunkIndex });
    throw replayNotFound();
  }
  // Release only if every check still holds now that the bytes are in hand.
  await authorize();
  const after = await viewableRecording(tenantId, orgId, sessionId, Date.now());
  if (after.privacy?.chunks?.[String(chunkIndex)]?.digest !== receipt.digest) throw replayNotFound();
  return { contentBase64: got.contentBase64, chunkIndex };
}

/** Every chunk key stored for a session (all pages). */
async function listChunkKeys(prefix: string): Promise<string[]> {
  const blob = replayBlob();
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r = (await blob.list({ prefix, ...(cursor ? { cursor } : {}) })) as { entries?: Array<{ key?: unknown }>; nextCursor?: string };
    for (const e of r.entries ?? []) if (typeof e.key === 'string') keys.push(e.key);
    if (!r.nextCursor) return keys;
    if (r.nextCursor === cursor) throw new OpenwopError('internal_error', 'Session replay blob listing did not advance.', 500, {});
    cursor = r.nextCursor;
  }
  throw new OpenwopError('internal_error', 'Session replay blob listing exceeded its bounded scan.', 500, {});
}

/**
 * P2.5 — settle receipts whose upload outcome is unknown. A receipt older than
 * `REPLAY_SETTLE_AFTER_MS` belongs to an upload that was aborted at its deadline
 * or died with its process, so it can no longer land: delete whatever it stored,
 * then drop the receipt. Only on a backend that enforces the deadline. A receipt
 * with no `reservedAt` is stamped `observedAt` first and settled a window later.
 * Returns how many receipts remain unsettled.
 */
async function settleStaleWrites(row: Pick<ReplaySession, 'tenantId' | 'orgId' | 'sessionId'>, nowMs: number): Promise<number> {
  const backend = resolveBackendId('blob');
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await sessions.get(keyOf(row));
    if (!current || !hasRecording(current)) return 0;
    const pending = pendingWrites(current);
    if (pending.length === 0) return 0;
    if (!SETTLEABLE_BACKENDS.has(backend) || !replayStorageStatus().configured) return pending.length;
    const since = (write: PendingWrite): number => Date.parse(write.reservedAt ?? write.observedAt ?? '');
    const unstamped = pending.some((write) => !Number.isFinite(since(write)));
    const due = pending.filter((write) => nowMs - since(write) >= REPLAY_SETTLE_AFTER_MS);
    if (!unstamped && due.length === 0) return pending.length;
    const blob = replayBlob();
    for (const write of due) {
      const key = `${replayChunkPrefix(row.tenantId, row.orgId, row.sessionId)}${write.chunkIndex}`;
      const removed = (await blob.delete({ key }).catch(() => ({ ok: false }))) as { ok?: boolean } | null | undefined;
      if (removed?.ok !== true) return pending.length;
    }
    const observedAt = new Date(nowMs).toISOString();
    const dueIds = new Set(due.map((write) => write.id));
    const next: Recording = { ...current, privacy: {
      state: current.privacy?.state ?? 'active', committed: current.privacy?.committed !== false,
      pending: pending.filter((write) => !dueIds.has(write.id))
        .map((write) => (Number.isFinite(since(write)) ? write : { ...write, observedAt })),
      ...(current.privacy?.chunks ? { chunks: current.privacy.chunks } : {}),
      ...(current.privacy?.consentGeneration ? { consentGeneration: current.privacy.consentGeneration } : {}),
      ...(current.privacy?.enablementEpoch ? { enablementEpoch: current.privacy.enablementEpoch } : {}),
      ...(current.privacy?.eligibilityId ? { eligibilityId: current.privacy.eligibilityId } : {}),
    } };
    if (await sessions.compareAndSwap(current, next)) return next.privacy!.pending.length;
  }
  throw contention();
}

/**
 * D4 — fence reads and new writes FIRST, then delete blobs. Pending writes and
 * failed deletes retain a hidden retry record. Only settled deletion reduces
 * it to an opaque identity fence, without subject/session keys or page history.
 */
export async function deleteReplaySession(row: ReplaySession): Promise<void> {
  let fenced = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await sessions.get(keyOf(row));
    if (current && (current.tenantId !== row.tenantId || current.orgId !== row.orgId)) throw writeRefused();
    if (current && !hasRecording(current)) return;
    if (current?.privacy?.state === 'erasing') { fenced = true; break; }
    const next: Recording = { ...(current ?? row), privacy: {
      state: 'erasing', committed: current?.privacy?.committed !== false, pending: current ? pendingWrites(current) : [],
      ...(current?.privacy?.chunks ? { chunks: current.privacy.chunks } : {}),
      ...(current?.privacy?.consentGeneration ? { consentGeneration: current.privacy.consentGeneration } : {}),
      ...(current?.privacy?.enablementEpoch ? { enablementEpoch: current.privacy.enablementEpoch } : {}),
      ...(current?.privacy?.eligibilityId ? { eligibilityId: current.privacy.eligibilityId } : {}),
    } };
    if (await sessions.compareAndSwap(current, next)) { fenced = true; break; }
  }
  if (!fenced) throw contention();
  const prefix = replayChunkPrefix(row.tenantId, row.orgId, row.sessionId);
  if (replayStorageStatus().configured) {
    const blob = replayBlob();
    let failed = 0;
    for (const key of await listChunkKeys(prefix)) {
      const r = (await blob.delete({ key }).catch(() => ({ ok: false }))) as { ok?: boolean } | null | undefined;
      if (r?.ok !== true) failed += 1;
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
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await sessions.get(keyOf(row));
    if (!current || !hasRecording(current)) return;
    if (pendingWrites(current).length > 0) {
      if (await settleStaleWrites(row, Date.now()) > 0) throw new OpenwopError('internal_error', 'Session replay erasure awaits unsettled blob writes.', 500, {});
      continue;
    }
    const erased: ErasedRecording = { tenantId: row.tenantId, orgId: row.orgId, sessionId: row.sessionId, privacy: { state: 'erased', erasedAt: new Date().toISOString() } };
    if (await sessions.compareAndSwap(current, erased)) { await deleteSubjectPointers(current); await deletePlaybackGrants(row); return; }
  }
  throw contention();
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
  // P2 review #2: the subject's pointers, never a scan of the tenant's
  // recordings. The public reject lane calls this for every explicit refusal;
  // a visitor who was never recorded costs one empty prefix read.
  let rowsTouched = 0;
  let failed = 0;
  for (const pointer of await pointersFor(tenantId, subjectKey)) {
    const stored = await sessions.get(sessionId(tenantId, pointer.orgId, pointer.sessionId));
    try {
      if (stored && stored.tenantId === tenantId && hasRecording(stored)) {
        // The pointer is a digest: confirm the recording answers to this identity.
        if (stored.subjectKey !== subjectKey && stored.sessionKey !== subjectKey) continue;
        await deleteReplaySession(stored); rowsTouched += 1;
      } else if (!stored) {
        // No row yet: a first chunk may be between its pointer and its
        // reservation. Fence the id so that reservation is refused.
        await deleteReplaySession({ tenantId, orgId: pointer.orgId, sessionId: pointer.sessionId, subjectKey, pageIds: [],
          startedAt: pointer.at, updatedAt: pointer.at, durationMs: 0, bytes: 0, chunkCount: 0, flags: {} });
      }
      await subjectPointers.delete(pointerId(pointer)).catch(() => false);
    } catch (err) {
      failed += 1;
      log.error('replay_erase_failed', { tenantId, orgId: pointer.orgId, sessionId: pointer.sessionId, error: err instanceof Error ? err.message : String(err) });
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


// ───────────────────────── retention (D3/D4) ────────────────────────────────

async function purgeOlderThan(rows: readonly Recording[], cutoffIso: string): Promise<PurgeOutcome> {
  // ADR 0951 P2.3: receiving another chunk never renews the retention window.
  // Strict `<`, as purgeRowsByAge.
  const due = rows.filter((row) => row.privacy?.state === 'erasing' || row.startedAt < cutoffIso);
  return deleteRows(due, 'replay_retention_delete_failed');
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
    return purgeOlderThan(await erasureRows(tenantId), cutoffIso > own ? cutoffIso : own);
  },
});

/** P2.2 reconciliation: at most this many live-generation reads per sweep. */
export const REPLAY_RECONCILE_MAX_PER_SWEEP = 200;
let reconcileCursor = 0;

/**
 * P2.2 — a recording pinned to a consent generation that is no longer current
 * is already unreadable, but its bytes outlive a failed withdrawal callback or
 * a writer that crashed before its post-check. Find those rows and delete them
 * so withdrawal does not wait for the retention window. Bounded: a rotating
 * window of `REPLAY_RECONCILE_MAX_PER_SWEEP` rows per sweep, one generation
 * read per subject. Only a CONFIRMED mismatch deletes; a consent-store error
 * leaves the row for a later sweep. Legacy rows without a pinned generation
 * stay with the retention window: there is no withdrawal to observe.
 */
async function revokedRecordings(rows: readonly Recording[]): Promise<Recording[]> {
  const candidates = rows.filter((r) => r.privacy?.state !== 'erasing' && r.privacy?.consentGeneration);
  if (candidates.length === 0) return [];
  const start = reconcileCursor % candidates.length;
  const window = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, REPLAY_RECONCILE_MAX_PER_SWEEP);
  reconcileCursor = start + window.length;
  const generations = new Map<string, Promise<string | null>>();
  const revoked: Recording[] = [];
  for (const row of window) {
    const subject = JSON.stringify([row.tenantId, row.subjectKey, row.sessionKey ?? null]);
    if (!generations.has(subject)) generations.set(subject, currentGeneration(row));
    let current: string | null;
    try { current = await generations.get(subject)!; }
    catch (err) {
      log.warn('replay_reconcile_consent_unavailable', { tenantId: row.tenantId, orgId: row.orgId, sessionId: row.sessionId, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (current !== row.privacy?.consentGeneration) revoked.push(row);
  }
  return revoked;
}

/** P2.5 — recordings fenced by a replay disable (their epoch is no longer the
 *  tenant's). One observation per tenant; an `unknown` state deletes nothing. */
async function disabledRecordings(rows: readonly Recording[]): Promise<Recording[]> {
  const epochs = new Map<string, EnablementState>();
  /** null = no attestation in force; undefined = could not read it. */
  const attestations = new Map<string, string | null | undefined>();
  const fenced: Recording[] = [];
  for (const row of rows) {
    if (row.privacy?.state === 'erasing') continue;
    if (!epochs.has(row.tenantId)) {
      try { epochs.set(row.tenantId, await observeReplayEnablement(row.tenantId)); }
      catch (err) {
        log.warn('replay_enablement_unavailable', { tenantId: row.tenantId, error: err instanceof Error ? err.message : String(err) });
        epochs.set(row.tenantId, { state: 'unknown', epoch: '' });
      }
    }
    const current = epochs.get(row.tenantId)!;
    if (current.state !== 'unknown' && epochOf(row) !== current.epoch) { fenced.push(row); continue; }
    // The row is in hand: compare its pinned id with the org's attestation,
    // read once per org per sweep (no per-row re-read).
    const org = `${row.tenantId}:${row.orgId}`;
    if (!attestations.has(org)) {
      try { attestations.set(org, await currentAttestation(row.tenantId, row.orgId)); }
      catch { attestations.set(org, undefined); } // unknown: delete nothing for this org
    }
    const attestation = attestations.get(org);
    if (attestation === undefined) continue;
    if (row.privacy?.eligibilityId !== attestation) fenced.push(row);
  }
  return fenced;
}

/** D3 — the default window, enforced on every posture (the governance lane above
 *  runs only for governed tenants behind an env opt-in). Legal holds skip their
 *  tenant's rows. A full scan of the index: rows are small and bounded by the
 *  per-org session caps (D3); the tenant index takes over if it ever is not.
 *  P2.2: the same sweep reconciles recordings whose consent was withdrawn. */
export async function sweepExpiredReplays(nowMs: number = Date.now()): Promise<PurgeOutcome> {
  const cutoff = defaultCutoffIso(nowMs);
  await backfillReplayIndexes();
  // P2 review #2: the tenants that ever reserved a recording (each has an
  // enablement row), then each tenant's own index slice: never a cross-tenant
  // list of every recording.
  const tenants = (await enablements.list()).map((e) => e.tenantId);
  await reconcileToggleWrites(tenants, nowMs);
  const all: StoredRecording[] = [];
  for (const tenant of tenants) {
    // The primary keyspace's tenant slice (ids are `tenant:org:session`), which
    // a missing index marker cannot hide a row from. Exact tenant checked per row.
    const rows = (await sessions.listForTenant(tenant)).filter((r) => r.tenantId === tenant);
    all.push(...rows);
    await prunePointers(tenant, rows, nowMs);
    await pruneAdmissionCounters(tenant, nowMs);
    await pruneExpiredGrants(tenant, nowMs);
  }
  const recordings = all.filter((r): r is Recording => hasRecording(r));
  const expired = recordings.filter((r) => r.privacy?.state === 'erasing' || r.startedAt < cutoff);
  const expiredSet = new Set(expired);
  const disabled = await disabledRecordings(recordings.filter((r) => !expiredSet.has(r)));
  const disabledSet = new Set(disabled);
  const revoked = [...disabled, ...await revokedRecordings(recordings.filter((r) => !expiredSet.has(r) && !disabledSet.has(r)))];
  const held = new Map<string, boolean>();
  const eligible: Recording[] = [];
  for (const row of [...expired, ...revoked]) {
    if (!held.has(row.tenantId)) held.set(row.tenantId, Boolean(await getRetentionHold(row.tenantId)));
    if (row.privacy?.state === 'erasing' || !held.get(row.tenantId)) eligible.push(row);
  }
  const revokedSet = new Set(revoked);
  const [aged, withdrawn] = [eligible.filter((r) => !revokedSet.has(r)), eligible.filter((r) => revokedSet.has(r))];
  const a = await purgeOlderThan(aged, cutoff);
  const w = await deleteRows(withdrawn, 'replay_reconcile_delete_failed');
  const eligibleSet = new Set(eligible);
  await settleLiveRecordings(recordings.filter((r) => !eligibleSet.has(r)), nowMs);
  await pruneErasedFences(all.filter((r): r is ErasedRecording => !hasRecording(r)), nowMs);
  return { deleted: a.deleted + w.deleted, failed: (a.failed ?? 0) + (w.failed ?? 0) };
}

/** P2 review #1 — apply every pending toggle write (a global one to every
 *  tenant with an enablement row), then drop the ones older than the settle
 *  window. A write is kept that long so a tenant whose first reservation raced
 *  it still gets it applied on its next read. The collection holds only the
 *  last window's toggle writes, so the full list is small. */
async function reconcileToggleWrites(tenants: readonly string[], nowMs: number): Promise<void> {
  for (const write of await toggleWrites.list()) {
    let applied = true;
    await forEachBounded(write.scope === GLOBAL_WRITE_SCOPE ? tenants : [write.scope], REPLAY_TOGGLE_WRITE_PARALLELISM, async (tenant) => {
      try { await applyToggleWrites(tenant, [write]); }
      catch (err) {
        applied = false;
        log.warn('replay_toggle_write_apply_failed', { tenantId: tenant, error: err instanceof Error ? err.message : String(err) });
      }
    });
    if (applied && nowMs - Date.parse(write.at) >= REPLAY_SETTLE_AFTER_MS) await toggleWrites.delete(`${write.scope}:${write.writeId}`).catch(() => false);
  }
}

/** An erased row is an opaque identity fence against a late write re-creating
 *  the recording. No write can arrive after the session limit plus the settle
 *  window, so a fence older than a day is dropped. A fence from before
 *  `erasedAt` existed is stamped first and dropped a day later. */
async function pruneErasedFences(fences: readonly ErasedRecording[], nowMs: number): Promise<void> {
  const before = new Date(nowMs - DAY_MS).toISOString();
  for (const fence of fences) {
    if (!fence.privacy.erasedAt) {
      await sessions.compareAndSwap(fence, { ...fence, privacy: { state: 'erased', erasedAt: new Date(nowMs).toISOString() } }).catch(() => false);
    } else if (fence.privacy.erasedAt < before) {
      await sessions.delete(keyOf(fence)).catch(() => false);
    }
  }
}

/** P2.3: a daily admission counter is only read on its own UTC day. Keep two
 *  days for clock skew between instances, then drop it (counts only, no PII). */
async function pruneAdmissionCounters(tenantId: string, nowMs: number): Promise<void> {
  const keepFrom = new Date(nowMs - 2 * DAY_MS).toISOString().slice(0, 10);
  for (const counter of await admissions.listForTenant(tenantId)) {
    if (counter.tenantId === tenantId && counter.day < keepFrom) await admissions.delete(`${counter.tenantId}:${counter.orgId}:${counter.day}`);
  }
}

/** A pointer whose recording is gone (erased, expired, or a first chunk that
 *  never reserved) is dropped once no write can still land for it. */
async function prunePointers(tenantId: string, rows: readonly StoredRecording[], nowMs: number): Promise<void> {
  const live = new Set(rows.filter(hasRecording).map((r) => `${r.orgId}\u0000${r.sessionId}`));
  const before = new Date(nowMs - REPLAY_MAX_SESSION_MS - REPLAY_SETTLE_AFTER_MS).toISOString();
  for (const pointer of await subjectPointers.listForTenantIndexed(tenantId)) {
    if (pointer.at < before && !live.has(`${pointer.orgId}\u0000${pointer.sessionId}`)) await subjectPointers.delete(pointerId(pointer)).catch(() => false);
  }
}

/** P2 review #2 migration: recordings written before the pointers and the
 *  enablement-row-per-tenant existed get both, once (a sentinel guards it). The
 *  only full list of the recordings, and it runs at most once per deployment's
 *  store. P2 was never deployed with recordings, so in practice it finds none;
 *  it exists so a dev or staging store with older rows stays erasable. */
const replayMeta = new DurableCollection<{ id: string; at: string }>('analytics:replay-meta', (m) => m.id);
const BACKFILL_SENTINEL = 'p2-review-pointers';
async function backfillReplayIndexes(): Promise<void> {
  if (await replayMeta.get(BACKFILL_SENTINEL)) return;
  for (const row of await sessions.list()) {
    if (!hasRecording(row)) continue;
    await enablements.putIfAbsent({ tenantId: row.tenantId, epoch: ENABLEMENT_INITIAL, disabled: false });
    await writeSubjectPointers(row);
  }
  await replayMeta.put({ id: BACKFILL_SENTINEL, at: new Date().toISOString() });
}

/** P2.5: a live recording's stale receipts hold session capacity (and the 32
 * pending cap) until settled. Bounded per sweep; a failure is logged and retried. */
async function settleLiveRecordings(rows: readonly Recording[], nowMs: number): Promise<void> {
  const stale = rows.filter((r) => pendingWrites(r).length > 0).slice(0, REPLAY_RECONCILE_MAX_PER_SWEEP);
  for (const row of stale) {
    try { await settleStaleWrites(row, nowMs); }
    catch (err) {
      log.warn('replay_settle_failed', { tenantId: row.tenantId, orgId: row.orgId, sessionId: row.sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function deleteRows(rows: readonly Recording[], event: string): Promise<PurgeOutcome> {
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    try { await deleteReplaySession(row); deleted += 1; }
    catch (err) {
      failed += 1;
      log.error(event, { tenantId: row.tenantId, orgId: row.orgId, sessionId: row.sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { deleted, failed };
}

/** Test-only: restart the reconciliation window at the first row. */
export function __resetReplayReconcileCursorForTests(): void { reconcileCursor = 0; }
registerDefaultWindowSweep({ feature: 'analytics-replay', sweep: sweepExpiredReplays });

// P2.5 — a write to either replay toggle fences at once (a new epoch on an
// observed OFF); the sweep deletes. The sweep's own observation is the backstop
// for a missed or failed notification.
// D1 — the banner asks about recording only where this org can record: replay on,
// storage configured, consent management on, and the org attested eligible.
registerVisitorChoiceProvider('analytics.replay', async (tenantId, orgId) => {
  if (!orgId || !await isReplayOrgEligible(tenantId, orgId)) return false;
  return (await observeReplayEnablement(tenantId)).state === 'on';
});

/** P2 review #1: apply THIS write (its written rows, not a re-read of live
 *  state) to the tenants it can affect: the written tenant, or every tenant with
 *  an enablement row for a global write, a bounded number at a time. A listener
 *  that runs late, fails or never runs is covered by the pending marker. */
export const REPLAY_TOGGLE_WRITE_PARALLELISM = 8;
export async function onReplayToggleWrite(write: ToggleWrite): Promise<void> {
  const rows = replayRows(write);
  if (!rows) return;
  const tenants = write.tenantId ? [write.tenantId] : (await enablements.list()).map((e) => e.tenantId);
  const at = new Date().toISOString(); // the marker's own time is at most this old: only pruning reads it
  await forEachBounded(tenants, REPLAY_TOGGLE_WRITE_PARALLELISM, (tenant) => applyToggleWrites(tenant, [{ writeId: write.writeId, rows, at }]));
}
registerToggleWriteIntent('analytics-replay', recordReplayToggleIntent);
registerToggleWriteListener('analytics-replay', onReplayToggleWrite);

// ADR 0284 — tenant teardown: the generic walk deletes the index rows, but the
// chunks live in blob, outside it. Runs FIRST (pre-hook), while the rows that
// name the chunks still exist. Failures propagate.
registerTenantPurgeHook('analytics-replay-blobs', async (tenantId) => {
  const rows = await erasureRows(tenantId);
  for (const row of rows) await deleteReplaySession(row);
  return rows.length;
});

/** Test-only: clear the index (blobs are per-process in the memory backend). */
export async function __resetReplayStoreForTests(): Promise<void> { await sessions.__clear(); }
