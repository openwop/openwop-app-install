/**
 * Email Marketing feature (ADR 0019) — the ENGAGE leg. Templates + campaigns over
 * CRM contacts (audience resolved live), consent-gated marketing sends through a
 * stub provider, plus a `ctx.features.email` read surface (ADR 0014) +
 * `feature.email.{nodes,agents}`, all behind the same `email` toggle, and six
 * unauthenticated PUBLIC endpoints (unsubscribe / preferences / pixel / click /
 * bounce webhooks — see routes.ts). Off by default. `consent` is RECOMMENDED,
 * not required: with it off the marketing consent gate is permissive (EM-20).
 */

import type { BackendFeature } from '../types.js';
import { registerEmailRoutes } from './routes.js';
import { registerEmailEgressGuard } from './egressGuard.js';
import { registerChainEmailSenderLookup } from '../../host/chainEmailPolicy.js';
import { listVerifiedSenders } from './emailService.js';
import { registerEmailFormsConsentSink } from './formsConsentSink.js';
import { registerEmailAgentTools } from './agentTools.js';
import { buildEmailSurface } from './surface.js';
import { registerEmailSendApprovalGate } from './sendApproval.js';

export const emailFeature: BackendFeature = {
  id: 'email',
  registerRoutes: (deps) => {
    registerEmailRoutes(deps);
    // ADR 0655 D1 — arm the recipient egress guard on the host seam. Toggle-
    // independent: a refusal floor for every lane, not a feature capability.
    registerEmailEgressGuard();
    // ADR 0895 D1 — the chain lane's `from` binds to these senders. Toggle-independent
    // for the same reason: a configured sender is an operator statement.
    registerChainEmailSenderLookup(listVerifiedSenders);
    registerEmailFormsConsentSink(); // ADR 0338 §D2 — the `email-consent` forms sink (email → forms)
    // CFP-1 — the copywriter agent's REAL chat tools (get-campaign / save-draft),
    // gated like the routes; replaces the node-typeId allowlist the loop dropped.
    registerEmailAgentTools();
    // ADR 0905 D3 — the `email-campaign-send` decide handler on the core approvals hook
    // (the inbox claim/reject path dispatches here). Direction: feature → core only.
    registerEmailSendApprovalGate();
  },
  // Face 2 (ADR 0014): `ctx.features.email` — a thin read surface (templates) that
  // backs the feature.email.nodes pack + the copywriter agent.
  // ADR 0848 D2 — `createDraftCampaign` WRITES a template + a campaign; its HTTP twin is
  // `workspace:write`, so the ADR 0832 floor holds a run to the same tier. The three
  // reads keep the default `workspace:read`.
  surface: { id: 'email', build: buildEmailSurface, orgPolicy: { methodScopes: { createDraftCampaign: 'workspace:write' } } },
  toggleDefault: {
    id: 'email',
    label: 'Email Marketing',
    description: 'Templated campaigns over CRM contacts, consent-gated marketing sends — product feature.',
    category: 'CRM',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'email',
  },
  // ADR 0905 D4 — a sub-toggle (ADR 0404 §P4), AND-gated with `email`. The review queue
  // is always available; this decides whether a campaign may be SENT without an
  // approval. Default OFF: turning it on silently would block every live sender's next
  // campaign. Same semantics as `cms-approval-gate`.
  extraToggleDefaults: [{
    id: 'email-approval-gate',
    label: 'Email send approval gate',
    description: 'Require an approval in the Approvals inbox before an email campaign is sent. Submitting a campaign for review always works; this toggle decides whether a campaign may be sent without one.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'email-approval-gate-v1',
  }],
  requiredPacks: [
    'feature.email.nodes',
    'vendor.openwop-app.email.agents',
  ],
  // ADR 0194 — a hard dependency: campaigns resolve their audience live from CRM
  // contacts (`crmService`), so Email Marketing has no audience without CRM. The
  // disable-lock blocks turning `crm` off while `email` is enabled.
  dependsOn: ['crm'],
  recommends: ['consent'], // ADR 0655 D9 (EM-20)
};
