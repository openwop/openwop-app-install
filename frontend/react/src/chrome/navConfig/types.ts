/**
 * ADR 0139 — Configurable Navigation Menu: the override data model.
 *
 * The navigation is declared by `FEATURES[].nav` (chrome/features.tsx) — the
 * SUGGESTED defaults. A `MenuConfig` is a SPARSE overlay that re-tiers / re-groups
 * / re-orders / hides those declared items and renames/reorders/adds headers.
 * Two layers stack (`tenant` ← `user`); empty layers reproduce today's menu
 * exactly (see `resolveNav` + its regression test).
 *
 * Stored host-side under `/v1/host/openwop-app/menu-config` (ADR 0139 Phase 2):
 * the `tenant` layer is superadmin-edited + shared; the `user` layer is the
 * caller's personalization. Per-browser section-collapse state is NOT here — it
 * lives in a cookie (`navCollapseCookie.ts`).
 */
import type { FeatureTier } from '../featureTypes.js';

/** A per-item override, keyed by the item's route `path` in `MenuConfig.items`.
 *  Every field is optional — a sparse patch over the declared `nav`. */
export interface ItemOverride {
  /** Move the item between the main (workspace) and admin menus. */
  tier?: FeatureTier;
  /** Re-home the item under a different header — stores a header **id**
   *  (built-in id = the declared group label; custom id = `hdr_*`). */
  group?: string;
  /** Position within its (possibly overridden) header. */
  order?: number;
  /** Hide a feature-gated item from the menu. IGNORED for always-on items
   *  (those without a `featureId`) — they can be moved but never hidden. */
  hidden?: boolean;
}

/** A header (nav category). Built-in headers only need an entry here when
 *  renamed or reordered; custom headers always have one. */
export interface HeaderDef {
  /** Stable key. Built-in = the declared group label ('Platform'); custom = `hdr_*`. */
  id: string;
  /** Which menu the header belongs to. */
  tier: FeatureTier;
  /** Display label override. When set, the literal wins over the i18n lookup. */
  label?: string;
  /** Position among headers in its tier (falls back to GROUP_ORDER rank). */
  order?: number;
  /** True for a user/admin-created header (not one of the built-ins). */
  custom?: boolean;
}

/** One override layer. */
export interface MenuConfig {
  items: Record<string, ItemOverride>;
  headers: HeaderDef[];
}

/** Both layers as returned by the combined GET. */
export interface MenuConfigBundle {
  tenant: MenuConfig;
  user: MenuConfig;
}

export const EMPTY_MENU_CONFIG: MenuConfig = { items: {}, headers: [] };
export const EMPTY_MENU_CONFIG_BUNDLE: MenuConfigBundle = {
  tenant: EMPTY_MENU_CONFIG,
  user: EMPTY_MENU_CONFIG,
};
