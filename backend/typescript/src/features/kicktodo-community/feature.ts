/**
 * kicktodo-community (ADR 0426) — creator profiles, proof-gated reviews,
 * counts-only creator analytics.
 */

import type { BackendFeature } from '../types.js';
import { registerKicktodoCommunityRoutes } from './routes.js';
import { registerKicktodoCommunityAgentTools } from './agentTools.js';
import { reconcileCreatorProfileProjections, reconcileReviewProjections } from './communityService.js';
import { buildKicktodoCommunitySurface } from './surface.js';
import { registerKicktodoReviewFlagsExceptionSource } from './exceptionSources.js';

export const kicktodoCommunityFeature: BackendFeature = {
  id: 'kicktodo-community',
  registerRoutes: (deps) => {
    registerKicktodoCommunityRoutes(deps);
    // chat-first-port G7 — the challenge-reviews READ tool (KickBot participant
    // lane). Process-wide registration; per-tenant toggle honesty lives in run().
    registerKicktodoCommunityAgentTools();
    // ADR 0460 Phase 2 — the review-flags feed of the admin Exception Ledger
    // (reviews left in `flagged` state, awaiting moderation).
    registerKicktodoReviewFlagsExceptionSource();
    // ADR 0453 P3 — re-derive every creator profile's kernel projection at boot
    // (backfills stragglers approved before P1 + heals any DATA-LEV-3 divergence).
    // Best-effort + idempotent; empty stores ⇒ a no-op; never blocks boot.
    void reconcileCreatorProfileProjections().catch(() => undefined);
    // ADR 0465 P3 — re-derive every review's kernel projection at boot (backfills
    // stragglers written before P1, minting a random reviewEntityId on legacy rows,
    // + heals any divergence). Best-effort + idempotent; empty stores ⇒ a no-op.
    void reconcileReviewProjections().catch(() => undefined);
  },
  toggleDefault: {
    id: 'kicktodo-community',
    label: 'KickTodo Community',
    description:
      'Creator profiles (approval-gated), proof-gated challenge reviews, counts-only creator analytics (ADR 0426).',
    category: 'KickTodo',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'kicktodo-community',
  },
  // ADR 0439 — `kicktodo-creator` removed: it was declared but never imported (the
  // only textual match was the KV namespace string 'kicktodo-creator-profiles'), so
  // it locked a feature this package does not need.
  //
  // `kicktodo-commerce` IS imported (entitlementService, from routes/surface/
  // communityService) but is deliberately NOT declared, per this ADR's own rule: its
  // `entitlementService` carries no toggle check, so community keeps working with
  // commerce off — a lock would be fiction. Declaring it also broke the `slim-proof`
  // distribution's dependsOn closure (community included, commerce excluded), which
  // is the composition consequence ADR 0439 §1 describes. It rides the parity
  // ratchet with the other undeclared edges.
  dependsOn: ['kicktodo-core'],
  requiredPacks: [{ name: 'feature.kicktodo.nodes', version: '1.30.0' }],
  surface: { id: 'kicktodo-community', build: buildKicktodoCommunitySurface }, // ADR 0426 P5
};
