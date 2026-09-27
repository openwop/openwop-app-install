/**
 * Keys walkthrough action pack (ADR 0378 P4) — the one-step "navigate +
 * spotlight" action backing the surface's render case; the render-quality
 * judgment stays HUMAN. Boot-eager trigger, lazy chunk.
 */
import { registerPageSpotlight } from '../walkthroughs/pageSpotlight.js';
import { registerWalkthroughCheckpoint } from '../walkthroughs/actionRegistry.js';

export const KEYS_WALKTHROUGH_ACTION_IDS = ['keys.page.view'] as const;
export const KEYS_WALKTHROUGH_CHECKPOINT_IDS = ['byok.provider-configured'] as const;

export function registerKeysWalkthroughActions(): void {
  registerPageSpotlight('keys.page.view', '/keys', 'keys.page');

  /**
   * ADR 0489 D1 — the FIRST shipped `already-satisfied` checkpoint.
   *
   * The three-valued verdict landed with full unit + sabotage coverage and then
   * sat unreachable, because every shipped checkpoint only ever returned
   * pass-or-fail. That is the same "built but never invoked" shape as DATA-T1,
   * and it is why the tutorials tracker carried TUX-3: the adaptive behaviour
   * had ZERO live path.
   *
   * This is the ADR's own motivating example, made real: a learner who has
   * already connected a provider should be TOLD so, not walked through
   * connecting one. Note both arms CONTINUE the run — the Keys tour is still
   * worth seeing — so this checkpoint can never cancel a walkthrough. It exists
   * to narrate, and to make the skip visible in the funnel (WALK-A1).
   *
   * A failed read returns `null` (pass) rather than a failure: not being able to
   * check is not the same as "you have no key", and a checkpoint that cancels a
   * tutorial because a read blipped would be exactly the dishonesty the engine
   * refuses elsewhere.
   */
  registerWalkthroughCheckpoint('byok.provider-configured', {
    evaluate: async () => {
      try {
        // LAZY, matching the campaign-brief precedent: this module registers at
        // feature-manifest init, and a static client import would drag the BYOK
        // client into the entry bundle.
        const { listStoredRefs } = await import('./lib/byokClient.js');
        const refs = await listStoredRefs();
        return refs.length > 0
          ? { satisfied: true as const, because: 'You already connected an AI provider, so there is nothing to add here.' }
          : null;
      } catch {
        return null; // cannot check ⇒ teach it anyway; never cancel on a blip
      }
    },
  });
}
