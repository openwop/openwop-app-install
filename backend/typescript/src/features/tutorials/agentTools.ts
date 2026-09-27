/**
 * Tutorials chat-time tools (ADR 0488 P6 — the ADR 0308/0315 seam).
 *
 * THE DELEGATE PROJECTION, HONESTLY. ADR 0488 D6 described this lane as "a Tutor
 * agent runs the chain for you". Implementation says that is not achievable and
 * the app already knows why — `walkthroughs/surface.ts` records the same finding
 * for the same reason: *"a backend run has no live FE player, so it cannot
 * launch a tour at a user"*. An agent turn happens server-side; the walkthrough
 * player lives in the browser and starts from the FE bus. An agent that claimed
 * to drive the UI would be advertising behaviour the host does not honour, which
 * is the one thing this codebase refuses to do.
 *
 * So the Tutor GUIDES rather than drives: it reads the catalog and the learner's
 * own progress, recommends what to do next, explains what a tutorial covers, and
 * points at the walkthrough the human then launches. The DRIVE projection stays
 * the FE player. See the correction note in ADR 0488 §D6.
 *
 * Both tools are READ-ONLY and follow the house rules for this seam:
 *  - they fail EMPTY without an acting user (never a half-answer from an
 *    unattributed run — the projects-tool precedent);
 *  - they reuse the SAME service the HTTP routes use (`listTutorials` /
 *    `getTutorial` / `listTutorialProgress`), so route and tool cannot drift
 *    into disagreeing about what a learner can see;
 *  - progress is scoped to the CALLER's subject, so the Tutor can never read a
 *    co-member's progress.
 *
 * NOT added to the ADR 0315 default-on baseline — they are allowlisted to the
 * Tutor agent pack, which is its own ADR-level decision.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { getTutorial, listTutorials } from './tutorialsService.js';
import { listTutorialProgress } from './progressStore.js';

export const TUTORIALS_CATALOG_TOOL_ID = 'openwop:tutorials.catalog';
export const TUTORIALS_GET_TOOL_ID = 'openwop:tutorials.get';

/** The empty answer, shaped so a model reads it as "nothing visible", not "none exist". */
const NO_ACTOR = { tutorials: [], note: 'no acting user on this turn — nothing visible' };

