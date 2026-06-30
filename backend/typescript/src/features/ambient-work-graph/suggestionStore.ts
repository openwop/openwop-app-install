/**
 * ADR 0137 Phase 2 — the workflow-suggestion store.
 *
 * Keyed by the deterministic suggestionId so a re-sweep UPSERTS the same row. The
 * load-bearing invariant: upsert PRESERVES a 'dismissed'/'accepted' status — a re-sweep
 * refreshes count/lastSeenAt/exampleRunIds but never resurrects a dismissed suggestion
 * back to 'suggested'. Tenant-scoped (the toggle is bucketUnit:'tenant').
 *
 * @see docs/adr/0137-ambient-work-graph.md
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import type { SuggestionStatus, WorkflowSuggestion } from './types.js';

// CGOV-7: the 4th arg arms the tenant secondary index (GOV-1 / FEAT-1) so listSuggestions
// is a BOUNDED scan of one tenant's slice instead of a full cross-tenant `list()`.
const store = new DurableCollection<WorkflowSuggestion>('ambient-work-graph:suggestions', (s) => s.suggestionId, undefined, (s) => s.tenantId);

export async function listSuggestions(tenantId: string): Promise<WorkflowSuggestion[]> {
  return store.listForTenantIndexed(tenantId);
}

export async function getSuggestion(suggestionId: string): Promise<WorkflowSuggestion | null> {
  return store.get(suggestionId);
}

/** Upsert a freshly-detected suggestion, PRESERVING a prior user decision: a dismissed
 *  or accepted suggestion keeps its status (only its evidence is refreshed); the
 *  firstSeenAt anchor is kept from the earliest sighting. */
export async function upsertSuggestion(detected: WorkflowSuggestion): Promise<WorkflowSuggestion> {
  const existing = await store.get(detected.suggestionId);
  const merged: WorkflowSuggestion = existing
    ? { ...detected, status: existing.status, firstSeenAt: existing.firstSeenAt < detected.firstSeenAt ? existing.firstSeenAt : detected.firstSeenAt }
    : detected;
  await store.put(merged);
  return merged;
}

export async function setSuggestionStatus(suggestionId: string, status: SuggestionStatus): Promise<WorkflowSuggestion | null> {
  const existing = await store.get(suggestionId);
  if (!existing) return null;
  const next = { ...existing, status };
  await store.put(next);
  return next;
}
