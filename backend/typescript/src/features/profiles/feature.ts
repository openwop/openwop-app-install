/**
 * User profiles (ADR 0005). A self-service descriptive profile per user +
 * a tenant directory. Owns DESCRIPTIVE data only — identity stays in `users`
 * (ADR 0002/0003), authority is RBAC (ADR 0006), avatar/portfolio bytes live in
 * the media-asset surface (RFC 0055).
 *
 * § Correction (2026-06-12) — GRADUATED off the feature toggle (always-on),
 * like users/connections/assistant. Profiles is foundational substrate: agent
 * PINNING (ADR 0023) and the per-user portfolio/activity surfaces ride on it,
 * so gating it behind an off-by-default Platform toggle made core agent UX
 * (pin to sidebar) silently 404 until an admin enabled it — and a non-admin
 * user could never turn it on. The routes now serve unconditionally; there is
 * no separate product to A/B.
 */

import type { BackendFeature } from '../types.js';
import { registerProfilesRoutes } from './routes.js';

export const profilesFeature: BackendFeature = {
  id: 'profiles',
  registerRoutes: (deps) => registerProfilesRoutes(deps),
  // No `toggleDefault` — graduated to always-on (§ Correction above).
};
