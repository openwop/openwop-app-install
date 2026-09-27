/**
 * Per-tenant pack enablement (ADR 0194 Phase 3 / ADR 0022 alt. 4).
 *
 * A sparse DENY store: a row exists ONLY for a pack the tenant has disabled —
 * default is everything-enabled with zero rows. Keyed `${tenantId}:${packName}`
 * so reads are a per-tenant prefix lookup, never a cross-tenant scan.
 *
 * This feature OWNS the store and registers the `host/packVisibility` resolver
 * at module load (the inversion seam) — core consults visibility without
 * importing the feature. Curation gates AUTHORING surfaces only (palette,
 * new-definition registration, AI author); runs/replay never consult it.
 *
 * @see docs/adr/0194-feature-dependency-graph-and-lifecycle.md §Phase 3
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { setDisabledPacksResolver } from '../../host/packVisibility.js';

interface PackDisable {
  /** `${tenantId}:${packName}` — deterministic, idempotent upserts. */
  id: string;
  tenantId: string;
  packName: string;
  disabledAt: string;
  disabledBy: string;
}

// MPL-7 — TENANT-INDEXED so the ADR 0464 subject eraser can enumerate a tenant's
// rows. Reads here already prefix on `${tenantId}:`; the index is what erasure
// and tenant teardown need. Self-healing backfill, no re-key, no migration.
const store = new DurableCollection<PackDisable>('marketplace:pack-disable', (r) => r.id, undefined, (r) => r.tenantId);

const keyOf = (tenantId: string, packName: string): string => `${tenantId}:${packName}`;

/** Pack names this tenant has disabled (empty = everything enabled). */
export async function disabledPacks(tenantId: string): Promise<Set<string>> {
  const rows = await store.listByPrefix(`${tenantId}:`);
  return new Set(rows.map((r) => r.packName));
}

/** Disable (idempotent) — deterministic key, so a retry never duplicates. */
export async function disablePack(tenantId: string, packName: string, by: string): Promise<void> {
  await store.put({
    id: keyOf(tenantId, packName),
    tenantId,
    packName,
    disabledAt: new Date().toISOString(),
    disabledBy: by,
  });
}

/** Re-enable (idempotent) — deleting the deny row restores the default. */
export async function enablePack(tenantId: string, packName: string): Promise<boolean> {
  return store.delete(keyOf(tenantId, packName));
}

/** Test-only: clear the store. */
export async function __clearPackEnablement(): Promise<void> {
  await store.__clear();
}

// Register the visibility resolver at module load (the `setSubjectOrgResolver`
// pattern — core never imports this feature; the seam inverts the dependency).
setDisabledPacksResolver(disabledPacks);
