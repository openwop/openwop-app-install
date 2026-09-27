/**
 * Custom domains (ADR 0295 / Funnel B) — serve published content (pages,
 * funnels, the storefront) on a tenant's own hostname. This feature is the
 * MANAGEMENT surface (toggle + authed routes); the host guard middleware, the
 * DNS-TXT verification, and the re-check sweep are core-owned
 * (`host/customDomains.ts`, `middleware/customDomain.ts`). TLS + routing for
 * the domain are the platform proxy tier (GCLB certificate-map — the pinned
 * option A; operator recipe in DEPLOY.md). Host-extension — no RFC.
 *
 * @see docs/adr/0295-funnel-b-custom-domain-hosting.md
 */
import type { BackendFeature } from '../types.js';
import { registerCustomDomainsRoutes } from './routes.js';
import { startCustomDomainSweep } from '../../host/customDomains.js';

export const customDomainsFeature: BackendFeature = {
  id: 'custom-domains',
  registerRoutes: (deps) => {
    registerCustomDomainsRoutes(deps);
    // Revocation-on-DNS-change: live domains are periodically re-verified
    // (a clean negative demotes to failed; resolver noise never does).
    startCustomDomainSweep();
  },
  toggleDefault: {
    id: 'custom-domains',
    label: 'Custom domains',
    description: 'Serve published pages, funnels, and the storefront on your own hostname (Funnel B / ADR 0295).',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'custom-domains',
  },
};
