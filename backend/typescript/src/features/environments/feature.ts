/**
 * Environments feature-package (ADR 0387) — per-tenant config promotion +
 * rollback + history over content-hashed snapshots. Registers its two v1 config
 * domains through the `registerConfigDomain` inversion seam at boot (the owner
 * self-registers; environments never imports a config owner's internals).
 *
 * @see docs/adr/0387-environments-promotion-rollback.md
 */
import type { BackendFeature } from '../types.js';
import { registerConfigDomain } from '../../host/configDomains.js';
import { registerEnvironmentsRoutes } from './routes.js';
import { featureTogglesDomain } from './domains/featureTogglesDomain.js';
import { publishPointersDomain } from './domains/publishPointersDomain.js';
import { workflowPinsDomain } from './domains/workflowPinsDomain.js';
import { registerEnvironmentsErasure } from './erasure.js';
import type { ConfigDomain } from '../../host/configDomains.js';

/** The config domains this feature contributes through the `registerConfigDomain`
 *  seam (ADR 0387 D2; the seam grows — v2 adds connection-refs + workflow-template
 *  pins). Exported as the SINGLE source of truth so the ENVC-8 secret-safety scan
 *  (`test/env-secret-safety.test.ts`) enrolls EVERY domain the feature boots: add a
 *  v2 connection-ref domain to THIS array and it is auto-registered AND auto-scanned
 *  for leaked secret VALUES — no second list to keep in sync. */
export const ENVIRONMENTS_CONFIG_DOMAINS: readonly ConfigDomain[] = [
  featureTogglesDomain,
  publishPointersDomain,
  // ADR 0479 — the reserved v2 contributor: workflow publish pins over the ADR 0474 revision handle.
  workflowPinsDomain,
];

export const environmentsFeature: BackendFeature = {
  id: 'environments',
  registerRoutes: (deps) => {
    registerEnvironmentsRoutes(deps);
    for (const domain of ENVIRONMENTS_CONFIG_DOMAINS) registerConfigDomain(domain);
    // ENV2-B1 — subject erasure. Registered HERE so it is greppable from the
    // feature definition and a test can assert it was WIRED, not merely written.
    registerEnvironmentsErasure();
  },
  toggleDefault: {
    id: 'environments',
    label: 'Environments',
    description: 'Per-tenant config promotion, rollback, and history over content-hashed snapshots (ADR 0387).',
    category: 'Admin',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'environments',
  },
};
