/**
 * Forms feature (ADR 0017 + ADR 0330) — the app's standalone capture
 * primitive. An authed org-scoped builder + a PUBLIC submit; destination
 * effects run through the submission-sink seam (`submissionSinks.ts`) that
 * integrator features register at boot (CRM's `crm-contact` sink creates a
 * contact when the tenant's `crm` toggle is on — forms imports no destination
 * feature). Also extends the core app: a `ctx.features.forms` read surface
 * (ADR 0014) + `feature.forms.{nodes,agents}`, all gated by the SAME `forms`
 * toggle. Off by default (a new product surface).
 */

import type { BackendFeature } from '../types.js';
import { registerFormsRoutes } from './routes.js';
import { buildFormsSurface } from './surface.js';
import { registerFormsAgentTools } from './agentTools.js';
import { registerFormsErasure } from './erasure.js';

export const formsFeature: BackendFeature = {
  id: 'forms',
  registerRoutes: (deps) => {
    registerFormsRoutes(deps);
    // CFP-1 — the Forms Lead Insights agent's real read tools (list-forms /
    // list-submissions). Process-wide + inert until the pack allowlists the ids;
    // per-tenant toggle honesty lives inside each tool's run().
    registerFormsAgentTools();
    // FORM-1 (ADR 0584) — the ADR 0464 subject eraser over `forms:submission`.
    // Registered here, beside the routes, so it is armed on every boot that can
    // serve a submit: a store that can be WRITTEN by the public must be
    // ERASABLE in the same process.
    registerFormsErasure();
  },
  // Face 2 (ADR 0014): `ctx.features.forms` — a thin tenant-guarded read surface
  // over formsService that backs the feature.forms.nodes pack.
  surface: { id: 'forms', build: buildFormsSurface },
  toggleDefault: {
    id: 'forms',
    label: 'Forms',
    description: 'Form builder + submission inbox — compose CRM, pages, and funnels optionally.',
    category: 'Author',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'forms',
  },
  requiredPacks: [
    { name: 'feature.forms.nodes', version: '1.2.0' }, // ADR 0584 §Correction: get-submission emits `flagged` + `route` (FORM-QUAR-1 / WF-FORM-5)
    { name: 'feature.forms.agents', version: '1.1.1' }, // ADR 0330 CRM-optional persona; CFP-1 real read tools
  ],
  // ADR 0330 — no `dependsOn`: forms is a standalone capture primitive. The
  // CRM contact write is an optional destination registered by crm itself
  // (`crm/formsSubmissionSink.ts`), gated at call time on the tenant's `crm`
  // toggle — so disabling CRM no longer needs a disable-lock here.
};
