/**
 * Personal Memory client (ADR 0041) — the human counterpart of the agent
 * knowledge client. Drives /host/openwop-app/profiles/me/memory: list, add,
 * and delete the caller's OWN memories (self-service; the server keys every call
 * on the caller's resolved userId).
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { apiErrorFrom } from '../../client/errorEnvelope.js';
import i18n from '../../i18n/index.js';

export interface MemoryNote {
  id: string;
  content: string;
  contentTrust: 'trusted' | 'untrusted';
  /** ADR 0587 provenance. Absent on rows written before the field existed. */
  source?: 'user' | 'auto-extract';
  createdAt: string;
}

const base = `${config.baseUrl}/host/openwop-app/profiles/me/memory`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

// TWIN-UX-6 — localize at the throw site; prefer the backend's prose, which on
// THIS surface carries the two limits nothing in the UI discloses ("maximum 200
// curated notes", "4000 characters or fewer").
async function asJson<T>(res: Response, fallbackKey: string): Promise<T> {
  if (!res.ok) throw await apiErrorFrom(res, i18n.t(`memory:${fallbackKey}`, { status: res.status }));
  return res.json() as Promise<T>;
}

/**
 * List the caller's own memories AND the MEM-UX-1 recall-only count — ONE
 * request, because the route already returns both in one response.
 *
 * REPLACES a `listMemories()` + `countRecallOnly()` pair that hit the identical
 * URL twice from two separate effects (review finding F5). The route was changed
 * in this same change set to return `{ notes, recallOnlyCount }` together, and
 * then both halves were discarded and re-fetched. Two costs, one of them not
 * about performance at all:
 *   - each extra call re-runs `countRecallOnlyEntries`, a full
 *     `listMemoryEntries` scan, and CLAUDE.md names this fan-out hazard by name
 *     ("batch reads; don't N+1") against a per-IP read budget;
 *   - the two responses can DISAGREE, so the tab could show a disclosure count
 *     computed over a list the user is not looking at.
 *
 * `recallOnlyCount` is `undefined` when the server did not send a number — the
 * caller must then disclose NOTHING rather than assert a zero it never read.
 * Reporting 0 for "unknown" is the exact dishonesty MEM-UX-1 exists to remove.
 */
export async function listMemoriesWithRecall(): Promise<{ notes: MemoryNote[]; recallOnlyCount?: number }> {
  const res = await fetch(base, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ notes: MemoryNote[]; recallOnlyCount?: number }>(res, 'loadError');
  return typeof body.recallOnlyCount === 'number'
    ? { notes: body.notes, recallOnlyCount: body.recallOnlyCount }
    : { notes: body.notes };
}

/** List the caller's own memories (newest first). */
export async function listMemories(): Promise<MemoryNote[]> {
  return (await listMemoriesWithRecall()).notes;
}

/** Add a memory; returns the refreshed list. */
export async function addMemory(content: string): Promise<MemoryNote[]> {
  const res = await fetch(base, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ content }) }));
  return (await asJson<{ notes: MemoryNote[] }>(res, 'addError')).notes;
}

/** Delete a memory by id. */
export async function deleteMemory(noteId: string): Promise<void> {
  const res = await fetch(`${base}/${encodeURIComponent(noteId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw await apiErrorFrom(res, i18n.t('memory:removeError'));
}
