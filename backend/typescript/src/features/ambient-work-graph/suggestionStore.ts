/**
 * ADR 0137 Phase 2 + ADR 0930 — the workflow-suggestion store.
 *
 * Keyed by the deterministic suggestionId so a re-sweep UPSERTS the same row. Rows are
 * PERSONAL (ADR 0930 D1): each carries the `ownerPrincipal` its runs were mined under,
 * and every read/decision below takes the reader's owner key. The load-bearing
 * invariants:
 *
 *   - a re-sweep refreshes count/lastSeenAt/exampleRunIds but never changes a decision.
 *     The merge happens INSIDE a compare-and-swap on the row it read (D4), so a sweep
 *     that raced a dismiss loses and re-reads rather than writing `suggested` back;
 *   - a CAS never merges over a row that is not the same (tenant, owner, signature) —
 *     an id collision is refused, not inherited (A7);
 *   - decisions follow one transition table (A8), checked on the row the CAS swaps.
 *
 * @see docs/adr/0137-ambient-work-graph.md
 * @see docs/adr/0930-ambient-work-graph-per-owner.md
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import type { SuggestionStatus, WorkflowSuggestion } from './types.js';

const log = createLogger('ambient-work-graph');
const CAS_ATTEMPTS = 5;

// CGOV-7: the 4th arg arms the tenant secondary index (GOV-1 / FEAT-1) so a tenant read is
// a BOUNDED scan of one tenant's slice instead of a full cross-tenant `list()`.
const store = new DurableCollection<WorkflowSuggestion>('ambient-work-graph:suggestions', (s) => s.suggestionId, undefined, (s) => s.tenantId);

/** Every row in a tenant, legacy ones included — the sweep's and the eraser's view. */
export async function listSuggestions(tenantId: string): Promise<WorkflowSuggestion[]> {
  return store.listForTenantIndexed(tenantId);
}

/** One owner's rows. A legacy row (no `ownerPrincipal`) belongs to nobody (D6). */
export async function listOwnerSuggestions(tenantId: string, ownerKey: string): Promise<WorkflowSuggestion[]> {
  return (await listSuggestions(tenantId)).filter((s) => s.ownerPrincipal === ownerKey);
}

/** A row by id, only if it is this owner's in this tenant — otherwise null (the IDOR 404). */
export async function getOwnedSuggestion(suggestionId: string, tenantId: string, ownerKey: string): Promise<WorkflowSuggestion | null> {
  const s = await store.get(suggestionId);
  return s && s.tenantId === tenantId && s.ownerPrincipal === ownerKey ? s : null;
}

function sameIdentity(a: WorkflowSuggestion, b: WorkflowSuggestion): boolean {
  return a.tenantId === b.tenantId && a.ownerPrincipal === b.ownerPrincipal && a.signature === b.signature;
}

/** Upsert a freshly-detected suggestion, PRESERVING a prior decision: a dismissed or
 *  accepted row keeps its status (only its evidence is refreshed), and firstSeenAt keeps
 *  the earliest sighting. Returns null when the id is held by a different row (A7). */
export async function upsertSuggestion(detected: WorkflowSuggestion): Promise<WorkflowSuggestion | null> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const existing = await store.get(detected.suggestionId);
    if (existing && !sameIdentity(existing, detected)) {
      log.warn('work_graph_suggestion_id_collision', { suggestionId: detected.suggestionId });
      return null;
    }
    const merged: WorkflowSuggestion = existing
      ? {
        ...detected,
        status: existing.status,
        firstSeenAt: existing.firstSeenAt < detected.firstSeenAt ? existing.firstSeenAt : detected.firstSeenAt,
      }
      : detected;
    if (await store.compareAndSwap(existing, merged)) return merged;
  }
  throw new Error('work-graph suggestion upsert lost the CAS race 5 times');
}

/** ADR 0930 A8 — the legal decisions. `null` = refused (409). */
function nextStatus(from: SuggestionStatus, to: SuggestionStatus): SuggestionStatus | null {
  if (from === to) return to; // idempotent
  if (from === 'suggested') return to;
  if (from === 'accepted' && to === 'dismissed') return to;
  return null; // dismissed → accepted: the page never shows a dismissed row
}

export type DecisionResult =
  | { ok: true; before: WorkflowSuggestion; after: WorkflowSuggestion }
  | { ok: false; reason: 'not_found' | 'conflict' };

/** The owner's decision on their own row, compare-and-swapped on that row. */
export async function decideSuggestion(suggestionId: string, tenantId: string, ownerKey: string, to: SuggestionStatus): Promise<DecisionResult> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const existing = await getOwnedSuggestion(suggestionId, tenantId, ownerKey);
    if (!existing) return { ok: false, reason: 'not_found' };
    const status = nextStatus(existing.status, to);
    if (status === null) return { ok: false, reason: 'conflict' };
    if (status === existing.status) return { ok: true, before: existing, after: existing };
    const next = { ...existing, status };
    if (await store.compareAndSwap(existing, next)) return { ok: true, before: existing, after: next };
  }
  throw new Error('work-graph decision lost the CAS race 5 times');
}

/**
 * ADR 0930 D7/A8 — what a pause keeps of one owner's rows. Every non-dismissed row is
 * deleted; a dismissed row is cut down to a signature-only suppression (no evidence, no
 * count, no goal) so unpausing never brings a dismissed pattern back. Returns the rows
 * touched.
 */
export async function forgetOwner(tenantId: string, ownerKey: string, opts: { keepDismissals: boolean }): Promise<number> {
  let touched = 0;
  for (const row of await listOwnerSuggestions(tenantId, ownerKey)) {
    if (opts.keepDismissals && row.status === 'dismissed') {
      const bare: WorkflowSuggestion = {
        suggestionId: row.suggestionId, tenantId, ownerPrincipal: ownerKey, signature: row.signature,
        toolSequence: [], count: 0, exampleRunIds: [], status: 'dismissed',
        firstSeenAt: row.firstSeenAt, lastSeenAt: row.firstSeenAt,
      };
      if (JSON.stringify(bare) !== JSON.stringify(row) && await store.compareAndSwap(row, bare)) touched++;
      continue;
    }
    // AWG2CD-6 — re-read: a dismissal that landed after the list must survive a pause.
    // (A dismiss in the instant between this read and the delete is the stated residue:
    // the store has no compare-and-delete.)
    const current = opts.keepDismissals ? await store.get(row.suggestionId) : row;
    if (opts.keepDismissals && current?.status === 'dismissed') continue;
    if (await store.delete(row.suggestionId)) touched++;
  }
  return touched;
}

/** ADR 0930 D6 — delete a tenant's legacy tenant-wide rows (no owner). Returns the count. */
export async function purgeLegacySuggestions(tenantId: string): Promise<number> {
  let n = 0;
  for (const row of await listSuggestions(tenantId)) {
    if (row.ownerPrincipal === undefined && await store.delete(row.suggestionId)) n++;
  }
  return n;
}
