/**
 * Pack tombstones (ADR 0194 Phase 4) — the host-global "removed from this host"
 * state behind the marketplace's two-tier uninstall:
 *
 *   TOMBSTONE — the pack's bytes STAY on disk (historical runs/replay/loader
 *     resolution untouched — the ARCHITECTURE.md replay invariant) but the pack
 *     is hidden from every AUTHORING/browse surface (node catalog, palette, AI
 *     author, marketplace install) host-wide. Fully reversible (restore).
 *   PURGE — the pack dir is deleted to reclaim footprint, allowed only while
 *     tombstoned AND while no registered workflow definition references the
 *     pack's node typeIds (the route owns that gate). The tombstone row is KEPT
 *     after purge so boot loaders never resurrect the pack; a later restore
 *     clears the row (the pack is then simply absent + installable again).
 *
 * NOT REVOCATION — see `host/packRevocations.ts` (ADR 0555 P0). A tombstoned
 * pack STILL EXECUTES: this module deliberately preserves loader resolution and
 * replay, and is a reversible PRODUCT action. A revoked pack never executes
 * again and deliberately breaks replay of runs that used it, because it is a
 * SECURITY action against code believed compromised. Do not route one through
 * the other; the guarantees are opposites.
 *
 * Why a DURABLE ROW and not a file marker: purge would delete its own marker,
 * and Cloud Run pack dirs are per-instance/ephemeral — a marker written on one
 * instance never exists on another. The row is loaded into an in-process cached
 * Set at boot (storage init precedes the pack loaders in index.ts) and refreshed
 * on every mutation; sync consumers (catalog scan, packPresence) read the cache.
 * Cross-instance freshness = next boot — the same freshness class as install
 * itself (ADR 0022: install is process-global).
 */

import { DurableCollection } from './hostExtPersistence.js';

export interface PackTombstone {
  /** Pack name — the deterministic row key (idempotent tombstone/restore). */
  packName: string;
  tombstonedAt: string;
  tombstonedBy: string;
}

const store = new DurableCollection<PackTombstone>('pack-tombstone', (r) => r.packName);

/** In-process cache so sync surfaces (catalog scan, packPresence) can consult
 *  tombstones without an await. Loaded at boot; refreshed on every mutation. */
let cached = new Set<string>();

/** Load (or reload) the tombstone set from storage. Called at boot BEFORE the
 *  pack loaders, and after any mutation. */
export async function loadPackTombstones(): Promise<Set<string>> {
  cached = new Set((await store.list()).map((r) => r.packName));
  return cached;
}

/** Sync view of the tombstoned pack names (the boot-loaded cache). */
export function tombstonedPacks(): ReadonlySet<string> {
  return cached;
}

export function isTombstoned(packName: string): boolean {
  return cached.has(packName);
}

/** Tombstone (idempotent — deterministic key). Refreshes the cache. */
export async function tombstonePack(packName: string, by: string): Promise<void> {
  await store.put({ packName, tombstonedAt: new Date().toISOString(), tombstonedBy: by });
  await loadPackTombstones();
}

/** Restore (idempotent). Returns whether a tombstone existed. Refreshes the cache. */
export async function restorePack(packName: string): Promise<boolean> {
  const existed = await store.delete(packName);
  await loadPackTombstones();
  return existed;
}

/** Test-only: clear tombstones + cache. */
export async function __clearPackTombstones(): Promise<void> {
  await store.__clear();
  cached = new Set();
}
