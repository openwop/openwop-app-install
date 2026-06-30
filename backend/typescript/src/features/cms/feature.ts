/**
 * CMS + Page Builder (ADR 0009). Org-scoped pages with typed sections, an
 * RBAC editorial workflow, versions, and slug redirects. Section assets are
 * Media-Library tokens (ADR 0007).
 *
 * ALWAYS-ON (ADR 0027): no `toggleDefault` — CMS is core content tooling (the
 * front page composes it), so it is retired from the toggle catalog like
 * Notifications (ADR 0010 § Correction). Routes keep their org-scoped RBAC gate
 * (`requireOrgScope`); only the toggle gate is gone.
 */

import type { BackendFeature } from '../types.js';
import { registerCmsRoutes } from './routes.js';
import { registerToggleDefault } from '../../host/featureToggles/registry.js';
import { buildCmsSurface } from './surface.js';
import { registerContentApprovalGate } from './contentApproval.js';

export const cmsFeature: BackendFeature = {
  id: 'cms',
  // ADR 0064 Phase 3 — `ctx.features.cms` read surface: workflow nodes fetch a
  // published page resolved for a target locale (the `feature.cms.nodes` pack
  // calls this; AI translation stays in the node, not the surface).
  surface: { id: 'cms', build: buildCmsSurface },
  // ADR 0064 Phase 3 — the node pack over ctx.features.cms (get-page +
  // translate-section) and the localizer agent tool-allowlisted to those nodes.
  // Declared here so featurePackRefs() installs them at boot (Phase 0) and the
  // eager agent loader registers the agent.
  requiredPacks: [
    { name: 'feature.cms.nodes', version: '1.1.0' },
    { name: 'feature.cms.agents', version: '1.0.0' },
  ],
  registerRoutes: (deps) => {
    registerCmsRoutes(deps);
    // ADR 0066 — register the content-publish decision handler on the core
    // approvals hook (the inbox claim/reject path dispatches here for
    // `kind:'content-publish'` rows). Direction: feature → core only.
    registerContentApprovalGate();
    // ADR 0066 — interrupt-backed editorial approval (opt-in). When ON, `submit`
    // queues a content-publish approval in the shared ApprovalsInbox and the
    // direct `approve` route defers to it; OFF ⇒ editorial workflow byte-identical
    // (status-only, direct approve works). Distinct id from `cms-localization`.
    registerToggleDefault({
      id: 'cms-approval-gate',
      label: 'CMS editorial approval gate',
      description: 'Gate CMS publish on a human approval surfaced in the Approvals inbox (ADR 0066). OFF ⇒ status-only workflow.',
      category: 'Content',
      status: 'off',
      bucketUnit: 'tenant',
      salt: 'cms-approval-gate-v1',
    });
    // ADR 0064 — CMS is always-on, but its NEW localization capability is opt-in.
    // This toggle (default OFF) gates the per-org language-settings WRITE (and the
    // FE locale editor). OFF ⇒ no authored locales ⇒ delivery byte-identical to
    // the non-localized CMS. Distinct id (`cms-localization`, NOT the retired
    // `cms` toggle).
    registerToggleDefault({
      id: 'cms-localization',
      label: 'CMS content localization',
      description: 'Per-locale content overrides + Accept-Language delivery for CMS pages (RFC 0103 / ADR 0064).',
      category: 'Content',
      status: 'off',
      bucketUnit: 'tenant',
      salt: 'cms-localization-v1',
    });
  },
};
