/**
 * Grade-pass (maintainability): the ONE "navigate + spotlight a page root"
 * action shape the six page packs shared byte-for-byte. Each pack stays its
 * own lazy chunk + boot-eager trigger; only the body deduplicates here.
 */
import { registerWalkthroughAction } from './actionRegistry.js';

export function registerPageSpotlight(actionId: string, route: string, anchor: string): void {
  registerWalkthroughAction(actionId, {
    route,
    resolve: () => document.querySelector<HTMLElement>(`[data-walkthrough="${anchor}"]`),
    verb: 'focus',
  });
}
