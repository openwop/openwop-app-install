/**
 * Analytics feature (ADR 0018) — the MEASURE leg. A public beacon (consent-gated
 * via ADR 0020) + authed org-scoped reporting, plus a `ctx.features.analytics`
 * read surface (ADR 0014) + `feature.analytics.{nodes,agents}`, all behind the
 * same `analytics` toggle. Off by default (a new product surface).
 */

import type { BackendFeature } from '../types.js';
import { registerAnalyticsRoutes } from './routes.js';
import { buildAnalyticsSurface } from './surface.js';

export const analyticsFeature: BackendFeature = {
  id: 'analytics',
  registerRoutes: registerAnalyticsRoutes,
  // Face 2 (ADR 0014): `ctx.features.analytics` — a thin read surface (query) that
  // backs the feature.analytics.nodes pack.
  surface: { id: 'analytics', build: buildAnalyticsSurface },
  toggleDefault: {
    id: 'analytics',
    label: 'Analytics',
    description: 'Public-surface measurement (page/event/conversion) + reporting — product feature.',
    category: 'Business Tools',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'analytics',
  },
  requiredPacks: [
    { name: 'feature.analytics.nodes', version: '1.0.0' },
    { name: 'feature.analytics.agents', version: '1.0.0' },
  ],
};
