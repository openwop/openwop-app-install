/**
 * Workflows walkthrough action pack (ADR 0378 P4) — the one-step "navigate +
 * spotlight" action backing the surface's render case; the render-quality
 * judgment stays HUMAN. Boot-eager trigger, lazy chunk.
 */
import { registerPageSpotlight } from '../walkthroughs/pageSpotlight.js';

export const WORKFLOWS_WALKTHROUGH_ACTION_IDS = ['workflows.page.view'] as const;

export function registerWorkflowsWalkthroughActions(): void {
  registerPageSpotlight('workflows.page.view', '/builder', 'workflows.page');
}
