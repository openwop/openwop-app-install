/**
 * Marketplace chat tool (CFP-1 repair; ADR 0308 D2 seam) — the search grounding
 * for the Marketplace Recommender agent. The pack formerly allowlisted the
 * workflow node typeId `feature.marketplace.nodes.search`, which nothing projects
 * into a conversational tool (CFP-1). This `registerFeatureAgentTool` tool makes
 * the same read real, over the same `listingService` projection the surface +
 * route use.
 *
 * Listings are a HOST-GLOBAL projection (the installed pack set is process-global,
 * carrying no tenant identity), so there is no org slice to enforce — mirroring
 * `buildMarketplaceSurface`. Read posture: FAIL EMPTY without an acting user, and
 * gated on the `marketplace` toggle (a disabled workspace gets nothing). Install
 * stays a privileged admin/`host:*` REST action with NO agent tool, by design.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveFeatureToggle } from '../../host/agentToolKit.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { listListings, type Listing } from './listingService.js';
import { resolveListingPricing } from './listingPricingHook.js';

export const MARKETPLACE_SEARCH_TOOL_ID = 'openwop:marketplace.search';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * MPL-13 — the pricing annotation, without which the Marketplace Recommender
 * could not tell a $99 pack from a free one and recommended both in the same
 * words. `GET /listings` has always annotated it and the SPA client type has
 * always carried it; only the two model-facing projections dropped it.
 */
type Pricing = { lane: string; priceMajorUnits?: number; currency?: string; purchased?: boolean; purchasable?: boolean };

function project(l: Listing, pricing?: Pricing): Record<string, unknown> {
  return {
    packName: l.packName,
    version: l.version,
    title: l.title,
    ...(l.description ? { description: l.description } : {}),
    category: l.category,
    installed: l.installed,
    ...(pricing
      ? {
        pricing: {
          lane: pricing.lane,
          ...(pricing.priceMajorUnits !== undefined ? { priceMajorUnits: pricing.priceMajorUnits } : {}),
          ...(pricing.currency ? { currency: pricing.currency } : {}),
          ...(pricing.purchased !== undefined ? { purchased: pricing.purchased } : {}),
        },
      }
      : {}),
    // MKT2-B2 — `installed` alone is a misleading half-answer: it means "has a
    // registry install marker", and the packs mounted from the checkout have
    // none while the executor runs them. Without `origin` a reader concludes
    // they are missing and recommends installing them, which cannot succeed.
    origin: l.origin,
    // ADR 0660 D7 — same fix, same reason, on the OTHER model lane: a tombstoned
    // pack was projected to the recommender as an ordinary listing.
    ...(l.tombstoned ? { tombstoned: true } : {}),
    ...(l.requiredBy ? { requiredBy: l.requiredBy } : {}),
  };
}

function matches(l: Listing, q: string): boolean {
  const hay = `${l.packName} ${l.title} ${l.description ?? ''} ${l.category}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

async function marketplaceEnabled(scope: BundleScope): Promise<boolean> {
  return resolveFeatureToggle('marketplace', scope);
}

export function registerMarketplaceAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: MARKETPLACE_SEARCH_TOOL_ID,
      description:
        'Search the installable pack catalog by name / keyword / capability. Returns each pack\'s packName, version, '
        + 'title, description, category, installed status, `origin`, and `tombstoned`. Read `origin` before recommending anything, and NEVER recommend a pack marked `tombstoned` — an operator removed it: '
        + '`registry` packs were installed from the pack registry and CAN be installed/reinstalled there; `local` packs are '
        + 'mounted from the host checkout and are already loaded and running, so `installed: false` on a `local` pack does NOT '
        + 'mean it is missing, and installing it is impossible (it was never published to the registry). '
        + 'Read-only — recommend only; installing is a separate admin action.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search terms (a capability or keyword). Empty returns the full catalog.' } },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // Read tool: fail EMPTY (annotated), never a probe.
      if (!scope.actingUserId) return { content: JSON.stringify({ listings: [], note: 'This tool only reads from a human-initiated turn.' }) };
      if (!(await marketplaceEnabled(scope))) return { content: JSON.stringify({ listings: [], note: 'The Marketplace feature is not enabled for this workspace.' }) };
      const q = str(input.query);
      let all;
      try {
        all = listListings();
      } catch {
        // MKT2-B1 — the catalog could not be READ. Both empties above are
        // annotated; this one used to be the exception, so it was the single
        // empty a model could not tell apart from a real answer — and it is the
        // one that is not an answer. The model would go on to report that no
        // pack matches, which is a claim the failed read never established.
        return {
          content: JSON.stringify({
            listings: [],
            note: 'The installed-pack catalog could not be read, so this is NOT a statement that no packs match. Do not tell the user the catalog is empty or that nothing matched; say the catalog is temporarily unreadable.',
          }),
        };
      }
      const hits = q ? all.filter((l) => matches(l, q)) : all;
      // MPL-13 — annotate the hits with the viewer's pricing. `degraded` is the
      // provider's own disclosure that enrichment failed; passing it through
      // matters more here than in the UI, because a model told nothing at all
      // will state that a paid pack is free rather than that it does not know.
      const { pricing, degraded } = await resolveListingPricing(hits.map((l) => l.packName), scope.tenantId);
      return {
        content: JSON.stringify({
          listings: hits.map((l) => project(l, pricing[l.packName])),
          ...(degraded
            ? { note: 'Pricing could not be read for this catalog, so a pack shown without a `pricing` field is NOT necessarily free. Do not describe any pack as free in this answer.' }
            : {}),
        }),
      };
    },
  });
}
