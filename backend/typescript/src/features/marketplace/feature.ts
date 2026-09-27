/**
 * Marketplace — browse + install feature packs over the signed registry (ADR 0022).
 *
 * The one feature in its batch that leverages an asset unique to this app: the
 * signed pack registry (`packs.openwop.dev`, Ed25519 + SHA-256 SRI). It COMPOSES
 * the existing pack pipeline — it re-implements none of it:
 *   - browse  → a PROJECTION over the local pack-dir scan + `.openwop-installed.json`
 *     markers + `featurePackRefs()` (listingService) — no new discovery mechanism.
 *   - install → DELEGATES to `installPackFromRegistry` (the single owner of
 *     Ed25519/SRI verification) — signed-only, superadmin-gated, process-global.
 *   - reviews → the ONLY new durable store (reviewService).
 *
 * Wired as a PURE addition (ADR 0001 §2.2): appended to BACKEND_FEATURES, zero core
 * edits. Tenant-bucketed, OFF by default. Face 2 (ADR 0014): a read-only
 * `ctx.features.marketplace` surface (listings/search; install excluded by design)
 * behind the SAME `marketplace` toggle, advertised at `/.well-known/openwop`.
 *
 * @see docs/adr/0022-marketplace.md
 */

import type { BackendFeature } from '../types.js';
import { registerMarketplaceRoutes } from './routes.js';
import { buildMarketplaceSurface } from './surface.js';
import { registerMarketplaceAgentTools } from './agentTools.js';
import { registerMarketplaceErasure } from './erasure.js';

export const marketplaceFeature: BackendFeature = {
  id: 'marketplace',
  registerRoutes: (deps) => {
    registerMarketplaceRoutes(deps);
    // CFP-1 — the Marketplace Recommender agent's real search tool. Process-wide
    // + inert until the pack allowlists the id; per-tenant toggle honesty lives
    // inside the tool's run().
    registerMarketplaceAgentTools();
    // MPL-7 (ADR 0464) — the subject-erasure seam. `marketplace:review` sat in
    // the ratchet's ACTOR_ATTRIBUTED_DEBT ledger as a permanent record of a gap,
    // and `marketplace:pack-disable` was invisible to the ratchet entirely
    // (`disabledBy` matched none of its actor signals). Both are ANONYMIZED, not
    // deleted — the reasons are argued in `erasure.ts`.
    registerMarketplaceErasure();
  },
  // Face 2 (ADR 0014): `ctx.features.marketplace` — read-only listings/search over
  // the listing projection. Install is NOT surfaced (privileged, process-global).
  surface: { id: 'marketplace', build: buildMarketplaceSurface },
  toggleDefault: {
    id: 'marketplace',
    label: 'Marketplace',
    description: 'Browse + install signed feature packs from the registry — sample product feature.',
    category: 'Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'marketplace',
  },
  requiredPacks: [
    { name: 'feature.marketplace.nodes', version: '1.1.0' },
    { name: 'feature.marketplace.agents', version: '1.0.1' }, // CFP-1 real search tool
  ],
};
