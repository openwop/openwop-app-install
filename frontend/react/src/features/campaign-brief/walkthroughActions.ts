/**
 * Campaign Studio tour actions (ADR 0368 Phase 4) — the reference tour's
 * semantic targets, colocated with the feature that owns the UI (a refactor
 * moves these registrations with the components; `data-walkthrough` anchors keep
 * them locale-independent).
 */
import { registerWalkthroughAction, registerWalkthroughCheckpoint } from '../../walkthroughs/actionRegistry.js';

const q = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(sel);

/** The canonical ids the Campaign Studio tour references — the ONE FE source
 *  the coverage test derives from (no hand-maintained mirror). Must equal the
 *  backend tour def's referenced set (pinned by guided-tours-coverage.test). */
export const CAMPAIGN_STUDIO_TOUR_ACTION_IDS = [
  'campaign-studio.new-brief.click',
  'campaign-studio.brief-name.fill',
  'campaign-studio.create-brief.click',
  'campaign-studio.campaigns-tab.click',
] as const;
export const CAMPAIGN_STUDIO_TOUR_CHECKPOINT_IDS = ['campaign-studio.brief-exists'] as const;

export function registerCampaignStudioWalkthroughActions(): void {
  registerWalkthroughAction('campaign-studio.new-brief.click', {
    route: '/campaign-studio',
    resolve: () => q('[data-walkthrough="new-brief"]'),
    verb: 'click',
  });
  // HITL: the user names their brief (the chrome's "I did it" resolves —
  // typing has no single "done" DOM signal worth guessing at).
  registerWalkthroughAction('campaign-studio.brief-name.fill', {
    route: '/campaign-studio',
    resolve: () => q('[data-walkthrough="new-brief-form"] input'),
    verb: 'focus',
  });
  registerWalkthroughAction('campaign-studio.create-brief.click', {
    route: '/campaign-studio',
    resolve: () => {
      const el = q('[data-walkthrough="create-brief"]');
      // A disabled Create means the HITL step was skipped — report "not
      // ready" so the player retries briefly then pauses honestly.
      return el && !(el as HTMLButtonElement).disabled ? el : null;
    },
    verb: 'click',
  });
  registerWalkthroughAction('campaign-studio.campaigns-tab.click', {
    route: '/campaign-studio',
    resolve: () => q('[role="tab"][id$="-tab-campaigns"]'),
    verb: 'click',
  });
  registerWalkthroughCheckpoint('campaign-studio.brief-exists', {
    evaluate: async () => {
      try {
        // LAZY: this module registers at feature-manifest init (entry-chunk
        // adjacent) — a static client import dragged the campaign-brief client
        // into the entry bundle and blew the 188 kB budget. Checkpoints run
        // only mid-tour; pay for the client then.
        const { listBriefs } = await import('./campaignBriefClient.js');
        const briefs = await listBriefs();
        return briefs.length > 0 ? null : 'no brief was created';
      } catch {
        return 'briefs could not be read';
      }
    },
  });
}
