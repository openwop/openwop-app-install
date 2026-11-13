/**
 * ADR 1114 (issue 5868) — how a finished request ended, and the backlog sweep.
 *
 * Imported only by the inbox page (a lazy route), so none of this rides the
 * entry bundle; the entry keeps the one-line `metadata.resolution` check in
 * `types.ts#isActionNeeded`.
 */
import { authedHeaders, config, fetchOpts } from '../client/config.js';
import type { Notification } from './types.js';

/** Mirrors the backend `RequestResolutionState`. */
export type RequestResolutionState = 'approved' | 'rejected' | 'changes-requested' | 'timed-out' | 'answered' | 'run-ended';
const RESOLUTION_STATES: ReadonlySet<string> = new Set<RequestResolutionState>(['approved', 'rejected', 'changes-requested', 'timed-out', 'answered', 'run-ended']);

/** `metadata.resolution`, or undefined while the request is open (or the row
 *  predates the retire step). An unknown state reads as open. */
export function requestResolutionOf(n: Pick<Notification, 'metadata'>): { state: RequestResolutionState; at: string } | undefined {
  const r = n.metadata?.resolution as { state?: unknown; at?: unknown } | undefined;
  return r && typeof r.state === 'string' && RESOLUTION_STATES.has(r.state) && typeof r.at === 'string'
    ? { state: r.state as RequestResolutionState, at: r.at }
    : undefined;
}

/** Archive every request whose step is over. The server decides, including rows
 *  from before the retire step; one request. Resolves to the count archived. */
export async function archiveResolvedNotifications(): Promise<number> {
  const path = '/host/openwop-app/notifications:archive-resolved';
  const res = await fetch(`${config.baseUrl}${path}`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return ((await res.json()) as { updated?: number }).updated ?? 0;
}
