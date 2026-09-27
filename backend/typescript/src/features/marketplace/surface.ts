/**
 * Marketplace workflow surface (ADR 0022 / ADR 0014) — `ctx.features.marketplace`,
 * a THIN READ-ONLY adapter over the listing projection (listingService). It exposes
 * `listings` (all packs + install status) and `search` (filter by name/keyword/
 * capability) so a workflow node can DISCOVER an installable pack.
 *
 * INSTALL is deliberately NOT on the surface (ADR §"Core-app extension"): install
 * mutates process-global pack state and is admin/`host:*`-scoped, so it stays a
 * privileged REST action — a workflow node can never trigger it. Every method is
 * read-only, so replay/fork is trivially safe.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listListings, type Listing } from './listingService.js';

/** Project a listing to the node-facing shape (display fields only). */
function project(l: Listing): Record<string, unknown> {
  return {
    packName: l.packName,
    version: l.version,
    title: l.title,
    ...(l.description ? { description: l.description } : {}),
    category: l.category,
    installed: l.installed,
    // MKT2-B2 — `installed` alone is a misleading half-answer: it means "has a
    // registry install marker", and the packs mounted from the checkout have
    // none while the executor runs them. Without `origin` a reader concludes
    // they are missing and recommends installing them, which cannot succeed.
    origin: l.origin,
    // ADR 0660 D7 — `tombstoned` MUST survive the projection. `listListings()` sets
    // it and BOTH model lanes dropped it, so the recommender recommends a pack the
    // operator removed. Identical shape to the `origin` fix three lines above: a
    // projection that silently narrows is how a model gets lied to.
    ...(l.tombstoned ? { tombstoned: true } : {}),
    ...(l.requiredBy ? { requiredBy: l.requiredBy } : {}),
  };
}

/** Case-insensitive match of `q` against a listing's name/title/description/category. */
function matches(l: Listing, q: string): boolean {
  const hay = `${l.packName} ${l.title} ${l.description ?? ''} ${l.category}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

export function buildMarketplaceSurface(_scope: BundleScope): FeatureSurface {
  // Listings are a HOST-GLOBAL projection (the installed pack set is process-global,
  // not per-tenant), so there is no tenant slice to enforce here — the data carries
  // no tenant identity. The toggle gate (featureSurfaces.ts) still applies per call.
  return {
    listings: async () => ({ listings: listListings().map(project) }),
    search: async (args) => {
      const q = str(args.query).trim();
      const all = listListings();
      const hits = q ? all.filter((l) => matches(l, q)) : all;
      return { listings: hits.map(project) };
    },
  };
}