export function registerTutorialsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: TUTORIALS_CATALOG_TOOL_ID,
      description:
        'List the product tutorials available in this workspace, with THIS user\'s progress through each. '
        + 'Call this before recommending what someone should learn — it is the only way to know what already exists '
        + 'and how far they got. Returns: id, title, description, category, difficulty, estimatedMinutes, '
        + 'the routes the tutorial teaches (`surfaces`), completedSteps/totalSteps, and whether the workspace has '
        + 'customised it. You CANNOT start a tutorial for the user — tell them to open it and press "Show me".',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(_input, scope: BundleScope) {
      if (!scope.actingUserId) return { content: JSON.stringify(NO_ACTOR) };
      const { tutorials, degraded } = await listTutorials(scope.tenantId);
      // Progress is per-subject: the Tutor sees the CALLER's, never a co-member's.
      //
      // UX_UPGRADE-tutorials R2 (TUT2-M1) — this was `.catch(() => [])`, in the
      // same return that ALREADY annotates the other degraded read ("the content
      // store was unreachable — these are the shipped tutorials…"). A failed
      // progress read rendered as ZERO progress under a tool description that
      // declares the stakes — "it is the only way to know … how far they got" —
      // so a storage hiccup made the Tutor restart a user who was nearly done.
      // Unavailable progress now OMITS the field and says so, symmetrical with
      // the degraded-content note beside it.
      let progressUnavailable = false;
      const progress = await listTutorialProgress(scope.tenantId, scope.actingUserId)
        .catch(() => { progressUnavailable = true; return []; });
      const byId = new Map(progress.map((p) => [p.tutorialId, p.completedStepIds.length]));
      return {
        content: JSON.stringify({
          tutorials: tutorials.map((t) => {
            const totalSteps = t.phases.reduce((n, p) => n + p.steps.length, 0);
            return {
              id: t.id,
              title: t.title,
              description: t.description,
              category: t.category,
              ...(t.difficulty ? { difficulty: t.difficulty } : {}),
              ...(t.estimatedMinutes ? { estimatedMinutes: t.estimatedMinutes } : {}),
              ...(t.surfaces ? { surfaces: t.surfaces } : {}),
              totalSteps,
              // Omitted, never zeroed, when the read failed — 0 is a CLAIM.
              ...(progressUnavailable ? {} : { completedSteps: byId.get(t.id) ?? 0 }),
              source: t.source,
            };
          }),
          // Honest about a degraded read rather than presenting seeds as tenant rows.
          ...(degraded ? { note: 'the content store was unreachable — these are the shipped tutorials, not this workspace\'s edited copies' } : {}),
          ...(progressUnavailable ? { progressNote: 'the caller\'s progress could not be read — completedSteps is omitted. Do NOT assume zero progress or recommend starting over.' } : {}),
        }),
      };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: TUTORIALS_GET_TOOL_ID,
      description:
        'Read ONE tutorial in full: its goal, learning objectives, prerequisites, and every phase and step. '
        + 'Use it to answer "what does this cover?" or "what do I do at step 3.1?" from the real content rather than from memory. '
        + 'A phase with a `chainId`, or a step with `run.chainId`, has a guided walkthrough the USER can launch from the '
        + 'tutorial page — say so; you cannot launch it yourself.',
      inputSchema: {
        type: 'object',
        properties: { tutorialId: { type: 'string', description: 'The tutorial id, e.g. "connect-your-ai" (from the catalog tool).' } },
        required: ['tutorialId'],
        additionalProperties: false,
      },
    },
    async run(input, scope: BundleScope) {
      if (!scope.actingUserId) return { content: JSON.stringify({ tutorial: null, note: NO_ACTOR.note }) };
      const args = (input ?? {}) as { tutorialId?: unknown };
      const id = typeof args.tutorialId === 'string' ? args.tutorialId.trim() : '';
      if (!id) return { content: JSON.stringify({ tutorial: null, note: 'tutorialId is required' }) };
      const tutorial = await getTutorial(scope.tenantId, id);
      if (!tutorial) {
        return { content: JSON.stringify({ tutorial: null, note: `no tutorial "${id}" — call ${TUTORIALS_CATALOG_TOOL_ID} for the real ids` }) };
      }
      // TUT2-M1 — same failed-read honesty as the catalog tool above.
      let progressUnavailable = false;
      const done = new Set(
        (await listTutorialProgress(scope.tenantId, scope.actingUserId)
          .catch(() => { progressUnavailable = true; return []; }))
          .find((p) => p.tutorialId === id)?.completedStepIds ?? [],
      );
      return {
        content: JSON.stringify({
          tutorial: {
            id: tutorial.id,
            title: tutorial.title,
            ...(tutorial.goal ? { goal: tutorial.goal } : {}),
            ...(tutorial.learningObjectives ? { learningObjectives: tutorial.learningObjectives } : {}),
            ...(tutorial.prerequisites ? { prerequisites: tutorial.prerequisites } : {}),
            phases: tutorial.phases.map((p) => ({
              number: p.number,
              title: p.title,
              ...(p.goal ? { goal: p.goal } : {}),
              ...(p.chainId ? { chainId: p.chainId } : {}),
              steps: p.steps.map((s) => ({
                id: s.id,
                title: s.title,
                // Omitted, never false, when the read failed — `completed:
                // false` on every step is indistinguishable from a fresh start.
                ...(progressUnavailable ? {} : { completed: done.has(s.id) }),
                ...(s.run?.chainId ? { runnable: true } : {}),
              })),
            })),
            source: tutorial.source,
          },
          ...(progressUnavailable ? { progressNote: 'the caller\'s progress could not be read — per-step `completed` is omitted. Do NOT assume zero progress.' } : {}),
        }),
      };
    },
  });
}
