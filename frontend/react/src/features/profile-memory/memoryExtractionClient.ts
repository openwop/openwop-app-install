/**
 * Memory auto-extraction consent client (ADR 0120) — drives the caller's OWN
 * opt-in grant at /v1/host/openwop-app/profiles/me/memory-extraction.
 *
 * The grant is the fail-closed gate for the whole feature: extraction only runs
 * for a subject that has explicitly opted in. The extracted facts land as
 * `[auto-extracted]` notes in the SAME store the Personal Memory tab lists
 * (ADR 0041) — there is no separate review surface.
 *
 * A 404 means the feature is unavailable for this tenant; callers treat that as
 * "consent control hidden" (returns null), never as an error.
 *
 * @see docs/adr/0120-chat-memory-auto-extraction.md
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const PATH = `${config.baseUrl}/v1/host/openwop-app/profiles/me/memory-extraction`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

export interface ExtractionGrant { granted: boolean; updatedAt: string | null }

/** Read the caller's consent grant. Returns null when the feature is unavailable (404). */
export async function getExtractionGrant(): Promise<ExtractionGrant | null> {
  const res = await fetch(PATH, fetchOpts({ headers: authedHeaders() }));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getExtractionGrant failed (${res.status})`);
  return (await res.json()) as ExtractionGrant;
}

/** Opt in (true) or out (false). Returns the resulting grant state. */
export async function setExtractionGrant(granted: boolean): Promise<ExtractionGrant> {
  const res = granted
    ? await fetch(PATH, fetchOpts({ method: 'PUT', headers: jsonHeaders() }))
    : await fetch(PATH, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) throw new Error(`setExtractionGrant failed (${res.status})`);
  return granted ? ((await res.json()) as ExtractionGrant) : { granted: false, updatedAt: null };
}
