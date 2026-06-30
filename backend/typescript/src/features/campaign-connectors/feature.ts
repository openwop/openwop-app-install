/**
 * Campaign Studio: Live Connectors & Performance (ADR 0159). CSV import + a
 * campaign performance store + KPI projection, plus the Google/Meta/LinkedIn Ads
 * RFC 0095 connection packs (loaded by the connection-pack loader) and a sync node
 * (honest-off until the broker reach is wired — ADR 0037). Composes Connections
 * (ADR 0024) + Analytics (ADR 0018); forks neither.
 *
 * RFC gate (ADR 0159): rides Accepted RFC 0095 + the broker. NO new RFC.
 *
 * @see docs/adr/0159-campaign-studio-connectors-performance.md
 */

import type { BackendFeature } from '../types.js';
import { registerCampaignConnectorsRoutes } from './routes.js';
import { buildCampaignConnectorsSurface } from './surface.js';

export const campaignConnectorsFeature: BackendFeature = {
  id: 'campaign-connectors',
  registerRoutes: (deps) => registerCampaignConnectorsRoutes(deps),
  surface: { id: 'campaign-connectors', build: buildCampaignConnectorsSurface },
  requiredPacks: [
    { name: 'feature.campaign-connectors.nodes', version: '1.0.0' },
  ],
  toggleDefault: {
    id: 'campaign-connectors',
    label: 'Campaign Connectors & Performance',
    description:
      'Bring real ad-performance data into Campaign Studio — import platform CSV exports (Google / Meta / LinkedIn and more) onto a unified metric schema (spend, impressions, clicks, conversions, ROAS) with dedup + computed fields, and see KPI rollups per platform. Live OAuth sync (Google / Meta / LinkedIn Ads) is honest-off until the connector is brokered. OFF by default.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-connectors',
  },
};
