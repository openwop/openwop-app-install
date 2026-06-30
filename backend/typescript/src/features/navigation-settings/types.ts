/**
 * ADR 0139 — Configurable Navigation Menu: backend config model.
 *
 * Mirrors the frontend `chrome/navConfig/types.ts` overlay model (a feature
 * package can't import across the FE/BE boundary, so the shape is restated and
 * validated here). A `MenuConfig` is a SPARSE overlay over the declared nav:
 * per-item placement/visibility overrides + header rename/reorder/add. Two
 * layers are stored — a shared `tenant` default (superadmin-edited) and the
 * caller's `user` personalization.
 *
 * @see docs/adr/0139-configurable-navigation-menu.md
 */

/** Only the two nav menus carry items; `public` routes have no nav. */
export type MenuTier = 'workspace' | 'admin';

export interface ItemOverride {
  tier?: MenuTier;
  /** Target header **id** (built-in id = declared group label; custom = `hdr_*`). */
  group?: string;
  order?: number;
  /** Hide a feature-gated item. The FE ignores this for always-on items. */
  hidden?: boolean;
}

export interface HeaderDef {
  id: string;
  tier: MenuTier;
  label?: string;
  order?: number;
  custom?: boolean;
}

export interface MenuConfig {
  items: Record<string, ItemOverride>;
  headers: HeaderDef[];
}

export interface MenuConfigBundle {
  tenant: MenuConfig;
  user: MenuConfig;
}

/** A persisted layer row (one per tenant, one per tenant+user). */
export interface StoredMenuConfig {
  /** `${tenantId}:tenant` or `${tenantId}:user:${userId}`. */
  id: string;
  tenantId: string;
  scope: 'tenant' | 'user';
  /** The userId for `scope: 'user'`. */
  subject?: string;
  config: MenuConfig;
  updatedAt: string;
  updatedBy: string;
}

export const EMPTY_MENU_CONFIG: MenuConfig = { items: {}, headers: [] };
