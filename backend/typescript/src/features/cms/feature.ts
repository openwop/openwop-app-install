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
import { registerCmsExperimentStampResolver } from './pageExperimentsService.js';
import { registerCmsRoutes } from './routes.js';
import { registerContentProtocolRoutes } from './contentProtocolRoutes.js';
import { registerCmsErasure } from './erasure.js';
import { registerPageExperimentRoutes } from './pageExperimentsRoutes.js';
import { registerToggleDefault } from '../../host/featureToggles/registry.js';
import { buildCmsSurface } from './surface.js';
import { registerContentApprovalGate } from './contentApproval.js';
import { registerCmsAgentTools } from './agentTools.js';
import { startCmsPublishSweep } from './publishSweep.js';

export const cmsFeature: BackendFeature = {
  id: 'cms',
  // ADR 0064 Phase 3 — `ctx.features.cms` read surface: workflow nodes fetch a
  // published page resolved for a target locale (the `feature.cms.nodes` pack
  // calls this; AI translation stays in the node, not the surface).
  surface: { id: 'cms', build: buildCmsSurface },
  // ADR 0064 Phase 3 + ADR 0204 C6 — the node pack over ctx.features.cms (reads
  // + the governed draft/submit write verbs) and the localizer/content-editor
  // agents tool-allowlisted to those nodes. Declared here so featurePackRefs()
  // installs them at boot (Phase 0) and the eager agent loader registers them.
  requiredPacks: [
    { name: 'feature.cms.nodes', version: '1.5.0' },
    { name: 'feature.cms.agents', version: '1.1.1' },
  ],
  registerRoutes: (deps) => {
    // R3 (UX_UPGRADE-content known-open) — DSAR erasure; registered with the
    // routes (the documents/media precedent) so a tenant that used CMS is erasable.
    registerCmsErasure();
    registerCmsRoutes(deps);
    // ADR 0748 — RFC 0103 §D `/v1/content/*` (delivery + admin ops) over the
    // same kernel rows; the one owner of that path space.
    registerContentProtocolRoutes(deps.app);
    // CFP-1 (CHAT-FIRST-PORT-AUDIT #1) — the localizer/content-editor agents'
    // REAL conversational tools (`openwop:cms.<verb>`), registered on the ONE
    // `registerFeatureAgentTool` seam so the pack's allowlist resolves at
    // dispatch. Same `ctx.features.cms` owner as the node pack + the org-RBAC
    // gate the editor routes enforce; DRAFT/SUBMIT only, never publish.
    registerCmsAgentTools();
    // ADR 0236 (campaign gap D1) — visitor-scoped page experiments over the
    // existing PageVersion store; assignment happens on the publishing public
    // read (consent-gated), results project over stamped analytics events.
    registerPageExperimentRoutes(deps);
    registerCmsExperimentStampResolver(); // ANLWF-3 / ADR 0651 D3
    // ADR 0204 C2 — the scheduled-publish sweep (retention-daemon pattern;
    // idempotent start, minute tick, per-(page,time) idempotency claim).
    startCmsPublishSweep();
    // ADR 0066 — register the content-publish decision handler on the core
    // approvals hook (the inbox claim/reject path dispatches here for
    // `kind:'content-publish'` rows). Direction: feature → core only.
    registerContentApprovalGate();
    // ADR 0066 — interrupt-backed editorial approval (opt-in).
    //
    // CORRECTED 2026-08-21 (ADR 0593 / CMSA-5 / CMSAWF-4): this comment and the
    // description below both described the PRE-C1 semantics, which
    // `cms-approval-gate.test.ts:90` explicitly falsifies. `submit` queues the
    // shared row UNDER BOTH TOGGLE STATES; the decide path is toggle-independent.
    // What the toggle gates is the direct-publish BYPASS — publish, schedule, an
    // in-place PATCH of a published page, and (ADR 0593 D1) a shared-section
    // edit that would rewrite a published/in-review page. Distinct id from
    // `cms-localization`.
    registerToggleDefault({
      id: 'cms-approval-gate',
      label: 'CMS editorial approval gate',
      description: 'Gate CMS publishing on a human approval in the Approvals inbox (ADR 0066). Submitting for review always queues an approval; this toggle decides whether an admin may bypass it by publishing, scheduling, or editing live content directly.',
      category: 'Content',
      status: 'off',
      bucketUnit: 'tenant',
      salt: 'cms-approval-gate-v1',
    });
    // ADR 0064 — CMS is always-on, but its NEW localization capability is opt-in.
    // This toggle (default OFF) gates the per-org language-settings WRITE (and the
    // FE locale editor). Distinct id (`cms-localization`, NOT the retired `cms` toggle).
    //
    // CORRECTED (ADR 0668 D4) — this used to read "OFF ⇒ no authored locales ⇒ delivery
    // byte-identical", which asserts that OFF IMPLIES no authored locales. It does not: a
    // workspace can author overlays and then flip this off, and delivery keeps serving them
    // because no delivery path reads this toggle. The byte-identical claim holds only for a
    // workspace that never authored a locale.
    registerToggleDefault({
      id: 'cms-localization',
      label: 'CMS content localization',
      // ADR 0668 D4 (CMSLWF-16) — this used to read "Per-locale content overrides +
      // Accept-Language delivery for CMS pages", which advertises DELIVERY as something the
      // toggle controls. It does not: MEASURED, all seven `cms-localization` reads are on
      // authoring/admin routes, and no delivery path reads the toggle at all. An operator
      // who flipped this OFF expecting Spanish to stop being served would have been misled
      // by the copy they read at the moment of the decision.
      description: 'Authoring for per-locale content overrides on CMS pages (ADR 0064) — the settings, the translator grants and the AI translate action. Delivery is NOT gated: pages that already carry authored overlays keep serving them under Accept-Language when this is OFF. To stop serving a locale, withhold it per page or remove its overlays.',
      category: 'Content',
      status: 'off',
      bucketUnit: 'tenant',
      salt: 'cms-localization-v1',
    });
    // ADR 0408 D2 — the `blocks` extension kind registers at cmsService
    // MODULE SCOPE (not here): the kernel page store needs it wherever
    // cmsService loads — bare-harness tests and the boot migration included.
  },
};
