/**
 * ADR 0462 Phase 3 — the wearable STREAM liveness clock (unblocks the ADR 0460
 * source-5 that was deferred for want of an honest staleness signal).
 *
 * A durable `lastReadingAt` per (tenant, subject), stamped by `ingestWearableMetric`
 * whenever a reading arrives (manual OR webhook). A "stale stream" is one that WAS
 * reporting and went quiet — the exception source additionally joins live consent +
 * an active enrollment (see `exceptionSources.ts`) so a completed enrollment or a
 * never-reporting device is NOT a false positive (the exact reason ADR 0460 deferred
 * this). Separate file to avoid the `integrationService` ↔ this import cycle.
 *
 * Privacy: opaque subject only (ADR 0426); purge-safe (`tenantOf`); on the erasure seam.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';

interface WearableLiveness {
  tenantId: string;
  ownerSubject: string;
  lastReadingAt: string;
}

const liveness = new DurableCollection<WearableLiveness>(
  'kicktodo-wearable-liveness',
  (l) => `${l.tenantId}::${l.ownerSubject}`,
  undefined,
  (l) => l.tenantId, // KTD-1 purge-safe
);

/** Stamp a subject's stream as alive NOW — called on every ingested reading. */
export async function recordWearableReading(tenantId: string, ownerSubject: string): Promise<void> {
  if (!tenantId || !ownerSubject) return;
  await liveness.put({ tenantId, ownerSubject, lastReadingAt: new Date().toISOString() });
}

export interface StaleStream { ownerSubject: string; lastReadingAt: string }

/** Streams whose last reading is older than `staleMs`. A stream that has NEVER
 *  reported has no row and is deliberately absent (not-yet-reporting ≠ went-quiet). */
export async function listStaleWearableStreams(tenantId: string, staleMs: number): Promise<StaleStream[]> {
  if (!tenantId) return [];
  const cutoff = Date.now() - staleMs;
  return (await liveness.listForTenantIndexed(tenantId))
    .filter((l) => new Date(l.lastReadingAt).getTime() < cutoff)
    .map((l) => ({ ownerSubject: l.ownerSubject, lastReadingAt: l.lastReadingAt }));
}

/** ADR 0381 erasure hop. */
export async function eraseWearableLivenessForSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  await liveness.delete(`${tenantId}::${subjectKey}`);
}
registerSubjectEraser(eraseWearableLivenessForSubject);

/** Test-only: seed a liveness row with a controlled timestamp (to simulate a stream
 *  that reported then went quiet). */
export async function __putWearableLivenessForTest(tenantId: string, ownerSubject: string, lastReadingAt: string): Promise<void> {
  await liveness.put({ tenantId, ownerSubject, lastReadingAt });
}

/** Test-only reset. */
export async function __resetWearableLiveness(): Promise<void> {
  await liveness.__clear();
}
