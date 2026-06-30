/**
 * CRM — the first full product feature on the feature-package contract
 * (ADR 0001 §4). Backend half: contacts + triage routes, a `crm` toggle default
 * (off; tenant-bucketed since CRM is a shared B2B surface — ADR §3.3), and its
 * `feature.crm.*` packs declared for the boot install set.
 *
 * The toggle default ships an A/B split whose variants bind to the two triage
 * nodes the pack provides; an admin re-administers weights/bindings live in the
 * Feature toggles screen (ADR §3.5). Default status is `off` — the superadmin
 * turns it on per the migration plan (ADR §6, "seed existing surfaces as on"
 * applies to pre-existing surfaces; a brand-new feature ships off).
 */

import type { BackendFeature } from '../types.js';
import { registerCrmRoutes } from './routes.js';
import { registerCrmOrgRoutes } from './orgRoutes.js';
import { buildCrmSurface } from './surface.js';

export const crmFeature: BackendFeature = {
  id: 'crm',
  registerRoutes: (deps) => {
    registerCrmRoutes(deps); // preserved tenant-scoped contacts + triage (ADR 0001 §4)
    registerCrmOrgRoutes(deps); // org-scoped companies/deals/pipelines + RBAC (ADR 0008)
  },
  // Face 2 (ADR 0014 Phase 4): `ctx.features.crm` — the second reference surface,
  // proving the FeatureModule pattern generalizes. Read-only org-scoped CRM reads.
  surface: { id: 'crm', build: buildCrmSurface },
  toggleDefault: {
    id: 'crm',
    label: 'CRM',
    description: 'Contacts + contact triage — sample product feature.',
    category: 'Business Tools',
    status: 'off',
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
  requiredPacks: [{ name: 'feature.crm.nodes', version: '1.1.0' }],
};
