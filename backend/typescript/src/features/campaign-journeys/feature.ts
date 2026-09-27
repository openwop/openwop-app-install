/**
 * Campaign Journeys (ADR 0222 / campaign gap plan C6) — contact-level lifecycle
 * automation as RFC 0013 chains on the ONE engine, triggered by host events
 * (ADR 0208 bindings), gated per-contact by the enrollment guard + eligibility
 * composite this feature owns. Deliberately NOT a journey engine (the gap
 * analysis §6 non-goal): no canvas, no enrollment scheduler, no second sender —
 * waits are `core.flow.wait`, sends are the existing email/SMS nodes, state is
 * the run itself.
 *
 * @see docs/adr/0222-campaign-journey-chains.md
 */
import type { BackendFeature } from '../types.js';
import { registerCampaignJourneysRoutes } from './routes.js';
import { buildCampaignJourneysSurface } from './surface.js';

export const campaignJourneysFeature: BackendFeature = {
  id: 'campaign-journeys',
  registerRoutes: (deps) => registerCampaignJourneysRoutes(deps),
  surface: { id: 'campaign-journeys', build: buildCampaignJourneysSurface },
  requiredPacks: [
    { name: 'feature.campaign-journeys.nodes', version: '1.3.0' },
  ],
  toggleDefault: {
    id: 'campaign-journeys',
    label: 'Campaign Journeys',
    description:
      'Contact-level lifecycle automation as workflow chains — welcome series, re-engagement, and any flow you bind to a CRM or campaign event. One enrollment per contact per journey (no double-sends), every send gated by consent + suppression. Journeys run on the workflow engine: monitor them in Runs, approve steps in the Approvals inbox. OFF by default.',
    category: 'Customer Data Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-journeys',
  },
  recommends: ['crm', 'email', 'consent'],
};
