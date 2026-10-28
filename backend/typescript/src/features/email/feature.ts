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
import { setTransactionalEmailTransport } from '../../host/transactionalEmail.js';
import { sendBrokeredTransactionalEmail } from './brokeredProvider.js';
import { registerEmailPlaybookContent } from './playbookContent.js';

export const emailFeature: BackendFeature = {
  id: 'email',
  registerRoutes: (deps) => {
    registerEmailPlaybookContent(); // ADR 0959 D5 — this feature owns its playbook content kind
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
    // ADR 0905 D6 — the transactional transport, owned here (it was wired from
    // commerce, a cross-feature import). Toggle-independent like the egress guard:
    // transactional mail is not a marketing capability. It rides the ADR 0193
    // brokered spine (the acting human's Connection + the org's sender address +
    // the ONE sent-ledger); no context / connection / sender ⇒ `false`, the seam's
    // documented honest no-op. Tests may inject a mock (last writer wins).
    setTransactionalEmailTransport(async (email) => {
      if (!email.context) return false;
      return sendBrokeredTransactionalEmail({
        storage: deps.storage,
        tenantId: email.context.tenantId,
        orgId: email.context.orgId,
        actingUserId: email.context.actingUserId,
        to: email.to, subject: email.subject, text: email.text,
        ...(email.context.idempotencyKey ? { idempotencyKey: email.context.idempotencyKey } : {}),
      });
    });
  },
  // Face 2 (ADR 0014): `ctx.features.email` — a thin read surface (templates) that
  // backs the feature.email.nodes pack + the copywriter agent.
  // ADR 0848 D2 — `createDraftCampaign` WRITES a template + a campaign; its HTTP twin is
  // `workspace:write`, so the ADR 0832 floor holds a run to the same tier. The three
  // reads keep the default `workspace:read`.
  surface: { id: 'email', build: buildEmailSurface, orgPolicy: { methodScopes: { createDraftCampaign: 'workspace:write', submitForReview: 'workspace:write' } } },
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
  }, {
    // ADR 0955 D7 / ADR 0941 D5 — a sub-toggle of email (dotted id). A RESTRICTION: on refuses a
    // marketing broadcast from a domain without SPF and DMARC (`senderAuth.ts`).
    id: 'email.sender-auth',
    label: 'Require sender domain authentication',
    description: 'Refuse a marketing email campaign when the sending domain does not publish SPF and DMARC records. Mailbox providers reject or junk mail without them. (DKIM is checked by your email provider, not here.)',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'email.sender-auth',
  }, {
    // ADR 0955 D7 (P4b) — a RESTRICTION: a new sender's marketing volume grows along a ramp
    // (`OPENWOP_EMAIL_WARMUP_RAMP`); over the day's ceiling a campaign continues tomorrow.
    id: 'email.warmup',
    label: 'Warm up new senders',
    description: 'Cap how many marketing emails a new sender sends each day, rising over its first weeks, so mailbox providers learn to trust the domain. Over the ceiling, a campaign continues the next day; nothing is dropped.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'email.warmup',
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
