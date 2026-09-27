/**
 * CRM merge-event audit (ADR 0264 / CDP-B) — a durable snapshot of what each
 * contact merge did: which survivor fields it filled (and their new values), which
 * identifiers it absorbed, and the source it tombstoned. Purely additive + read-only
 * for consumers — it makes merges auditable/inspectable and is the substrate a
 * future `unmergeContacts` replays. Capturing it is best-effort: a snapshot failure
 * must never fail the (already-committed) merge.
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import type { ContactIdentifier } from './contactIdentityService.js';
import type { ContactRefIds } from './entities/activities.js';

export interface MergeEvent {
  mergeEventId: string;
  tenantId: string;
  survivorId: string;
  sourceId: string;
  /** survivor fields the merge filled (were blank) → the value taken from source. */
  filledFields: Record<string, string>;
  /** identifiers absorbed onto the survivor (incl. the source's email as an identifier). */
  absorbedIdentifiers: ContactIdentifier[];
  /** the source's deal/task/activity ids captured PRE-merge — the exact refs an
   *  unmerge restores to the source (ADR 0264). */
  refIds: ContactRefIds;
  actor: string;
  mergedAt: string;
  /** set once an unmerge has consumed this event (idempotency + audit trail). */
  unmergedAt?: string;
}

const store = new DurableCollection<MergeEvent>('crm:merge-event', (e) => e.mergeEventId, undefined, (e) => e.tenantId);

export async function recordMergeEvent(input: {
  tenantId: string; survivorId: string; sourceId: string;
  filledFields: Record<string, string>; absorbedIdentifiers: ContactIdentifier[]; refIds: ContactRefIds; actor: string;
}): Promise<void> {
  try {
    await store.put({
      mergeEventId: `merge:${randomUUID()}`,
      tenantId: input.tenantId,
      survivorId: input.survivorId,
      sourceId: input.sourceId,
      filledFields: input.filledFields,
      absorbedIdentifiers: input.absorbedIdentifiers,
      refIds: input.refIds,
      actor: input.actor,
      mergedAt: new Date().toISOString(),
    });
  } catch {
    /* best-effort — the merge already committed; a lost audit row must not fail it */
  }
}

/** Merge events for a tenant (newest first) — the auditability read. */
export async function listMergeEvents(tenantId: string, limit = 100): Promise<MergeEvent[]> {
  return (await store.listForTenantIndexed(tenantId)).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)).slice(0, limit);
}

export async function getMergeEvent(tenantId: string, mergeEventId: string): Promise<MergeEvent | null> {
  const ev = await store.get(mergeEventId);
  return ev && ev.tenantId === tenantId ? ev : null;
}

/** Mark a merge event consumed by an unmerge (idempotency: a second unmerge no-ops). */
export async function consumeMergeEvent(tenantId: string, mergeEventId: string): Promise<void> {
  const ev = await getMergeEvent(tenantId, mergeEventId);
  if (ev && !ev.unmergedAt) await store.put({ ...ev, unmergedAt: new Date().toISOString() });
}
