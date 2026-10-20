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
import { registerCampaignConnectorsErasure } from './erasure.js';
import { SCHEDULED_CONVERSIONS_TOGGLE } from './conversionDelivery.js';

export const campaignConnectorsFeature: BackendFeature = {
  id: 'campaign-connectors',
  registerRoutes: (deps) => {
    // ADR 0907 D8 — the relay-queue DSAR eraser, registered unconditionally.
    registerCampaignConnectorsErasure();
    registerCampaignConnectorsRoutes(deps);
  },
  surface: { id: 'campaign-connectors', build: buildCampaignConnectorsSurface },
  // ADR 0907 D7 (lead amendment) — the SCHEDULED conversions delivery
  // (`campaign-sync.conversions-dispatch`) is OFF until switched on per
  // workspace: turning it on starts sending queued conversions to Meta (and to
  // TikTok/Google once verified) every hour. The manual "Dispatch" action is
  // the pre-existing ADR 0297 path and is not affected.
  extraToggleDefaults: [{
    id: SCHEDULED_CONVERSIONS_TOGGLE,
    label: 'Scheduled conversion delivery',
    description: 'Lets the hourly conversions-delivery chain send queued server-side conversions (Meta CAPI; TikTok and Google once verified) through the schedule owner\'s ad connections. Consent is re-checked per row at send, and events older than a platform\'s window are marked expired, never sent. Off until a workspace opts in. A sub-capability of Campaign Connectors.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-connectors-scheduled-conversions',
  }],
  requiredPacks: [
    'feature.campaign-connectors.nodes',
  ],
  toggleDefault: {
    id: 'campaign-connectors',
    label: 'Campaign Connectors & Performance',
    description:
      'Bring real ad-performance data into Campaign Studio — import platform CSV exports (Google / Meta / LinkedIn and more) onto a unified metric schema (spend, impressions, clicks, conversions, ROAS) with dedup + computed fields, and see KPI rollups per platform. Live OAuth sync (Google / Meta / LinkedIn Ads) is honest-off until the connector is brokered.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-connectors',
  },
};
