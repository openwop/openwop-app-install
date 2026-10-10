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
//
// ADR 0819 §2 — `feature-toggles` is NOT a domain any more. Its payload was the
// tenant's per-tenant toggle OVERRIDES, which only the operator writes (the
// superadmin PUT, demo provisioning). As a domain, any holder of
// `host:members:manage` could restore it, so a workspace re-applying an old
// snapshot undid the operator's decision (restored a revoked `on`, deleted an
// `off`). Operator history lives in the toggle audit log (ADR 0819 §4). Old
// snapshots still carry the payload; apply skips unregistered domains and the
// diff reports registered domains only.
export const ENVIRONMENTS_CONFIG_DOMAINS: readonly ConfigDomain[] = [
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
    description: 'Per-tenant config promotion, rollback, and history over content-hashed snapshots.',
    category: 'Governance', // ADR 0820 §8.2 — sold in the Governance bundle
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'environments',
  },
};
