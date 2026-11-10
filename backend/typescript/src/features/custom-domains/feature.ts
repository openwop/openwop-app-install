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
import { startCustomDomainSweep } from '../../host/customDomainSweep.js';
import { DESIGNED_PAGES_TOGGLE, SITE_RUNTIME_TOGGLE } from '../../host/boundSite.js';

export const customDomainsFeature: BackendFeature = {
  id: 'custom-domains',
  registerRoutes: (deps) => {
    registerCustomDomainsRoutes(deps);
    // Revocation-on-DNS-change: live domains are periodically re-verified
    // (a clean negative demotes to failed; resolver noise never does).
    startCustomDomainSweep();
  },
  // ADR 1015 D4 — whether this workspace's custom-domain pages load the visitor
  // runtime (consent banner, beacons, heat, replay). Off ⇒ the page is the plain
  // prerender, byte-identical to before. Each capture keeps its own toggle,
  // consent and attestation gates; this adds no collection on its own.
  extraToggleDefaults: [{
    id: SITE_RUNTIME_TOGGLE,
    label: 'Visitor runtime on custom domains',
    description: 'Load the consent banner and the analytics, heat-map and session-replay capture on pages served from your own domain. Each capture still needs its own setting and the visitor\'s consent.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: SITE_RUNTIME_TOGGLE,
  }, {
    // ADR 1030 D4 — the designed look on your own domain. CSS only: no script.
    id: DESIGNED_PAGES_TOGGLE,
    label: 'Designed pages on custom domains',
    description: 'Give the pages served from your own domain the designed look (typography, cards, motion) instead of plain text. A stylesheet only; no script runs.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: DESIGNED_PAGES_TOGGLE,
  }],
  toggleDefault: {
    id: 'custom-domains',
    label: 'Custom domains',
    description: 'Serve published pages, funnels, and the storefront on your own hostname.',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'custom-domains',
  },
};
