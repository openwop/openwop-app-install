/**
 * Editable dashboard feature (ADR 0375) — a per-(user, workspace) customizable
 * tile grid. This backend leg owns ONLY layout persistence; the tile registry +
 * grid live frontend-side, and each tile is a compact projection over an
 * existing feature client (ADR 0082 — no parallel store).
 *
 * § Correction (2026-07-16): graduated OFF the feature toggle to a permanent,
 * always-on surface (the Users/Profiles graduation pattern — ADR 0002/0005
 * § Correction) AND became the signed-in HOME at '/' (Chat moved to '/chat').
 * The home surface can no longer be toggle-hidden: every signed-in landing
 * renders it, and the per-tile owningFeatureToggle gates (which stay!) already
 * provide the meaningful feature gating inside it. No `toggleDefault`; routes
 * serve unconditionally.
 *
 * Phase 1: layout persistence + REST only. NO workflow surface / node pack /
 * agent pack / envelopes — a dashboard is a read/preference surface, not a
 * workflow actor (deferred + logged in the ADR, honestly accounted).
 */

import type { BackendFeature } from '../types.js';
import { registerDashboardRoutes } from './routes.js';

export const dashboardFeature: BackendFeature = {
  id: 'dashboard',
  registerRoutes: registerDashboardRoutes,
  // No toggleDefault — graduated off its toggle (§ Correction above).
  // No surface / requiredPacks in Phase 1 — see the ADR's honest accounting.
};
