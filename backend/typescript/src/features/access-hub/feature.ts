/**
 * Access hub (ADR 0144 console; ADR 0864 summary) — the backend half of the
 * `/access` console: one aggregated read of the counts its sections, summary
 * cards and reconnect banner show. Always on, like the console itself (ADR 0144
 * §Correction 2026-06-26); each section keeps its own route's authority.
 *
 * @see docs/adr/0864-access-hub-summary.md
 */
import type { BackendFeature } from '../types.js';
import { buildAccessSummary } from './summary.js';

export const ACCESS_SUMMARY_PATH = '/host/openwop-app/access/summary';

export const accessHubFeature: BackendFeature = {
  id: 'access-hub',
  registerRoutes: ({ app }) => {
    app.get(ACCESS_SUMMARY_PATH, async (req, res, next) => {
      try {
        res.setHeader('cache-control', 'no-store');
        res.json(await buildAccessSummary(req));
      } catch (err) { next(err); }
    });
  },
  // No toggleDefault — the console it serves is always on.
};
