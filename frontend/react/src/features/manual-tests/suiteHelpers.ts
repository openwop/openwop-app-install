/**
 * Shared manual-test suite builders (ADR 1031 P2 — moved out of `suites.ts` so a
 * feature package's own `manualTests.ts` builds its toggles the same way).
 */
import type { FeatureToggle } from './manualTestTypes.js';

/** An always-on surface: nothing to enable. */
export const ON = { off: false, howToEnable: [] as string[] };

/** OFF feature gated by a `/feature-toggles` flag — the standard enable recipe.
 *
 *  ADR 0600 §7 (`ISU-16`) — step 3 used to read "the feature appears in the nav
 *  and its route is reachable" unconditionally. That is FALSE for every feature
 *  with no page, and this boilerplate is what a human tester follows: they would
 *  file the missing nav entry as THE bug and never reach the real one. `hasPage`
 *  makes the claim conditional instead of dropping it — a feature that DOES get
 *  a nav entry should still be told so. */
export const offVia = (id: string, opts: { hasPage?: boolean } = {}): FeatureToggle => ({
  off: true,
  id,
  howToEnable: [
    'Open Admin → Platform → Feature toggles (/feature-toggles)',
    `Switch the "${id}" toggle ON for your tenant`,
    opts.hasPage === false
      ? 'Reload. This feature has NO nav entry and NO route of its own — it surfaces through the chat, the Builder gallery, runs and notifications. Do not look for a page.'
      : 'Reload — the feature appears in the nav and its route is reachable',
  ],
  howToRevert: [`Switch the "${id}" toggle OFF again on /feature-toggles`],
});
