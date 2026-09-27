/**
 * Tenant LEGAL HOLD (litigation hold) — the store, extracted (CONS-4 / WF-CONS-1).
 *
 * WHY IT MOVED. The store used to live inside `runRetentionSweeper.ts`, which is
 * the RUN-retention lane. That placement is why the hold only ever reached runs:
 * the other destructive lanes (`subjectErasure`, `retentionPurger`, `kvAgeOut`)
 * could not import it without an import cycle, so they simply never asked. A
 * hold placed by an operator under litigation therefore read as tenant-wide and
 * was not — `DELETE …/consent/orgs/:orgId/subjects/:subjectKey` deleted
 * regardless, and `deleteSubject` even wrote an audit row asserting the deletion
 * was PERMITTED, from a code path that had no notion holds exist.
 *
 * GDPR Art. 17(3)(b)/(e) makes a hold OVERRIDE erasure — a legal claim or a
 * legal obligation to retain beats the right to be forgotten — so the failure
 * ran in the unrecoverable direction (spoliation). This module is a leaf: it
 * imports only the persistence seam, so every lane can consult it.
 *
 * `runRetentionSweeper.ts` re-exports the whole surface, so existing importers
 * (`routes/admin.ts`, `workflowComposeTool.ts`, the sweep tests) are unchanged.
 */

import { DurableCollection } from './hostExtPersistence.js';
import type { Storage } from '../storage/storage.js';

/** The raw kv prefix `DurableCollection('retention-hold')` writes under. Needed
 *  by `listHeldTenantsFrom` — the KV age-out sweep is handed an EXPLICIT
 *  `Storage` and must not read the ambient host-ext handle, which may be a
 *  different (or uninitialised) one. Pinned against the collection's own key
 *  shape by `legal-hold-gates-erasure.test.ts` so it cannot drift silently. */
export const RETENTION_HOLD_KV_PREFIX = 'hostext:retention-hold:';

/** Tenant-level legal hold rows (superadmin-managed). */
export interface RetentionHoldRecord {
  tenantId: string;
  reason: string;
  createdAt: string;
}

const holds = new DurableCollection<RetentionHoldRecord>(
  'retention-hold',
  (r) => r.tenantId,
  undefined,
  (r) => r.tenantId,
);

export async function setRetentionHold(tenantId: string, reason: string): Promise<void> {
  await holds.put({ tenantId, reason, createdAt: new Date().toISOString() });
}

export async function clearRetentionHold(tenantId: string): Promise<boolean> {
  return holds.delete(tenantId);
}

export async function listRetentionHolds(): Promise<RetentionHoldRecord[]> {
  return [...(await holds.list())];
}

export async function getRetentionHold(tenantId: string): Promise<RetentionHoldRecord | null> {
  return (await holds.get(tenantId)) ?? null;
}

/**
 * The held tenant ids, read from an EXPLICIT `Storage` rather than the ambient
 * host-ext handle.
 *
 * Why it exists: `__runKvAgeOutOnce(storage)` is handed its storage by the
 * caller, and the two are not always the same object — the seam's own tests
 * pass a bare `openStorage('memory://')` with no `initHostExtPersistence`, and
 * routing the hold read through the collection there made `requireStorage()`
 * throw. A hold read that can throw is worse than useless on this lane: it
 * either fails OPEN (sweeping under a hold — the defect) or fails CLOSED
 * (freezing all size hygiene on a storage-wiring detail). Reading the same
 * storage the sweep itself uses removes the divergence instead of choosing
 * which way to be wrong.
 */
export async function listHeldTenantsFrom(storage: Storage): Promise<Set<string>> {
  const out = new Set<string>();
  for (const { key } of await storage.kvList(RETENTION_HOLD_KV_PREFIX)) {
    // The collection's id IS the tenantId (`(r) => r.tenantId`), so the tenant
    // comes from the KEY, never from parsing the row. A corrupt row body would
    // otherwise silently un-protect a held tenant — fail-open, in the guard.
    const tenantId = key.slice(RETENTION_HOLD_KV_PREFIX.length);
    if (tenantId) out.add(tenantId);
  }
  return out;
}

/**
 * Thrown by a destructive lane that refused because the tenant is under legal
 * hold. A TYPED refusal, not a silent skip: the caller must be able to tell
 * "nothing was deleted because a hold forbids it" from "nothing was deleted
 * because there was nothing there", and the operator must be given the exit —
 * lift the hold, then retry.
 */
export class RetentionHoldError extends Error {
  readonly tenantId: string;
  readonly reason: string;
  readonly createdAt: string;
  constructor(hold: RetentionHoldRecord) {
    super(`Tenant ${hold.tenantId} is under legal hold: ${hold.reason}`);
    this.name = 'RetentionHoldError';
    this.tenantId = hold.tenantId;
    this.reason = hold.reason;
    this.createdAt = hold.createdAt;
  }
}

/** Throw `RetentionHoldError` when `tenantId` is held. The ONE assertion the
 *  destructive lanes call — never a bare boolean check duplicated per lane. */
export async function assertNoRetentionHold(tenantId: string): Promise<void> {
  const hold = await getRetentionHold(tenantId);
  if (hold) throw new RetentionHoldError(hold);
}
