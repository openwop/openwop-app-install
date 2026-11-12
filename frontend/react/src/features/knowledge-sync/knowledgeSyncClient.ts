/**
 * Knowledge-sync client (ADR 0107) — host-extension, non-normative. Wraps
 * /host/openwop-app/knowledge-sync/*. The backend 404s every route when the
 * `knowledge-sync` toggle is off, so the panel self-hides on a failed list.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { ApiError } from '../../client/requestJson.js';

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
export type PausedReason = 'user' | 'connection-revoked' | 'creator-erased' | 'creator-no-access' | 'removing';

/** ADR 1101 D7 — the CAUSE of the last problem, rendered in the reader's language
 *  (`lastError` is the server's English detail, kept behind a disclosure). Retry
 *  state is not a code: it renders from `status` / `consecutiveFailures`. */
export type SyncErrorCode =
  | 'listing_incomplete' | 'files_failed' | 'connection_revoked' | 'connection_unusable'
  | 'connection_missing' | 'connection_owner_changed' | 'creator_erased' | 'creator_no_access'
  | 'collection_unreadable' | 'removing' | 'sync_failed';

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
  /** ADR 1101 D1 — the pass stopped pruning because the source changed under it. */
  pruneSkipped?: 'changed';
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
  lastErrorCode?: SyncErrorCode;
  lastErrorParams?: Record<string, string | number>;
  pausedReason?: PausedReason;
  lastRun?: SyncRunSummary;
  consecutiveFailures?: number;
  /** ADR 1101 D8 — the folder's name as picked; absent ⇒ show the raw id. */
  folderName?: string;
  /** The member whose connected account every pass acts as. */
  createdBy?: string;
  /** ADR 1101 D5 — how many documents this source synced (what Remove takes with it). */
  syncedDocuments?: number;
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
  /** ADR 1101 D1 — the source changed during the pass, so it stopped pruning. */
  pruneSkipped?: 'changed';
  errors: string[];
}

/** ADR 1101 D7 — a refusal keeps its STATUS and parsed body (`ApiError`, the
 *  `CONNUX-3` shape), so the panel can say "you don't have permission" or "a sync is
 *  already running" in the reader's language instead of toasting server English. */
async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, body, message: body.message || `request failed (${res.status})` });
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
  orgId: string; connectionId: string; provider: string; externalFolderId: string; collectionId: string; cadence: SyncCadence; includeMedia?: boolean; folderName?: string;
}): Promise<SyncSource> {
  const res = await fetch(BASE, fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(input) }));
  return ((await jsonOrThrow(res)) as { source: SyncSource }).source;
}

export interface RemoveResult { deleted: boolean; removing?: boolean; remaining?: number; documentsRemoved: number }

/** ADR 1101 D5 — remove a source AND the documents it synced. The server removes a
 *  bounded batch per request and answers 202 `{ removing, remaining }` while more is
 *  left; this calls again until it is done (bounded, so a server that never finishes
 *  cannot spin the tab), summing what was removed. */
export async function deleteSyncSource(id: string, maxRounds = 20): Promise<RemoveResult> {
  let documentsRemoved = 0;
  for (let round = 0; round < maxRounds; round++) {
    const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
    const out = (await jsonOrThrow(res)) as RemoveResult;
    documentsRemoved += out.documentsRemoved ?? 0;
    if (!out.removing) return { ...out, documentsRemoved };
  }
  return { deleted: false, removing: true, documentsRemoved };
}

/** ADR 1101 D5b — switch a stopped source to one of the caller's own connections,
 *  keeping the source and every document it synced. */
export async function rebindSyncSource(id: string, connectionId: string): Promise<SyncSource> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, fetchOpts({ method: 'PATCH', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ connectionId }) }));
  return ((await jsonOrThrow(res)) as { source: SyncSource }).source;
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
