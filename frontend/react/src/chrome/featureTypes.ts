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
 *  item) and is matched directly by App.tsx's pre-AppGate branch.
 *
 *  `site` = ADR 0641. A PRODUCT surface at a clean root URL (`/today`), in a bare
 *  shell WITH nav, session-bearing and toggle-gated — the "public side of the
 *  app" as distinct from the console. It is a fourth TIER and not a `chrome`
 *  variant because `chromeFor()`'s result is consumed in exactly one place —
 *  computing `mainClass` in App.tsx — which runs strictly AFTER shell selection
 *  and is already inside both <AppGate> and `div.app-shell`. A chrome value is
 *  structurally incapable of selecting a shell; the tier is the seam.
 *
 *  A `site` route's auth requirement is a SEPARATE per-route field (`auth`), not
 *  a property of the tier: the six KickTodo surfaces live on the same side of the
 *  app while differing in whether they need a session. */
export type FeatureTier = 'workspace' | 'admin' | 'public' | 'site';

/** ADR 0641 decision 2 — auth posture as a property of the ROUTE, meaningful
 *  only on the `site` tier.
 *
 *  - `required` — the route wraps <AppGate>; an anonymous visitor gets the
 *    sign-in wall. The default, and what every non-`site` tier behaves as.
 *  - `optional` — the route renders for BOTH anonymous and signed-in callers,
 *    richer when signed in. It MUST NOT wrap <AppGate>.
 *
 *  This splits a conflation that predates the tier: `showPublic` in App.tsx
 *  decided shell selection AND session/SSE bootstrap with one boolean, so there
 *  was no way to express "bare shell, but still session-bearing".
 *
 *  It is deliberately NOT a three-valued field. A surface that is signed-in AND
 *  scoped further — KickTodo's leaderboard is visible only to a challenge's
 *  enrolled participants (decision 13) — is `required` here, with the narrowing
 *  owned by the service that holds the data. Posture answers "does this route
 *  need a session", settled before any row is read; authorization answers "which
 *  rows may this session see". Folding the second into the first would make
 *  `auth` a second owner of a fact the service already owns. */
export type FeatureAuthPosture = 'required' | 'optional';

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
  /** Additional route prefixes represented by this destination. Hub entries use
   *  these aliases so a legacy/direct child URL still identifies the visible
   *  parent destination as current. */
  activeFor?: string[];
  /** Hide this destination unless the caller is a host superadmin. This is a
   *  presentation projection only; the backend remains authoritative. */
  superadminOnly?: boolean;
  /** Hide this destination unless the caller holds this effective scope (or is
   *  a superadmin). Presentation only; route handlers still enforce access. */
  requiredScope?: string;
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
export type HubId = 'access' | 'chat-deployment' | 'models' | 'campaigns';

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

/**
 * ADR 0510 §8 (DSA-029) — the page archetypes. Every route declares exactly
 * one; each archetype carries heading/action/state/width/responsive
 * obligations (documented in DESIGN.md § "Page archetypes"). REQUIRED on
 * purpose: the type system is the coverage gate — a route without an
 * archetype is a compile error, not a lint warning.
 */
export type PageArchetype =
  | 'standard-index'   // list/collection page on the standard content width
  | 'data-dense-index' // table-first working surface (runs, CRM, commerce)
  | 'detail'           // one entity, deep-linkable
  | 'admin'            // platform/config surface on the admin rail
  | 'hub'              // suite hub projecting child destinations
  | 'public'           // marketing/public-tier page (PublicShell)
  | 'immersive-chat'   // the chat shell (no standard chrome)
  | 'canvas-editor'    // full-bleed editor chassis
  | 'narrow-form';     // focused single-task flow (wizards, create forms)

export interface FeatureRoute {
  /** react-router path pattern (`/runs/:runId`). */
  path: string;
  /** Optional canonical parent destination for a nav-less detail/admin route.
   *  The admin shell resolves this against this same manifest and exposes it
   *  as page-header wayfinding; it is not a second navigation registry. */
  parentPath?: string;
  /** ADR 0510 §8 — the declared page archetype (see PageArchetype). */
  archetype: PageArchetype;
  /**
   * The id of the `FrontendFeature` that contributed this route. Stamped
   * automatically by `featureRoutes()` at flatten time — never hand-written.
   *
   * ADR 0419: this is what the route-level `EntitlementGuard` keys on. It used to
   * key on `nav.featureId`, which only INDEX routes carry — so every detail /
   * deep-link route (`/crm/deals/:dealId`, `/slides/:canvasId`, …) rendered
   * unguarded. That inverted the guard's own purpose, which is precisely the
   * deep-link case. Stamping the owner at composition means a new route inherits
   * coverage automatically instead of relying on someone remembering.
   *
   * Absent on `CORE_FEATURES` routes — core substrate is never sellable.
   */
  ownerFeatureId?: string;
  element: ReactElement;
  tier: FeatureTier;
  /** ADR 0641 decision 2 — auth posture, meaningful ONLY on the `site` tier and
   *  ignored elsewhere (`workspace`/`admin` are always behind <AppGate>;
   *  `public` is auth-none by definition). Defaults to `'required'`, so a `site`
   *  route that forgets to declare it is the SAFE one: it wraps the sign-in wall
   *  rather than silently exposing a surface. Fail-closed by omission. */
  auth?: FeatureAuthPosture;
  /** Defaults to 'default'. */
  chrome?: FeatureChrome;
  /** Present = the route appears in its tier's nav (and the ⌘K palette). */
  nav?: FeatureNav;
  /** Present = the route is also surfaced as a tab inside the Access Hub
   *  (`/access`), projected from this manifest (ADR 0144). */
  hubTab?: FeatureHubTab;
}
