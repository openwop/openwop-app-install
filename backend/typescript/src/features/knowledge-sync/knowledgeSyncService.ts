/**
 * Knowledge-sync feature (ADR 0107) — the CONFIG layer: a `SyncSource` binds an
 * external-drive folder (via a Connection) to a target KB collection, and per-file
 * `SyncFileState` is the diff cursor the `knowledge-sync.run` workflow (Phase 3)
 * reads/writes. This module owns the durable stores + CRUD; it composes existing
 * owners (Connections, KB) and creates no parallel infra (the no-parallel rule).
 *
 * @see docs/adr/0107-knowledge-sync-sources.md
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';

/** Sync providers wired: Google Drive, OneDrive (`microsoft-graph`), and SharePoint
 *  (`microsoft-sharepoint` — same Graph connection, a document-library drive). */
export const SYNC_PROVIDERS = ['google', 'microsoft-graph', 'microsoft-sharepoint', 'dropbox', 'box'] as const;
export type SyncProvider = (typeof SYNC_PROVIDERS)[number];

/** Allowed sync cadences (mapped to the scheduler in Phase 3). */
export const SYNC_CADENCES = ['15m', 'hourly', 'daily'] as const;
export type SyncCadence = (typeof SYNC_CADENCES)[number];

export type SyncStatus = 'active' | 'paused' | 'error';

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
  lastSyncedAt?: string;
  lastError?: string;
  /** The most recent `knowledge-sync.run` (Phase 3). */
  runId?: string;
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
    status: 'active',
    createdAt: now, updatedAt: now,
  };
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
  opts: { lastError?: string; lastSyncedAt?: string } = {},
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
  await sources.put(next);
  return next;
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
export async function deleteSyncSource(tenantId: string, id: string): Promise<boolean> {
  const s = await getSyncSource(tenantId, id);
  if (!s) return false;
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
