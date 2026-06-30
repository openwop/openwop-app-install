/**
 * Knowledge-sync client (ADR 0107) — host-extension, non-normative. Wraps
 * /v1/host/openwop-app/knowledge-sync/*. The backend 404s every route when the
 * `knowledge-sync` toggle is off, so the panel self-hides on a failed list.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const BASE = `${config.baseUrl}/v1/host/openwop-app/knowledge-sync`;

export type SyncCadence = '15m' | 'hourly' | 'daily';
export type SyncStatus = 'active' | 'paused' | 'error';

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
}

export interface SyncRunResult {
  ingested: number;
  pruned: number;
  unchanged: number;
  failed: number;
  errors: string[];
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `request failed (${res.status})`);
  }
  return res.json();
}

/** List the org's sync sources. Rejects (404) when the feature is off — the panel
 *  treats that as "render nothing". */
export async function listSyncSources(orgId: string): Promise<SyncSource[]> {
  const res = await fetch(`${BASE}?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() }));
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
