/**
 * Feature manifest TYPES — extracted from chrome/features.tsx so a feature
 * package's route module can import them without an import cycle (the feature
 * registry imports these; chrome/features.tsx imports the registry). ADR §2.2.
 */
import type { ComponentType, ReactElement } from 'react';

export type IconCmp = ComponentType<{ size?: number; strokeWidth?: number }>;

/** Which shell the route renders in. `workspace` = the primary product rail;
 *  `admin` = inside <AdminLayout>'s embedded collapsible rail. */
export type FeatureTier = 'workspace' | 'admin';

/** Width/scroll treatment the shell gives the route's <main>. Shell-owned. */
export type FeatureChrome = 'default' | 'narrow' | 'fullbleed' | 'chat';

export interface FeatureNav {
  /** Group header within the tier — the menu CATEGORY this item falls under.
   *  Category display order is set by `GROUP_ORDER` in chrome/features.tsx;
   *  an unlisted group sorts after the known ones (stable by first appearance). */
  group: string;
  label: string;
  icon: IconCmp;
  hint: string;
  /** POSITION within the group (lower = earlier). How a feature declares where
   *  it slots relative to its siblings, so the registry — not render code — owns
   *  ordering. Items without `order` sort after ordered ones, stable by
   *  declaration order (omitting it preserves append-at-end behavior). */
  order?: number;
  /** Exact-match only (e.g. Chat at "/"). */
  end?: boolean;
  /** Sibling routes that must NOT light this item. */
  notUnder?: string[];
  /** Toggle id this nav item belongs to. When set, the item is hidden unless
   *  the feature resolves enabled for the caller (ADR §3.4 — toggle gates nav
   *  visibility). Absent ⇒ always shown (core surfaces). A `beta` toggle that
   *  resolves enabled renders a Beta badge (Sidebar/AdminLayout/⌘K read it from
   *  feature access). */
  featureId?: string;
}

export interface FeatureRoute {
  /** react-router path pattern (`/runs/:runId`). */
  path: string;
  element: ReactElement;
  tier: FeatureTier;
  /** Defaults to 'default'. */
  chrome?: FeatureChrome;
  /** Present = the route appears in its tier's nav (and the ⌘K palette). */
  nav?: FeatureNav;
}
