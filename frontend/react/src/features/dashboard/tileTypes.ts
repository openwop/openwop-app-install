/**
 * Dashboard tile registration types (ADR 0375 Phase 2).
 *
 * A tile is a compact PROJECTION over an existing feature's client — the
 * dashboard owns no tile data (ADR 0082). Each contributing feature exports a
 * `DashboardTileDef[]`; the central `allTiles.ts` composes them, and
 * `DashboardPage` reads that. Kept in a module SEPARATE from the nav manifest
 * (`chrome/features.tsx`): that manifest imports `DashboardPage` as the route
 * element, so a tile registry it depended on would cycle
 * (chrome/features ⇄ DashboardPage). Architect-corrected seam.
 */

import type { ComponentType, LazyExoticComponent } from 'react';

export type TileSize = 'half' | 'full';
export type TileCategory = 'Work' | 'Business' | 'Content' | 'AI' | 'Operations';

/** Every tile component receives a compact flag (rendered denser at `half`). */
export interface DashboardTileProps {
  compact: boolean;
}

/** Build-time definition of a registrable tile. */
export interface DashboardTileDef {
  /** Stable, unique tile id (persisted in the layout). */
  id: string;
  /** English label; `labelKey` is the i18n key in the `dashboard` namespace. */
  label: string;
  labelKey: string;
  /** Short description for the customization picker. */
  descriptionKey: string;
  /** A `ui/icons` Lucide component. */
  icon: ComponentType<{ size?: number; className?: string }>;
  category: TileCategory;
  /** Reuse the existing tier gate ('workspace' = everyone; 'admin' = admins). */
  requiredTier: 'workspace' | 'admin';
  /** The feature-toggle id that gates this tile; absent ⇒ always available.
   *  The tile is absent from BOTH the grid and the picker when this is OFF. */
  owningFeatureToggle?: string;
  defaultEnabled: boolean;
  defaultOrder: number;
  defaultSize: TileSize;
  /** May the user toggle half↔full at runtime? */
  resizable: boolean;
  /** Lazy component — registered eagerly (metadata), rendered lazily. */
  component: LazyExoticComponent<ComponentType<DashboardTileProps>>;
}
