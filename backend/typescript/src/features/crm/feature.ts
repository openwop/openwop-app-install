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
 *
 * CORRECTED 2026-10-14 (ADR 0892): the default is `off` again. CRM is an opt-in
 * bundle, so a white-label install does not show the CRM group until an operator
 * enables it (Admin → Feature toggles; workspace self-enable is ADR 0892 Phase B).
 * The lighthouse templates no longer crash with CRM off: ADR 0191 Phase 2's
 * preflight names the missing feature before a run. App migration 23 keeps CRM
 * on for any install that already has CRM contacts or an enabled CRM dependent.
 */

import type { BackendFeature } from '../types.js';
import { registerCrmRoutes } from './routes.js';
import { registerCrmOrgRoutes } from './orgRoutes.js';
import { registerCrmBookingRoutes } from './bookingRoutes.js';
import { registerCrmSignRoutes } from './signRoutes.js';
import { registerGmailSyncRoutes } from './gmailSyncRoutes.js';
import { buildCrmSurface, CRM_SURFACE_POLICY } from './surface.js';
import { registerCrmApprovalHandlers } from './contactMergeApproval.js';
import { registerCrmFormsSink } from './formsSubmissionSink.js';
import { registerCrmAgentTools } from './agentTools.js';
import { onConnectionRevoked, onConnectionStatusChanged } from '../../host/connectionLifecycle.js';
import { markGmailSyncsNeedsReconsent, pauseGmailSyncsForRevokedConnection, registerGmailSyncWorkflowFeature, resumeGmailSyncsForReconsentedConnection } from './gmailSyncService.js';
import { registerCrmErasure } from './erasure.js';
import { registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';
import { CRM_TRIAGE_WORKFLOW_ID } from './triageDispatch.js';
import { registerFeatureDataExporter } from '../../host/featureDataExport.js';
import { exportCrmData } from './dataExport.js';

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
    registerGmailSyncWorkflowFeature(); // ADR 0820 §7 / G6
    registerCrmRoutes(deps); // preserved tenant-scoped contacts + triage (ADR 0001 §4)
    registerCrmOrgRoutes(deps); // org-scoped companies/deals/pipelines + RBAC (ADR 0008)
    registerCrmBookingRoutes(deps); // public booking links + slot claim (ADR 0402 §a)
    registerCrmSignRoutes(deps); // native click-to-sign e-signature (ADR 0402 §b)
    registerGmailSyncRoutes(deps); // Gmail inbox → CRM activity sync opt-in (ADR 0252 P1)
    registerCrmApprovalHandlers(); // ADR 0264 / CDP-B — steward contact-merge decide hook
    registerCrmFormsSink(); // ADR 0330 §D1 — the `crm-contact` forms submission sink (crm → forms)
    registerCrmAgentTools(); // CFP-1 — sales-ops + segment-author chat tools over ctx.features.crm (ADR 0308 D2)
    registerCrmErasure(); // CRM-2 — ADR 0464 subject eraser + the email→contactId key resolver
    registerFeatureDataExporter('crm', exportCrmData); // ADR 0820 §7 — read-only export, served after a plan lapse
    // ADR 0837 D7 — the Triage action's workflow, SAME-ID chain-backed (the
    // career.campaign precedent): the route launches it by this stable id on every
    // instance, and the chain stays gallery-visible (a from-chain copy is editable,
    // under its own id the button does not launch).
    registerChainBackedWorkflow(CRM_TRIAGE_WORKFLOW_ID, { featureId: 'crm' });
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
  // proving the FeatureModule pattern generalizes. ADR 0837 D2 — the writers ask
  // what their HTTP doors ask (see CRM_SURFACE_POLICY).
  surface: { id: 'crm', build: buildCrmSurface, orgPolicy: CRM_SURFACE_POLICY },
  toggleDefault: {
    id: 'crm',
    label: 'CRM',
    description: 'Contacts + contact triage — sample product feature.',
    category: 'CRM',
    // ADR 0892 — CRM is an opt-in bundle: OFF by default, so a white-label install
    // starts without the CRM group. Supersedes ADR 0191 Phase 1 (default-on); the
    // ADR 0191 Phase 2 preflight now tells a lighthouse template user CRM is needed.
    // Installs that already use CRM are kept on by app migration 23.
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'crm',
    variants: [
      {
        key: 'basic',
        weight: 50,
        bindings: [{ slot: 'crm.triage', ref: { kind: 'node', name: 'feature.crm.nodes.triage', version: '1.1.0' } }],
      },
      {
        key: 'enriched',
        weight: 50,
        bindings: [{ slot: 'crm.triage', ref: { kind: 'node', name: 'feature.crm.nodes.triage-enriched', version: '1.0.0' } }],
      },
    ],
  },
  requiredPacks: [
    'feature.crm.nodes', // v1.11.0 — ADR 0837 D7: get-contact + record-triage, triage 1.1.0 takes the run's variant; v1.10.0 — ADR 0627 D1/D5: 13 write nodes role:"side-effect" + schemas, gmail-sync connection pin + typed outcomes; v1.9.0 ADR 0265 CDP-C persist-segment

    // Audit CRMGAP-FE-1b: the sales-ops agent must survive a requiredPacks-
    // filtered install (the CSM feature declares both packs; mirror it).
    'vendor.openwop-app.crm.agents', // v1.1.1 — CFP-1 real sales-ops + segment-author chat tools; v1.1.0 ADR 0265 CDP-C segment-author persona
  ],
};
