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
import { registerEmailFormsConsentSink } from './formsConsentSink.js';
import { registerEmailAgentTools } from './agentTools.js';
import { buildEmailSurface } from './surface.js';

export const emailFeature: BackendFeature = {
  id: 'email',
  registerRoutes: (deps) => {
    registerEmailRoutes(deps);
    // ADR 0655 D1 — arm the recipient egress guard on the host seam. Toggle-
    // independent: a refusal floor for every lane, not a feature capability.
    registerEmailEgressGuard();
    registerEmailFormsConsentSink(); // ADR 0338 §D2 — the `email-consent` forms sink (email → forms)
    // CFP-1 — the copywriter agent's REAL chat tools (get-campaign / save-draft),
    // gated like the routes; replaces the node-typeId allowlist the loop dropped.
    registerEmailAgentTools();
  },
  // Face 2 (ADR 0014): `ctx.features.email` — a thin read surface (templates) that
  // backs the feature.email.nodes pack + the copywriter agent.
  surface: { id: 'email', build: buildEmailSurface },
  toggleDefault: {
    id: 'email',
    label: 'Email Marketing',
    description: 'Templated campaigns over CRM contacts, consent-gated marketing sends — product feature.',
    category: 'CRM',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'email',
  },
  requiredPacks: [
    { name: 'feature.email.nodes', version: '1.2.0' },
    { name: 'feature.email.agents', version: '1.0.1' },
  ],
  // ADR 0194 — a hard dependency: campaigns resolve their audience live from CRM
  // contacts (`crmService`), so Email Marketing has no audience without CRM. The
  // disable-lock blocks turning `crm` off while `email` is enabled.
  dependsOn: ['crm'],
  recommends: ['consent'], // ADR 0655 D9 (EM-20)
};
