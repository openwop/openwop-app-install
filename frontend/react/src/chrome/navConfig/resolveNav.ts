/**
 * ADR 0139 — the pure navigation resolver.
 *
 * `resolveNav` overlays a (tenant ← user) `MenuConfig` on the declared
 * `FEATURES` nav and returns the grouped, ordered workspace + admin rails. It
 * does NOT re-implement grouping: it applies the sparse overrides, re-runs the
 * feature-toggle hard gate, then routes through the ONE shared `navGroups`
 * primitive (chrome/features.tsx) before applying header rename/reorder. With
 * empty layers + allow-all access it reproduces today's `WORKSPACE_NAV` /
 * `ADMIN_NAV_GROUPS` exactly (pinned by resolveNav.test.ts).
 */
import type { FeatureRoute, FeatureTier } from '../featureTypes.js';
import { navGroups, groupRank, type NavGroup } from '../features.js';
import { EMPTY_MENU_CONFIG, type HeaderDef, type ItemOverride, type MenuConfig } from './types.js';

export interface ResolvedNav {
  workspace: NavGroup[];
  admin: NavGroup[];
}

/** Visibility predicate — mirrors the rails' `isVisible`: core items (no
 *  `featureId`) always pass; gated items pass only when enabled. */
export type AccessPredicate = (featureId?: string) => boolean;

export interface ResolveNavInput {
  features: FeatureRoute[];
  tenant?: MenuConfig;
  user?: MenuConfig;
  access: AccessPredicate;
}

/** Merge the two layers into one effective config (user wins, per field). */
export function mergeLayers(tenant: MenuConfig, user: MenuConfig): MenuConfig {
  const items: Record<string, ItemOverride> = {};
  for (const [path, ov] of Object.entries(tenant.items)) items[path] = { ...ov };
  for (const [path, ov] of Object.entries(user.items)) items[path] = { ...items[path], ...ov };

  const headers = new Map<string, HeaderDef>();
  for (const h of tenant.headers) headers.set(h.id, { ...h });
  for (const h of user.headers) headers.set(h.id, { ...headers.get(h.id), ...h });

  return { items, headers: [...headers.values()] };
}

/**
 * Apply header rename + reorder on top of grouped output. Renamed headers carry
 * the literal label (and `custom: true` so the consumer skips the i18n lookup);
 * group order honours an override's `order`, falling back to GROUP_ORDER rank.
 * Stable sort keeps equal ranks in their incoming (navGroups) order.
 */
function applyHeaderOverrides(groups: NavGroup[], headers: Map<string, HeaderDef>): NavGroup[] {
  const decorated = groups.map((g) => {
    const h = headers.get(g.id);
    if (h?.label != null && h.label !== '') {
      return { ...g, label: h.label, custom: true };
    }
    return g;
  });
  const rankOf = (id: string): number => {
    const o = headers.get(id)?.order;
    return o === undefined ? groupRank(id) : o;
  };
  // index map preserves the pre-sort order as the stable tiebreak.
  const idx = new Map(decorated.map((g, i) => [g, i] as const));
  return [...decorated].sort((a, b) => {
    const d = rankOf(a.id) - rankOf(b.id);
    return d !== 0 ? d : (idx.get(a) ?? 0) - (idx.get(b) ?? 0);
  });
}

/**
 * Resolve the effective navigation. Pure: no DOM / cookie / network access.
 */
export function resolveNav({ features, tenant = EMPTY_MENU_CONFIG, user = EMPTY_MENU_CONFIG, access }: ResolveNavInput): ResolvedNav {
  const merged = mergeLayers(tenant, user);
  const knownHeaderIds = new Set(merged.headers.map((h) => h.id));

  const effective: FeatureRoute[] = [];
  for (const f of features) {
    if (!f.nav) continue;
    const alwaysOn = !f.nav.featureId;
    // 1. feature-toggle HARD gate — runs before any override; a `hidden:false`
    //    can never reveal a disabled feature.
    if (f.nav.featureId && !access(f.nav.featureId)) continue;
    // 1b. inverse gate (ADR 0144) — hide an item that a DIFFERENT enabled feature
    //     has subsumed (the Access Hub collapsing the Access & data entries). A
    //     positive "hide when X is on" check; the route still resolves.
    if (f.nav.hiddenWhenFeature && access(f.nav.hiddenWhenFeature)) continue;

    const ov = merged.items[f.path] ?? {};
    // 2. hide override — never applies to always-on items.
    if (ov.hidden && !alwaysOn) continue;

    const tierEff: FeatureTier = ov.tier ?? f.tier;
    // 3. group override — a stale id pointing at a deleted header falls back to
    //    the declared group (the item is never dropped). A built-in group id is
    //    always valid (it's a declared label); a custom id must still exist.
    const declaredGroup = f.nav.group;
    const wantGroup = ov.group;
    const groupEff =
      wantGroup && (wantGroup === declaredGroup || knownHeaderIds.has(wantGroup) || !isCustomId(wantGroup))
        ? wantGroup
        : declaredGroup;
    const orderEff = ov.order ?? f.nav.order;

    // exactOptionalPropertyTypes: only set `order` when defined (never `: undefined`).
    const navEff = { ...f.nav, group: groupEff, ...(orderEff !== undefined ? { order: orderEff } : {}) };
    effective.push({ ...f, tier: tierEff, nav: navEff });
  }

  const headerMap = new Map(merged.headers.map((h) => [h.id, h] as const));
  const wsHeaders = filterByTier(headerMap, 'workspace');
  const adHeaders = filterByTier(headerMap, 'admin');

  return {
    workspace: applyHeaderOverrides(navGroups(effective.filter((f) => f.tier === 'workspace')), wsHeaders),
    admin: applyHeaderOverrides(navGroups(effective.filter((f) => f.tier === 'admin')), adHeaders),
  };
}

/** A custom (user-created) header id is namespaced `hdr_*`; everything else is a
 *  built-in group label. */
export function isCustomId(id: string): boolean {
  return id.startsWith('hdr_');
}

/** Allocate a fresh custom header id. Caller supplies existing ids + a counter
 *  seed (kept deterministic for testability — no Date.now/Math.random). */
export function nextHeaderId(existing: Iterable<string>): string {
  let n = 1;
  const set = new Set(existing);
  while (set.has(`hdr_${n}`)) n += 1;
  return `hdr_${n}`;
}

function filterByTier(headers: Map<string, HeaderDef>, tier: FeatureTier): Map<string, HeaderDef> {
  const out = new Map<string, HeaderDef>();
  for (const [id, h] of headers) if (h.tier === tier) out.set(id, h);
  return out;
}
