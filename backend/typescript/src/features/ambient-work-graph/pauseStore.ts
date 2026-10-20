/**
 * ADR 0930 D7/A1/A2 — the per-person suppression row: a pause the person set, or the
 * tombstone their erasure left.
 *
 * Run records are exempt from erasure (ADR 0464 §4), so the runs that formed an erased
 * person's patterns are still there. Deleting their suggestions alone would last until
 * the next sweep. This row is what makes the deletion last: every sweep and every read
 * route honours it. A row exists only while suppressed — absence means "not paused".
 *
 * Keyed `(tenant, owner key)`, the key the runs are mined under (`ownership.ts`), so the
 * route that sets it and the daemon that honours it cannot disagree.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';

export type SuppressionReason = 'paused' | 'erased';

export interface WorkGraphSuppression {
  id: string; // `${tenantId}:${ownerPrincipal}`
  tenantId: string;
  ownerPrincipal: string;
  reason: SuppressionReason;
  updatedAt: string;
}

const rows = new DurableCollection<WorkGraphSuppression>('ambient-work-graph:pause', (r) => r.id, undefined, (r) => r.tenantId);

const idOf = (tenantId: string, ownerKey: string): string => `${tenantId}:${ownerKey}`;

export async function getSuppression(tenantId: string, ownerKey: string): Promise<WorkGraphSuppression | null> {
  return rows.get(idOf(tenantId, ownerKey));
}

export async function isSuppressed(tenantId: string, ownerKey: string): Promise<boolean> {
  return (await getSuppression(tenantId, ownerKey)) !== null;
}

/** Every suppressed owner key in a tenant — the daemon reads this ONCE per pass (A9). */
export async function suppressedOwnerKeys(tenantId: string): Promise<Set<string>> {
  return new Set((await rows.listForTenantIndexed(tenantId)).map((r) => r.ownerPrincipal));
}

/** Suppress an owner. An erasure tombstone is never downgraded to a pause: the write is a
 *  compare-and-swap on the row it read (grade-code AWG2CD-8). */
export async function setSuppression(tenantId: string, ownerKey: string, reason: SuppressionReason): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await getSuppression(tenantId, ownerKey);
    if (existing && (existing.reason === reason || existing.reason === 'erased')) return;
    const next = { id: idOf(tenantId, ownerKey), tenantId, ownerPrincipal: ownerKey, reason, updatedAt: new Date().toISOString() };
    if (await rows.compareAndSwap(existing, next)) return;
  }
  throw new Error('work-graph suppression write lost the CAS race 5 times');
}

/** Lift a suppression — the person's own explicit act (`PUT paused:false`). */
export async function clearSuppression(tenantId: string, ownerKey: string): Promise<void> {
  await rows.delete(idOf(tenantId, ownerKey));
}

