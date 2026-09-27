/**
 * Walkthrough identifier constants — a LEAF module (no imports), so both the
 * feature (`feature.ts`, which registers routes/nodes/surface) and the host demo
 * seeder (`host/demoWalkthroughsSeed.ts`, which owns the seeded sample
 * definitions since ADR 0435) can share them without a host↔feature import
 * cycle.
 *
 * The node type ids are re-declared here rather than imported from
 * `walkthroughNodes.ts` for the same reason — that module pulls the node
 * registration machinery, which the seeder has no business importing. The
 * `walkthroughNodeIds.test.ts` pins the two copies together so they cannot
 * drift.
 */

/** Step / checkpoint node type ids (mirror of `walkthroughNodes.ts`). */
export const WALKTHROUGH_STEP_TYPE_ID = 'ui.walkthrough.step';
export const WALKTHROUGH_CHECKPOINT_TYPE_ID = 'ui.walkthrough.checkpoint';

/** The Campaign Studio reference walkthrough (ADR 0368 P4; seeded since 0429). */
export const CAMPAIGN_STUDIO_WALKTHROUGH_ID = 'walkthrough.campaign-studio.first-brief';

/** ADR 0376 Phase 2 — the pre-rename id. Kept REGISTERED as a builtin alias
 *  (same definition) so runs + progress rows created before the rename still
 *  resolve on replay / `:fork`. Excluded from every user-facing listing so it
 *  never double-shows next to the seeded walkthrough. */
export const LEGACY_CAMPAIGN_STUDIO_ID = 'tour.campaign-studio.first-brief';

/** The chat first-message walkthrough (ADR 0378 P4; seeded since 0429). */
export const CHAT_WALKTHROUGH_ID = 'walkthrough.chat.first-message';
