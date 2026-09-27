/**
 * Analytics feature (ADR 0018) — the MEASURE leg. A public beacon (consent-gated when the `consent` feature is enabled — PERMISSIVE by default, see ADR 0651 D4;
 * via ADR 0020) + authed org-scoped reporting, plus a `ctx.features.analytics`
 * read surface (ADR 0014) + `feature.analytics.{nodes,agents}`, all behind the
 * same `analytics` toggle.
 *
 * Default status: `on` (ADR 0191). Originally `off` (a new product surface);
 * reversed so the default-installed ADR 0149 lighthouse templates (which read
 * `ctx.features.analytics` via `feature.analytics.nodes.query`) resolve out of
 * the box on this reference app. The toggle gates only the authed READ surface;
 * the public beacon is consent-gated ONLY when `consent` is on — `isAllowed` returns true when that toggle is off (ADR 0651 D4) — so default-on
 * changes nothing about consent. An operator can turn it off per-tenant.
 */

import type { BackendFeature } from '../types.js';
import { registerAnalyticsRoutes } from './routes.js';
import { buildAnalyticsSurface } from './surface.js';
import { registerAnalyticsAgentTools } from './agentTools.js';

export const analyticsFeature: BackendFeature = {
  id: 'analytics',
  registerRoutes: (deps) => {
    registerAnalyticsRoutes(deps);
    // CFP-1 — the Analytics Insights agent's real summary read tool. Process-wide
    // + inert until the pack allowlists the id; per-tenant toggle honesty lives
    // inside the tool's run().
    registerAnalyticsAgentTools();
  },
  // Face 2 (ADR 0014): `ctx.features.analytics` — a thin read surface (query) that
  // backs the feature.analytics.nodes pack.
  surface: { id: 'analytics', build: buildAnalyticsSurface },
  // ADR 0512 — workspace navigation telemetry: a MEMBER-measurement surface,
  // so it is its own deliberate opt-in (default OFF everywhere, including the
  // demo), AND-ed with the parent toggle at the route gate. Counts-only
  // (route pattern × source × ISO week); members see an in-product disclosure
  // while it is on.
  extraToggleDefaults: [{
    // ADR 0569 — the per-operator opt-out for the cookieless visitor dimension.
    // Default ON (decision 3): the mechanism is anonymous-by-construction (daily-
    // rotating salted hash, raw IP/UA never persisted, no cookie, no cross-day
    // identity — the Plausible/Fathom lineage), and the white-label disclosure
    // copy rides the reporting UI. OFF ⇒ the beacon stores NO visitor dimension
    // at all (counts only) and the reporting page adapts.
    id: 'analytics-visitor-identity',
    label: 'Analytics visitor identity (cookieless)',
    description: 'ADR 0569 — daily uniques via a daily-rotating salted hash computed at ingest (no cookie, no stored IP/UA, no cross-day identity). Turn OFF to store event counts only, with no visitor dimension.',
    category: 'CRM',
    status: 'on',
    bucketUnit: 'tenant',
    salt: 'analytics-visitor-identity',
  }, {
    id: 'workspace-nav-telemetry',
    label: 'Workspace navigation telemetry',
    description: 'ADR 0512 — anonymous, counts-only navigation aggregates (destination × menu source) for THIS workspace, as evidence for information-architecture decisions. No individual activity is stored; members see a disclosure while on. Default OFF.',
    category: 'CRM',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'workspace-nav-telemetry',
  }],
  toggleDefault: {
    id: 'analytics',
    label: 'Analytics',
    description: 'Public-surface measurement (page/event/conversion) + reporting — product feature.',
    category: 'CRM',
    status: 'on', // ADR 0191 — default-on so the bundled lighthouse templates resolve OOTB
    bucketUnit: 'tenant',
    salt: 'analytics',
  },
  requiredPacks: [
    { name: 'feature.analytics.nodes', version: '1.1.1' }, // WF-ANL-1 config+inputs merge
    { name: 'feature.analytics.agents', version: '1.0.1' }, // CFP-1 real query tool
  ],
  // ADR 0194 Phase 5 — a SOFT dependency (advisory, not a lock): analytics works
  // better with Consent present, since the public beacon is consent-gated ONLY with Consent present (ADR 0020; permissive without it — ADR 0651 D4)
  // — measurement stays compliant when consent management is on. The console
  // suggests enabling `consent`; it never blocks analytics from running without it.
  recommends: ['consent'],
};
