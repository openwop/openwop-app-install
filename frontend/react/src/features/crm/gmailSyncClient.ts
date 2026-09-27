/**
 * Gmail inbox → CRM activity sync client (ADR 0252 P3). Wraps
 * /host/openwop-app/crm/gmail-sync/* — a per-user, per-org opt-in binding a
 * connected `google` connection + a cadence. The backend records ONLY that an
 * email was exchanged with a matched contact (never subject/body/snippet) —
 * see the ADR §1 refs-only posture; this client is a thin fetch wrapper, no
 * PII crosses it either.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const BASE = `${config.baseUrl}/host/openwop-app/crm/gmail-sync`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

export const GMAIL_SYNC_CADENCES = ['15m', 'hourly', 'daily'] as const;
export type GmailSyncCadence = (typeof GMAIL_SYNC_CADENCES)[number];
export type GmailSyncStatus = 'active' | 'paused';

export interface GmailSync {
  syncId: string;
  tenantId: string;
  orgId: string;
  userId: string;
  connectionId: string;
  cadence: GmailSyncCadence;
  jobId: string;
  status: GmailSyncStatus;
  /** ISO-8601 — the messages-`after:` cursor. Absent on a fresh opt-in. */
  cursor?: string;
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listGmailSyncs(orgId: string): Promise<GmailSync[]> {
  const res = await fetch(`${BASE}?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ syncs: GmailSync[] }>(res, 'listGmailSyncs')).syncs;
}

export async function createGmailSync(input: { orgId: string; connectionId: string; cadence: GmailSyncCadence }): Promise<GmailSync> {
  const res = await fetch(BASE, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return (await asJson<{ sync: GmailSync }>(res, 'createGmailSync')).sync;
}

export async function updateGmailSync(syncId: string, patch: { status?: GmailSyncStatus; cadence?: GmailSyncCadence }): Promise<GmailSync> {
  const res = await fetch(`${BASE}/${encodeURIComponent(syncId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return (await asJson<{ sync: GmailSync }>(res, 'updateGmailSync')).sync;
}

export async function deleteGmailSync(syncId: string): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(syncId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) await asJson<unknown>(res, 'deleteGmailSync');
}

/** Kick an immediate run of the sync's workflow. `runId` may be absent if the
 *  host doesn't echo it back, per the ADR 0252 contract (`202 { runId? }`). */
export async function syncGmailNow(syncId: string): Promise<{ runId?: string }> {
  const res = await fetch(`${BASE}/${encodeURIComponent(syncId)}/sync-now`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return asJson<{ runId?: string }>(res, 'syncGmailNow');
}
