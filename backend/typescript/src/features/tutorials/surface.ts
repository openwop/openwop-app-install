/**
 * Tutorials workflow surface (ADR 0488 P6 — `ctx.features.tutorials`).
 *
 * A THIN, READ-ONLY adapter (ADR 0014), deliberately mirroring what
 * `walkthroughs/surface.ts` already concluded: a backend run cannot drive a
 * browser, so there is no `startTutorial` op here and there will not be one.
 * What a run CAN do is READ learning state to gate a branch — "has this
 * workspace finished the onboarding tutorial? if not, notify" — which is the
 * honest and genuinely useful half.
 *
 * Progress here is PER-USER (unlike the walkthrough store's tenant-level legacy
 * rows), so an op that reads it requires a subject and returns nothing without
 * one rather than leaking another member's learning record.
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import type { FeatureSurface } from '../../host/featureSurfaces.js';
import { getTutorial, listTutorials } from './tutorialsService.js';
import { listTutorialProgress } from './progressStore.js';

export function buildTutorialsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /** The tutorial catalog visible to this tenant (kernel rows ∪ shipped seeds). */
    listTutorials: async () => {
      const { tutorials, degraded } = await listTutorials(tenantId);
      return {
        tutorials: tutorials.map((t) => ({
          tutorialId: t.id,
          title: t.title,
          category: t.category,
          totalSteps: t.phases.reduce((n, p) => n + p.steps.length, 0),
          source: t.source,
        })),
        degraded,
      };
    },

    /** One tutorial's shape — phases, step ids, and which have a runnable spine. */
    getTutorial: async (input: unknown) => {
      const id = typeof (input as { tutorialId?: unknown })?.tutorialId === 'string'
        ? (input as { tutorialId: string }).tutorialId : '';
      const tutorial = id ? await getTutorial(tenantId, id) : null;
      if (!tutorial) return { tutorial: null };
      return {
        tutorial: {
          tutorialId: tutorial.id,
          title: tutorial.title,
          phases: tutorial.phases.map((p) => ({
            number: p.number,
            title: p.title,
            ...(p.chainId ? { chainId: p.chainId } : {}),
            stepIds: p.steps.map((s) => s.id),
          })),
        },
      };
    },

    /**
     * The ACTING USER's progress. Requires a subject: without one this returns
     * empty rather than falling back to a tenant-wide read, because "somebody
     * here finished it" is not an answer to "did THIS person finish it".
     */
    listMyProgress: async () => {
      if (!scope.actingUserId) return { progress: [], note: 'no acting user on this run' };
      const rows = await listTutorialProgress(tenantId, scope.actingUserId);
      return {
        progress: rows.map(({ tutorialId, completedStepIds, updatedAt }) => ({
          tutorialId, completedSteps: completedStepIds.length, updatedAt,
        })),
      };
    },
  };
}
