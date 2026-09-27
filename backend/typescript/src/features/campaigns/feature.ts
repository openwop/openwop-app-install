/**
 * Campaign Studio console (ADR 0200 Phase 2) — a FRONTEND-ONLY consolidation console.
 *
 * The backend half exists solely to register the `campaigns` feature toggle (default
 * OFF, tenant-bucketed) so the frontend nav gate resolves server-side (the FE is
 * never the authority — ADR 0001 §3.4). There is NO route, service, surface, pack,
 * or wire: the console mounts the existing Campaign Studio owners (Briefs, Campaigns,
 * Performance, Intelligence) as tabs and adds nothing to the protocol surface.
 * Opt-in: OFF ⇒ the four campaign features keep their standalone Marketing nav; ON ⇒
 * they collapse into the one console (`nav.hiddenWhenFeature: 'campaigns'`).
 *
 * Mirrors the `models` / `chat-deployment` hub-anchor precedent (ADR 0145). NOTE the
 * anchor id is `campaigns`, NOT `campaign-studio` — the latter is a DIFFERENT feature
 * (the ADR 0153 in-chat campaign CANVAS). This console groups the five `campaign-*`
 * chain features; it is unrelated to the canvas.
 *
 * @see docs/adr/0200-feature-chain-consolidation.md §Phase 2
 */
import type { BackendFeature } from '../types.js';

export const campaignsFeature: BackendFeature = {
  id: 'campaigns',
  // Frontend-only: no HTTP surface. The console composes existing owners' routes.
  registerRoutes: () => {},
  toggleDefault: {
    id: 'campaigns',
    label: 'Campaign Studio console',
    description:
      'One console for the Campaign Studio chain — Briefs, Campaigns, Performance, and Intelligence in a single tabbed destination (ADR 0200). OFF ⇒ each appears as its own Marketing nav item; ON ⇒ they collapse into this console. (Distinct from the in-chat Campaign Studio canvas, ADR 0153.)',
    category: 'Marketing',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'campaigns',
  },
};
