/**
 * CRM COMPANY merge-event audit (GEN-7) — the company-side sibling of the ADR 0264
 * contact merge-event (`crmMergeEventsService.ts`). A durable snapshot of what each
 * company merge did: which survivor scalar fields it filled, which tags + customField
 * keys it absorbed, and the source's deal/task/activity refs captured PRE-merge. It
 * makes company merges auditable and is the substrate `unmergeCompanies` replays.
 *
 * A SEPARATE collection (not a generalized `MergeEvent`): the contact event has
 * required contact-shaped fields (identifiers, `ContactRefIds`); companies carry
 * tags/customFields/no-identifiers. This is the sibling-entity pattern (like
 * `mergeCompanies` mirrors `mergeContacts`), not a second system. Capture is
 * best-effort — a snapshot failure must never fail the already-committed merge.
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import type { CompanyRefIds } from './entities/activities.js';

export interface CompanyMergeEvent {
  mergeEventId: string;
  tenantId: string;
  orgId: string;
  survivorId: string;
  sourceId: string;
  /** survivor scalar fields the merge filled (were blank) → the value taken from source (e.g. domain, industry). */
  filledFields: Record<string, string>;
  /** tags added to the survivor by the merge (present on source, absent on survivor). */
  absorbedTags: string[];
  /** customField key → the value the merge wrote onto the survivor (keys the survivor gained from source). */
  absorbedCustomFields: Record<string, string | number | boolean>;
  /** the source's deal/task/activity ids captured PRE-merge — the exact refs an unmerge restores. */
  refIds: CompanyRefIds;
  actor: string;
  mergedAt: string;
  /** set once an unmerge has consumed this event (idempotency + audit trail). */
  unmergedAt?: string;
}

// `tenantOf` for the tenant-scoped list read (matches the contact sibling) + GEN-6 teardown reach.
const store = new DurableCollection<CompanyMergeEvent>('crm:company-merge-event', (e) => e.mergeEventId, undefined, (e) => e.tenantId);

export async function recordCompanyMergeEvent(input: {
  tenantId: string; orgId: string; survivorId: string; sourceId: string;
  filledFields: Record<string, string>; absorbedTags: string[];
  absorbedCustomFields: Record<string, string | number | boolean>; refIds: CompanyRefIds; actor: string;
}): Promise<void> {
  try {
    await store.put({
      mergeEventId: `cmerge:${randomUUID()}`,
      tenantId: input.tenantId,
      orgId: input.orgId,
      survivorId: input.survivorId,
      sourceId: input.sourceId,
      filledFields: input.filledFields,
      absorbedTags: input.absorbedTags,
      absorbedCustomFields: input.absorbedCustomFields,
      refIds: input.refIds,
      actor: input.actor,
      mergedAt: new Date().toISOString(),
    });
  } catch {
    /* best-effort — the merge already committed; a lost audit row must not fail it */
  }
}

/** Company merge events for a tenant (newest first) — the auditability read. */
export async function listCompanyMergeEvents(tenantId: string, limit = 100): Promise<CompanyMergeEvent[]> {
  return (await store.listForTenantIndexed(tenantId)).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)).slice(0, limit);
}

export async function getCompanyMergeEvent(tenantId: string, mergeEventId: string): Promise<CompanyMergeEvent | null> {
  const ev = await store.get(mergeEventId);
  return ev && ev.tenantId === tenantId ? ev : null;
}

/** Stamp an event consumed (idempotency: a second unmerge no-ops on `unmergedAt`). */
export async function consumeCompanyMergeEvent(tenantId: string, mergeEventId: string): Promise<void> {
  const ev = await store.get(mergeEventId);
  if (ev && ev.tenantId === tenantId && !ev.unmergedAt) {
    await store.put({ ...ev, unmergedAt: new Date().toISOString() });
  }
}
