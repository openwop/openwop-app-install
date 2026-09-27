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
import { buildProfilesSurface } from './surface.js';

export const profilesFeature: BackendFeature = {
  id: 'profiles',
  requiredPacks: [{ name: 'feature.profiles.nodes', version: '1.1.0' }], // NP-STALE-PROFILES-1 · ADR 0624 D1 (get honest: { userId } → { profile, found })
  registerRoutes: (deps) => registerProfilesRoutes(deps),
  // ADR 0014 — `ctx.features.profiles` descriptive read surface (listProfiles /
  // getProfile). Always-on/ungated (no toggleDefault) — the intended path.
  surface: { id: 'profiles', build: buildProfilesSurface },
  // No `toggleDefault` — graduated to always-on (§ Correction above).
};
