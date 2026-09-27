/**
 * Knowledge-sync client (ADR 0107) — host-extension, non-normative. Wraps
 * /host/openwop-app/knowledge-sync/*. The backend 404s every route when the
 * `knowledge-sync` toggle is off, so the panel self-hides on a failed list.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const BASE = `${config.baseUrl}/host/openwop-app/knowledge-sync`;

export type SyncCadence = '15m' | 'hourly' | 'daily';
export type SyncStatus = 'active' | 'paused' | 'error';

/** ADR 0605 Tier 6 (`KSU-3`) — WHY a source is paused. A revoked credential needs
 *  "reconnect your account", not "un-pause"; absent ⇒ the user paused it.
 *
 *  ADR 0605 R2 (`KSC-21`) adds `creator-erased`: a DSAR erased the member whose
 *  identity every pass acts as, so the backend paused the source and tombstoned
 *  its `createdBy`. The panel deliberately does NOT branch on it the way it
 *  branches on `connection-revoked`, and the reason is that the two states already
 *  render differently: this one always carries a `lastError`, which the panel
 *  renders as a focusable warning `<Notice>` naming the exit ("add the folder again
 *  with your own connected account"), whereas a plain `user` pause carries none.
 *  A dedicated chip + four locales is a real improvement and is filed rather than
 *  smuggled in — the type is widened here so it stops claiming two values when the
 *  wire has three. */
export type PausedReason = 'user' | 'connection-revoked' | 'creator-erased';

/** ADR 0605 Tier 6 (`KSU-1`) — what the last pass DID, persisted by the backend so
 *  a SCHEDULED run can be reported at all. `pruned` is the deletion count. */
export interface SyncRunSummary {
  at: string;
  ingested: number;
  pruned: number;
  unchanged: number;
  failed: number;
  skippedMedia: number;
  /** Set when the provider listing could not be proved complete, in which case
   *  `pruned` is 0 BY REFUSAL rather than because nothing was deleted. */
  listingIncomplete?: string;
}

export interface SyncSource {
  id: string;
  orgId: string;
  connectionId: string;
  provider: string;
  externalFolderId: string;
  collectionId: string;
  cadence: SyncCadence;
  /** Absent ⇒ media (images/audio) included; false ⇒ opted out (ADR 0108 OQ-3). */
  includeMedia?: boolean;
  status: SyncStatus;
  lastSyncedAt?: string;
  lastError?: string;
  pausedReason?: PausedReason;
  lastRun?: SyncRunSummary;
}

export interface SyncRunResult {
  ingested: number;
  pruned: number;
  unchanged: number;
  failed: number;
  /** ADR 0605 Tier 6 (`KSU-8`) — was DROPPED at this type while the backend computed
   *  and logged it, so a media-off source over a folder of 40 images toasted
   *  "0 updated, 0 removed, 0 failed": a total no-op that read as a clean full sync. */
  skippedMedia: number;
  /** ADR 0605 Tier 1 — the folder could not be fully read, so NOTHING was pruned. */
  listingIncomplete?: string;
  errors: string[];
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `request failed (${res.status})`);
  }
  return res.json();
}

/**
 * List the org's sync sources. Returns **`null`** for exactly one condition — a
 * 404, meaning the feature is off for this tenant — and **throws** on everything
 * else.
 *
 * This used to reject for 404 too, so the panel could not tell "feature off" from
 * "server unreachable" and swallowed both into `available = false`, i.e. rendering
 * nothing. Its comment claimed a distinction ("404 ⇒ feature off") that the client
 * never actually made. Same `null`-means-one-thing contract as
 * `profile-memory/memoryExtractionClient.getExtractionGrant`, which is the
 * established shape for this in the repo.
 */
export async function listSyncSources(orgId: string): Promise<SyncSource[] | null> {
  const res = await fetch(`${BASE}?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() }));
  if (res.status === 404) return null;
  return ((await jsonOrThrow(res)) as { sources: SyncSource[] }).sources;
}

export async function createSyncSource(input: {
  orgId: string; connectionId: string; provider: string; externalFolderId: string; collectionId: string; cadence: SyncCadence; includeMedia?: boolean;
}): Promise<SyncSource> {
  const res = await fetch(BASE, fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(input) }));
  return ((await jsonOrThrow(res)) as { source: SyncSource }).source;
}

export async function deleteSyncSource(id: string): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  await jsonOrThrow(res);
}

export async function setSyncPaused(id: string, paused: boolean): Promise<SyncSource> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/${paused ? 'pause' : 'resume'}`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return ((await jsonOrThrow(res)) as { source: SyncSource }).source;
}

export async function setSyncIncludeMedia(id: string, include: boolean): Promise<SyncSource> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, fetchOpts({ method: 'PATCH', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ includeMedia: include }) }));
  return ((await jsonOrThrow(res)) as { source: SyncSource }).source;
}

export async function syncNow(id: string): Promise<{ result: SyncRunResult; source: SyncSource }> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/sync`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return (await jsonOrThrow(res)) as { result: SyncRunResult; source: SyncSource };
}

export interface BrowseFolder { id: string; name: string }

/** List the subfolders under `folderId` (default the drive root) for the picker.
 *  Read-only; scoped to the connection. SharePoint browsing isn't supported (raw id). */
export async function browseFolders(orgId: string, connectionId: string, folderId?: string): Promise<BrowseFolder[]> {
  const q = new URLSearchParams({ orgId, connectionId, ...(folderId ? { folderId } : {}) });
  const res = await fetch(`${BASE}/browse?${q.toString()}`, fetchOpts({ headers: authedHeaders() }));
  return ((await jsonOrThrow(res)) as { folders: BrowseFolder[] }).folders;
}
