/**
 * Discovery (ADR 0275 / MERCH-C) — faceted product search + collections + pin/boost/
 * bury merchandising rules, COMPOSING commerce `listProducts` + the shared bucketing
 * primitive (holdout). Toggle OFF ⇒ zero behavior change. Depends on commerce (no
 * catalog ⇒ nothing to search/curate). Host-extension — no RFC.
 *
 * @see docs/adr/0275-merch-c-discovery-search-collections-merch-rules.md
 */
import type { BackendFeature } from '../types.js';
import { registerDiscoveryRoutes } from './routes.js';
import { buildDiscoverySurface } from './surface.js';
import { registerDiscoveryAgentTools } from './agentTools.js';
import { onProductDeleted } from '../commerce/productLifecycleSeam.js';
import { pruneProductRefs } from './discoveryService.js';

export const discoveryFeature: BackendFeature = {
  id: 'discovery',
  registerRoutes: (deps) => {
    registerDiscoveryRoutes(deps);
    // CFP-1 — the Discovery Curator's conversational tools (chat-first port).
    registerDiscoveryAgentTools();
    // RI-4 (grade-data) — drop pins + manual-collection refs when a product is
    // deleted (keyed + idempotent registration; safe regardless of toggle state:
    // only ever touches this feature's own soft-reference rows).
    onProductDeleted('discovery', async ({ tenantId, orgId, productId }) => {
      await pruneProductRefs(tenantId, orgId, productId);
    });
  },
  surface: { id: 'discovery', build: buildDiscoverySurface },
  toggleDefault: {
    id: 'discovery',
    label: 'Discovery',
    description: 'Faceted product search + collections + merchandising rules (MERCH-C).',
    category: 'Commerce',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'discovery',
  },
  requiredPacks: [
    { name: 'feature.discovery.nodes', version: '1.0.0' },
    { name: 'feature.discovery.agents', version: '1.0.2' },
  ],
  dependsOn: ['commerce'],
};
