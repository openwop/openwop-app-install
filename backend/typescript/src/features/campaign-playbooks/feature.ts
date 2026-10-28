/**
 * Campaign playbooks (ADR 0959) — an agency publishes a campaign method once as a versioned
 * playbook (workflow chains + default values + which values a client may change) and installs
 * it per client. P0: drafts, immutable published versions, the one-client install, and the run
 * stamp naming which version made a run. Host extension, no RFC, nothing advertised.
 *
 * @see docs/adr/0959-agency-playbooks-and-governed-rollout.md
 */
import type { BackendFeature } from '../types.js';
import { registerRunStartContributor } from '../../host/runStartContext.js';
import { registerCampaignPlaybooksRoutes, CAMPAIGN_PLAYBOOKS_TOGGLE } from './routes.js';
import { registerCampaignPlaybooksErasure } from './erasure.js';
import { playbookRunStampContributor } from './runStamp.js';
import { registerPlaybookRolloutApproval } from './rolloutService.js';
import { buildCampaignPlaybooksSurface } from './surface.js';

export const campaignPlaybooksFeature: BackendFeature = {
  id: CAMPAIGN_PLAYBOOKS_TOGGLE,
  // ADR 0439 — a dependency is an import. campaign-ops' client authorization is imported;
  // campaign-orchestration is not (nothing in P0 calls it), so it is a recommendation.
  dependsOn: ['campaign-ops'],
  registerRoutes: (deps) => {
    registerCampaignPlaybooksErasure();
    registerRunStartContributor(playbookRunStampContributor);
    registerPlaybookRolloutApproval(); // ADR 0959 D7 — the `playbook-rollout` decide handler
    registerCampaignPlaybooksRoutes(deps);
  },
  surface: { id: CAMPAIGN_PLAYBOOKS_TOGGLE, build: buildCampaignPlaybooksSurface },
  requiredPacks: ['feature.campaign-playbooks.nodes'],
  toggleDefault: {
    id: CAMPAIGN_PLAYBOOKS_TOGGLE,
    label: 'Campaign playbooks',
    description:
      'Publish a campaign method once as a versioned playbook and install it for each client. Each client keeps its own values for the settings the playbook lets it change, and every run records which playbook version produced it.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaign-playbooks',
  },
  recommends: ['campaign-orchestration', 'environments', 'evals'],
};
