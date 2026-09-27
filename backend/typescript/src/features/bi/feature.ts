/**
 * ADR 0417 — BI copilot v1: the semantic metric catalog + NL→query→chart lane.
 * P1 ships the catalog (closed-world-validated against the entities registry)
 * + the evaluator over the service-layer entity reads + admin CRUD routes.
 * P2 adds the surface + agent tools; P3 the node pack + dashboard tile.
 */
import type { BackendFeature } from '../types.js';
import { registerBiRoutes } from './routes.js';
import { registerBiAgentTools } from './agentTools.js';
import { buildBiSurface } from './surface.js';

export const biFeature: BackendFeature = {
  id: 'bi',
  requiredPacks: [
    { name: 'feature.bi.nodes', version: '1.0.0' },
  ],
  registerRoutes: (deps) => {
    registerBiRoutes(deps);
    registerBiAgentTools(); // ADR 0308 seam
  },
  surface: { id: 'bi', build: buildBiSurface },
  toggleDefault: {
    id: 'bi',
    label: 'Business metrics (BI)',
    description:
      'Governed semantic metrics over workspace business data (deals, products, companies, custom entities) — defined closed-world, runnable from chat, workflows, and the dashboard (ADR 0417).',
    category: 'Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'bi',
  },
};
