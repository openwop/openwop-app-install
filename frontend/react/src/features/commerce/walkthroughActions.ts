/**
 * Commerce walkthrough action pack (ADR 0489 P4 → ADR 0488 P4) — the one-step
 * "navigate + spotlight" action for the commerce surface.
 *
 * The anchor landed with the #2572 drawdown; an anchor alone is not reachable —
 * a chain references a SEMANTIC action id, so the anchor needs a registration
 * before any tutorial can drive it. This is that registration, owned by the
 * feature (the funnels precedent) rather than the core spotlight list, so it
 * moves with the component it targets.
 *
 * Boot-eager trigger, lazy chunk: registering from the page module would leave a
 * walkthrough launched from /walkthroughs `needs-update` until the user happened
 * to visit the page.
 */
import { registerPageSpotlight } from '../../walkthroughs/pageSpotlight.js';

export const COMMERCE_WALKTHROUGH_ACTION_IDS = ['commerce.page.view'] as const;

export function registerCommerceWalkthroughActions(): void {
  registerPageSpotlight('commerce.page.view', '/commerce', 'commerce.page');
}
