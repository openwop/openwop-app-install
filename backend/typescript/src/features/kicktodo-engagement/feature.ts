/**
 * kicktodo-engagement (ADR 0425) — opt-in leaderboard, awards, experiments.
 * Registers the check-in observer at boot (the ADR 0420 inversion applied to
 * evidence): kicktodo-core notifies; this feature derives.
 */

import type { BackendFeature } from '../types.js';
import { registerCheckInObserver } from '../kicktodo-core/todayService.js';
import { onCheckIn } from './engagementService.js';
import { registerKicktodoEngagementRoutes } from './routes.js';
import { registerKicktodoEngagementAgentTools } from './agentTools.js';
import { buildKicktodoEngagementSurface } from './surface.js';

export const kicktodoEngagementFeature: BackendFeature = {
  id: 'kicktodo-engagement',
  registerRoutes: (deps) => {
    registerKicktodoEngagementRoutes(deps);
    // chat-first-port G6 — the engagement-summary READ tool (KickBot participant
    // lane). Process-wide registration; per-tenant toggle honesty lives in run().
    registerKicktodoEngagementAgentTools();
    registerCheckInObserver(onCheckIn);
  },
  toggleDefault: {
    id: 'kicktodo-engagement',
    label: 'KickTodo Engagement',
    description:
      'Opt-in leaderboard (k-floor, closed projection), deterministic awards, and variant-stamp effectiveness reads (ADR 0425).',
    category: 'KickTodo',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'kicktodo-engagement',
  },
  dependsOn: ['kicktodo-core'],
  requiredPacks: [{ name: 'feature.kicktodo.nodes', version: '1.30.0' }],
  surface: { id: 'kicktodo-engagement', build: buildKicktodoEngagementSurface }, // ADR 0425 P5
};
