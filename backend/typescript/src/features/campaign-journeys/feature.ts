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
import { registerJourneyExperimentSurface } from './experimentSurface.js';
import type { BackendFeature } from '../types.js';
import { registerCampaignJourneysRoutes } from './routes.js';
import { buildCampaignJourneysSurface } from './surface.js';

export const campaignJourneysFeature: BackendFeature = {
  id: 'campaign-journeys',
  registerRoutes: (deps) => {
    registerCampaignJourneysRoutes(deps);
    registerJourneyExperimentSurface(); // ADR 0949 P3b — the `journey.split` experiment adapter
  },
  surface: { id: 'campaign-journeys', build: buildCampaignJourneysSurface },
  requiredPacks: [
    'feature.campaign-journeys.nodes',
  ],
  toggleDefault: {
    id: 'campaign-journeys',
    label: 'Campaign Journeys',
    description:
      'Contact-level lifecycle automation as workflow chains — welcome series, re-engagement, and any flow you bind to a CRM or campaign event. One enrollment per contact per journey (no double-sends), every send gated by consent + suppression. Journeys run on the workflow engine: monitor them in Runs, approve steps in the Approvals inbox.',
    category: 'Customer Data Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-journeys',
  },
  // ADR 0955 D1 — `campaign-ops` owns `ClientAccount`, which decides whose client an
  // enrollment is. Advisory (`recommends`), never a `dependsOn` disable-lock: with
  // campaign-ops off the client store still answers (no client ⇒ workspace keys, ADR 0222).
  recommends: ['crm', 'email', 'consent', 'campaign-ops'],
  // ADR 0955 D4 / ADR 0941 D5 — journey SMS sends are a capability inside this feature:
  // a sub-toggle, AND-gated in code with `campaign-journeys` and `consent` (`smsSend.ts`).
  // The STOP observer and the SMS exit guard are never gated by it.
  extraToggleDefaults: [{
    id: 'campaign-journeys.sms',
    label: 'Journey SMS sends',
    description: 'Let lifecycle journeys send marketing SMS: inside each client\'s send window, only to people who opted in to texts, from the client\'s own number. Replies of STOP are honoured whether this is on or off.',
    category: 'Customer Data Platform',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-journeys.sms',
  }],
};
