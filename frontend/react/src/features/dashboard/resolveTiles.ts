/**
 * Effective-tile resolution (ADR 0375 Phase 2) — pure so it unit-tests without
 * React. Combines the registry with the caller's saved layout, gated by each
 * tile's owning-feature toggle + required tier. A tile whose feature is OFF or
 * whose tier the caller lacks is ABSENT from both the grid and the picker
 * (fail-closed); a saved id no longer in the registry is dropped (no migration).
 */
import type { DashboardTileDef, TileSize } from './tileTypes.js';

export interface ResolvedTile {
  def: DashboardTileDef;
  order: number;
  size: TileSize;
  enabled: boolean;
}

export interface SavedTile { id: string; order: number; size: TileSize; enabled: boolean }

export interface ResolveInput {
  registry: readonly DashboardTileDef[];
  /** The caller's saved layout, or null ⇒ derive defaults. */
  saved: readonly SavedTile[] | null;
  /** True when the tile's owning feature toggle is enabled for the caller.
   *  A tile with no `owningFeatureToggle` is always available. */
  toggleEnabled: (toggleId: string) => boolean;
  /** True when the caller satisfies the 'admin' tier. */
  isAdmin: boolean;
  /**
   * ADR 0419 — true when the tile's owning feature is LOCKED: its toggle is on,
   * but the tenant's plan does not entitle it. Such a tile can only ever render
   * an error: every read it makes 403s (`Your plan (free) does not include this
   * feature`), so the dashboard showed a permanently-failing tile and logged a
   * 403 on every load. Treated exactly like toggle-off — absent from the grid
   * AND the picker; the upsell lives on `/marketplace/bundles`, not here.
   * Optional so existing callers/tests are unaffected.
   */
  featureLocked?: (toggleId: string) => boolean;
}

/** The AVAILABLE tiles (pass toggle + tier), each merged with the caller's saved
 *  order/size/enabled (fallback to registry defaults), sorted by order. The
 *  picker shows this whole list; the grid shows the `enabled` subset. */
export function resolveTiles(input: ResolveInput): ResolvedTile[] {
  const { registry, saved, toggleEnabled, isAdmin, featureLocked } = input;
  const savedById = new Map((saved ?? []).map((s) => [s.id, s]));
  const available = registry.filter((def) => {
    if (def.requiredTier === 'admin' && !isAdmin) return false;
    if (def.owningFeatureToggle && !toggleEnabled(def.owningFeatureToggle)) return false;
    if (def.owningFeatureToggle && featureLocked?.(def.owningFeatureToggle)) return false;
    return true;
  });
  return available
    .map((def) => {
      const s = savedById.get(def.id);
      return {
        def,
        order: s?.order ?? def.defaultOrder,
        size: s?.size ?? def.defaultSize,
        enabled: s?.enabled ?? def.defaultEnabled,
      };
    })
    .sort((a, b) => a.order - b.order || a.def.id.localeCompare(b.def.id));
}

/** Merge the edited working set with saved rows for tiles that are REGISTERED
 *  but currently unavailable to this caller (owning toggle off / tier unmet) —
 *  so a save while a feature is toggled off never discards the caller's
 *  arrangement for that tile (grade-data fix S7b). Rows for ids no longer in
 *  the registry at all (retired tiles) are dropped (self-healing). */
export function mergeForPersist(
  saved: SavedTile[] | null,
  working: SavedTile[],
  registryIds: ReadonlySet<string>,
): SavedTile[] {
  const workingIds = new Set(working.map((w) => w.id));
  const preserved = (saved ?? []).filter((s) => !workingIds.has(s.id) && registryIds.has(s.id));
  return [...working, ...preserved];
}
