/**
 * CRM — the first full product feature on the feature-package contract
 * (ADR 0001 §4). Backend half: contacts + triage routes, a `crm` toggle default
 * (off; tenant-bucketed since CRM is a shared B2B surface — ADR §3.3), and its
 * `feature.crm.*` packs declared for the boot install set.
 *
 * The toggle default ships an A/B split whose variants bind to the two triage
 * nodes the pack provides; an admin re-administers weights/bindings live in the
 * Feature toggles screen (ADR §3.5).
 *
 * Default status: `on` (ADR 0191 correction). Originally shipped `off` per the
 * ADR §6 migration plan ("a brand-new feature ships off"). Reversed once the
 * ADR 0149 `core.openwop.workflows.lighthouse` templates — installed by default
 * on this reference app — were found to hard-fail at runtime because they read
 * `ctx.features.crm`, which the off default gated. The reference app now ships
 * these product surfaces `on` so the bundled templates resolve out of the box;
 * the A/B split is preserved (`on` + variants ⇒ enabled, split traffic). An
 * operator can still turn it off per-tenant in the Feature toggles screen.
 */

import type { BackendFeature } from '../types.js';
import { registerCrmRoutes } from './routes.js';
import { registerCrmOrgRoutes } from './orgRoutes.js';
import { registerCrmBookingRoutes } from './bookingRoutes.js';
import { registerCrmSignRoutes } from './signRoutes.js';
import { registerGmailSyncRoutes } from './gmailSyncRoutes.js';
import { buildCrmSurface } from './surface.js';
import { registerCrmApprovalHandlers } from './contactMergeApproval.js';
import { registerCrmFormsSink } from './formsSubmissionSink.js';
import { registerCrmAgentTools } from './agentTools.js';
import { onConnectionRevoked, onConnectionStatusChanged } from '../../host/connectionLifecycle.js';
import { markGmailSyncsNeedsReconsent, pauseGmailSyncsForRevokedConnection, resumeGmailSyncsForReconsentedConnection } from './gmailSyncService.js';
import { registerCrmErasure } from './erasure.js';

export const crmFeature: BackendFeature = {
  id: 'crm',
  // ADR 0439 gap GATE-3 / ADR 0446 [2] soft-read: crm's sign + booking services
  // fail-SOFTLY over these toggleable features via `await import()` in try/catch
  // with a `log.warn` fallback (`signService.ts` → `commerce` quote-render +
  // `documents` render; `signTargets.ts` → both). They are NOT `dependsOn` — crm
  // works with them off (that would be a lock crm doesn't need) — so this is an
  // ADVISORY recommendation (surfaced as a toggle-panel hint, no lock/build/map
  // effect). `sharing`/`media` are also soft-imported but always-on, so listing
  // them would be vacuous; only the toggleable targets belong here.
  recommends: ['commerce', 'documents'],
  registerRoutes: (deps) => {
    registerCrmRoutes(deps); // preserved tenant-scoped contacts + triage (ADR 0001 §4)
    registerCrmOrgRoutes(deps); // org-scoped companies/deals/pipelines + RBAC (ADR 0008)
    registerCrmBookingRoutes(deps); // public booking links + slot claim (ADR 0402 §a)
    registerCrmSignRoutes(deps); // native click-to-sign e-signature (ADR 0402 §b)
    registerGmailSyncRoutes(deps); // Gmail inbox → CRM activity sync opt-in (ADR 0252 P1)
    registerCrmApprovalHandlers(); // ADR 0264 / CDP-B — steward contact-merge decide hook
    registerCrmFormsSink(); // ADR 0330 §D1 — the `crm-contact` forms submission sink (crm → forms)
    registerCrmAgentTools(); // CFP-1 — sales-ops + segment-author chat tools over ctx.features.crm (ADR 0308 D2)
    registerCrmErasure(); // CRM-2 — ADR 0464 subject eraser + the email→contactId key resolver
    // ADR 0285 — pause (never delete) gmail syncs when their connection is
    // revoked; the status path also disables the scheduler job.
    onConnectionRevoked('crm-gmail-sync', async ({ tenantId, connectionId }) => {
      await pauseGmailSyncsForRevokedConnection(tenantId, connectionId);
    });
    // ADR 0627 D5 — a connection the broker flipped to `needs-reconsent` (a
    // failed refresh) marks its syncs the same, so the scheduler stops firing a
    // dead credential; a re-consent that revives the SAME row (→ `active`)
    // resumes them — re-consent IS the resume. Other transitions are not this
    // consumer's business.
    onConnectionStatusChanged('crm-gmail-sync', async ({ tenantId, connectionId, status }) => {
      if (status === 'needs-reconsent') await markGmailSyncsNeedsReconsent(tenantId, connectionId);
      else if (status === 'active') await resumeGmailSyncsForReconsentedConnection(tenantId, connectionId);
    });
  },
  // Face 2 (ADR 0014 Phase 4): `ctx.features.crm` — the second reference surface,
  // proving the FeatureModule pattern generalizes. Read-only org-scoped CRM reads.
  surface: { id: 'crm', build: buildCrmSurface },
  toggleDefault: {
    id: 'crm',
    label: 'CRM',
    description: 'Contacts + contact triage — sample product feature.',
    category: 'CRM',
    status: 'on', // ADR 0191 — default-on so the bundled lighthouse templates resolve OOTB
    bucketUnit: 'tenant',
    salt: 'crm',
    variants: [
      {
        key: 'basic',
        weight: 50,
        bindings: [{ slot: 'crm.triage', ref: { kind: 'node', name: 'feature.crm.nodes.triage', version: '1.0.0' } }],
      },
      {
        key: 'enriched',
        weight: 50,
        bindings: [{ slot: 'crm.triage', ref: { kind: 'node', name: 'feature.crm.nodes.triage-enriched', version: '1.0.0' } }],
      },
    ],
  },
  requiredPacks: [
    { name: 'feature.crm.nodes', version: '1.10.0' }, // v1.10.0 — ADR 0627 D1/D5: 13 write nodes role:"side-effect" + schemas, gmail-sync connection pin + typed outcomes; v1.9.0 ADR 0265 CDP-C persist-segment

    // Audit CRMGAP-FE-1b: the sales-ops agent must survive a requiredPacks-
    // filtered install (the CSM feature declares both packs; mirror it).
    { name: 'feature.crm.agents', version: '1.1.1' }, // v1.1.1 — CFP-1 real sales-ops + segment-author chat tools; v1.1.0 ADR 0265 CDP-C segment-author persona
  ],
};
