/**
 * Feature manifest TYPES — extracted from chrome/features.tsx so a feature
 * package's route module can import them without an import cycle (the feature
 * registry imports these; chrome/features.tsx imports the registry). ADR §2.2.
 */
import type { ComponentType, ReactElement } from 'react';

export type IconCmp = ComponentType<{ size?: number; strokeWidth?: number }>;

/** Which shell the route renders in. `workspace` = the primary product rail;
 *  `admin` = inside <AdminLayout>'s embedded collapsible rail; `public` = a bare
 *  <PublicShell> rendered ABOVE <AppGate> with no auth + no nav (ADR 0027 — the
 *  CMS-driven front page). A `public` route carries no `nav` (it is not a menu
 *  item) and is matched directly by App.tsx's pre-AppGate branch. */
export type FeatureTier = 'workspace' | 'admin' | 'public';

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
  /** i18n key in the `nav` namespace for `label` (English fallback stays in
   *  `label`). Consumers resolve via `t(labelKey, { defaultValue: label })`. */
  labelKey?: string;
  /** i18n key in the `nav` namespace for `hint` (English fallback in `hint`). */
  hintKey?: string;
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
  /** Inverse gate (ADR 0144): hide this nav item when a DIFFERENT feature is
   *  enabled and has SUBSUMED it. The Access Hub uses it so the eight scattered
   *  `Access & data` entries collapse to the single "Access" entry only once
   *  `access-hub` is ON — and reappear instantly if it's flipped OFF (the routes
   *  themselves always resolve). A positive check, so `resolveNav` stays the one
   *  nav gate; no fragile negative-gating logic. */
  hiddenWhenFeature?: string;
}

/** Which tabbed console a `hubTab` route projects into. ADR 0144 shipped the
 *  Access Hub (`/access`); ADR 0145 generalized the primitive so multiple
 *  consoles project from the one `FEATURES` manifest — each filtering ONLY its
 *  own tabs by this discriminator. Omitting `hub` defaults to `'access'`, so the
 *  Access Hub's existing tabs need no change. */
export type HubId = 'access' | 'chat-deployment' | 'models';

/** Group a route into a tabbed console (ADR 0144 Access Hub; generalized to many
 *  consoles by ADR 0145). When set, the console named by `hub` renders this
 *  route's `element` as a tab body in addition to the route remaining reachable
 *  directly. The console PROJECTS from the `FEATURES` manifest
 *  (`FEATURES.filter(r => r.hubTab?.hub === <hub>)`) — so there is no second
 *  registry; this annotation IS the registration. Because a hub tab normally
 *  collapses its standalone `nav` entry (via `nav.hiddenWhenFeature`), the toggle
 *  gate moves to `hubTab.featureId`, and the console gates each tab through the
 *  SAME `useFeatureVisible()` predicate the rail uses (single-source gating). */
export interface FeatureHubTab {
  /** Which console this tab belongs to. Defaults to `'access'` (ADR 0144) when
   *  omitted, so existing Access-Hub tabs need no edit. */
  hub?: HubId;
  /** Optional sub-group within the console's rail (the Access Hub clusters
   *  `'credentials'` vs `'identity'`). Flat consoles omit it; the console owns
   *  the group display order. */
  group?: string;
  /** Which scope-pill positions show this tab. Defaults to `['workspace']`. A
   *  tab marked `'personal'` renders for any authenticated user against their
   *  own (user-scoped) data; see ADR 0144 §Decision. */
  scopes?: ('workspace' | 'personal')[];
  /** POSITION within the group (lower = earlier). Mirrors `nav.order`. */
  order?: number;
  /** Toggle id gating this tab inside the console. Absent ⇒ always shown (the
   *  tab's surface is always-on, e.g. Keys/Orgs). Read via the same
   *  `useFeatureVisible` predicate as nav gating, so a disabled toggle hides it. */
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
  /** Present = the route is also surfaced as a tab inside the Access Hub
   *  (`/access`), projected from this manifest (ADR 0144). */
  hubTab?: FeatureHubTab;
}
