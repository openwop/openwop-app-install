/**
 * Publishing & SEO (ADR 0012). COMPOSES the CMS (ADR 0009): owns per-page SEO
 * metadata + a PUBLIC distribution surface (published-page read, sitemap.xml,
 * robots.txt, feed.rss) without modifying CMS data. The public surface is
 * unauthenticated (org→tenant from the URL) and gated on the org-tenant's
 * `publishing` toggle. A `publishing` toggle, off by default.
 */

import type { BackendFeature } from '../types.js';
import { registerPublishingRoutes } from './routes.js';

export const publishingFeature: BackendFeature = {
  id: 'publishing',
  registerRoutes: (deps) => registerPublishingRoutes(deps),
  toggleDefault: {
    id: 'publishing',
    label: 'Publishing & SEO',
    description: 'Publish CMS pages to a public web surface with per-page SEO metadata (meta + Open Graph), sitemap.xml, robots.txt, and an RSS feed. Composes the CMS (ADR 0009) + Media (OG images); the public surface is org-addressed and served only while this toggle is on (turning it off takes the site offline).',
    category: 'Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'publishing',
  },
};
