/**
 * ADR 0135 — Capability Firewall frontend feature. Appended to FRONTEND_FEATURES; the
 * admin rule-manager nav is always-on (toggle removed, 2026-06-24; admin-tier gated).
 * Lazy route-split (off the chat entry chunk).
 */
import { lazy } from 'react';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const FirewallRulesPage = lazy(() => import('./FirewallRulesPage.js').then((m) => ({ default: m.FirewallRulesPage })));

const routes: FeatureRoute[] = [
  {
    path: '/capability-firewall',
    element: <FirewallRulesPage />,
    tier: 'admin',
    // ADR 0144 §Correction (2026-06-26) — reached only via the always-on Access
    // Hub; no standalone nav. Route + hubTab stay (the hub renders the element).
    hubTab: { group: 'identity', order: 2 },
  },
];

export const capabilityFirewallFeature: FrontendFeature = { id: 'capability-firewall', routes };
