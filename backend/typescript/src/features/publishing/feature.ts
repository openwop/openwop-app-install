/**
 * Publishing & SEO (ADR 0012). COMPOSES the CMS (ADR 0009): owns per-page SEO
 * metadata + a PUBLIC distribution surface (published-page read, sitemap.xml,
 * robots.txt, feed.rss) without modifying CMS data. The public surface is
 * unauthenticated (org→tenant from the URL).
 *
 * ALWAYS-ON (ADR 0027): no `toggleDefault` — retired from the toggle catalog
 * (the front page rides on its public surface). The per-tenant "site online"
 * switch is gone; the CMS editorial `published` status is now the sole public
 * gate (Sharing, ADR 0013, covers private/draft access). This overturns ADR 0012
 * Alternative 4. Authed SEO routes keep their org-scoped RBAC gate.
 */

import type { BackendFeature } from '../types.js';
import { registerPublishingRoutes } from './routes.js';

export const publishingFeature: BackendFeature = {
  id: 'publishing',
  registerRoutes: (deps) => registerPublishingRoutes(deps),
};
