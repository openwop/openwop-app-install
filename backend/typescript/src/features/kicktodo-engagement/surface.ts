/**
 * `ctx.features.kicktodo-engagement` (ADR 0425 P5) — read-only: the caller's
 * leaderboard view and awards. Writes stay on the governed REST surface.
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { leaderboard, listAwards } from './engagementService.js';
import { bindKicktodoSurface, type KicktodoSurfaceSpecs } from '../kicktodo-core/surfaceBinding.js';

/** ADR 0901 (DEC-1) — the run-principal spec per method (`surfaceBinding.ts`).
 *  Both are the CALLER's own view (each route passes `subjectOf(req)`). */
export const KICKTODO_ENGAGEMENT_SURFACE_SPECS = {
  leaderboard: { subjectArg: 'ownerSubject', authority: 'none', personOnly: true },
  awards: { subjectArg: 'ownerSubject', authority: 'none', personOnly: true },
} as const satisfies KicktodoSurfaceSpecs;

export function buildKicktodoEngagementSurface(scope: BundleScope): FeatureSurface {
  const tenant = scope.tenantId;
  return bindKicktodoSurface('kicktodo-engagement', scope, {
    // ADR 0641 decision 13 — a board is per-challenge, so the surface takes the
    // challenge explicitly. No default: the previous no-arg call meant "the whole
    // tenant", and defaulting would quietly keep that cross-challenge board alive
    // for workflow callers after the REST route stopped serving it.
    leaderboard: async (args) => ({
      view: await leaderboard(tenant, surfaceStr(args.ownerSubject), surfaceStr(args.challengeId)),
    }),
    awards: async (args) => ({ awards: await listAwards(tenant, surfaceStr(args.ownerSubject)) }),
  }, KICKTODO_ENGAGEMENT_SURFACE_SPECS);
}
