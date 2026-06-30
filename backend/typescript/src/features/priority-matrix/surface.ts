/**
 * Priority Matrix workflow surface (ADR 0058 / ADR 0014 Phase 1) — the typed
 * `ctx.features['priority-matrix']` a workflow node calls. Tenant comes from the
 * run scope (CTI-1); toggle-gated at the registry seam (featureSurfaces.gate).
 * Reads are replay-safe; the write methods are intended for `role:action` pack
 * nodes (recorded → replay reads the recorded output, no re-issue).
 *
 * @see docs/adr/0058-priority-matrix.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { type FeatureSurface, surfaceStr, surfaceOptStr } from '../../host/featureSurfaces.js';
import { listLists, listRankedIdeas, submitIdea, setIdeaScore, createPlanningSession, buildPortfolio, getScheduleStatus } from './priorityMatrixService.js';

export function buildPriorityMatrixSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /** The workspace's priority lists (id, name, scoping). */
    listLists: async () => ({
      lists: (await listLists(tenantId)).map((l) => ({
        listId: l.id,
        name: l.name,
        boardId: l.boardId,
        ...(l.projectId ? { projectId: l.projectId } : {}),
        criteria: l.criteriaSet.criteria.map((c) => ({ id: c.id, name: c.name, weight: c.weight, direction: c.direction })),
      })),
    }),

    /** A list's ideas ranked by computed weighted priority (descending). */
    listRankedIdeas: async (args) => {
      const ideas = await listRankedIdeas(tenantId, surfaceStr(args.listId));
      return {
        ideas: ideas.map((i) => ({
          cardId: i.card.id,
          title: i.card.title,
          status: i.status.columnName,
          priority: i.computedPriority,
          rank: i.rank,
        })),
      };
    },

    /** Submit a new idea into a list (lands in the `New` status). */
    submitIdea: async (args) => {
      const card = await submitIdea(tenantId, surfaceStr(args.listId), 'workflow', {
        title: surfaceStr(args.title),
        ...(surfaceOptStr(args.description) ? { description: surfaceOptStr(args.description) } : {}),
      });
      return { cardId: card.id, title: card.title, status: card.columnId };
    },

    /** Score one idea against the list's criteria (criterionId → 1..10). In a
     *  multi-voter list this records the run-cast `workflow` vote (ADR 0059). */
    scoreIdea: async (args) => {
      const scores = (args.scores && typeof args.scores === 'object') ? args.scores as Record<string, number> : {};
      const row = await setIdeaScore(tenantId, surfaceStr(args.listId), surfaceStr(args.cardId), 'workflow', scores);
      return { cardId: row.cardId, computedPriority: row.computedPriority };
    },

    /** The workspace portfolio — ideas across ALL the tenant's lists, ranked by
     *  computed priority (ADR 0060). A run is tenant-trusted, so this aggregates
     *  every list in scope; the REST route applies the finer per-org RBAC filter. */
    listPortfolio: async (args) => {
      const topN = typeof args.topN === 'number' ? args.topN : undefined;
      const portfolio = await buildPortfolio(tenantId, await listLists(tenantId), topN);
      return {
        items: portfolio.items.map((i) => ({
          listName: i.listName,
          cardId: i.cardId,
          title: i.title,
          status: i.status,
          priority: i.computedPriority,
          inListRank: i.inListRank,
          scoringModel: i.scoringModel,
        })),
      };
    },

    /** Per-idea schedule status + a list rollup (ADR 0103) — ahead/behind derived
     *  from each idea's target date + its card status. A LIVE read (server clock);
     *  the role:"action" node records the output, so replay/fork read the recorded
     *  result rather than recomputing against a new clock. */
    getScheduleStatus: async (args) => {
      const out = await getScheduleStatus(tenantId, surfaceStr(args.listId));
      return { ideas: out.ideas, rollup: out.rollup };
    },

    /** Generate a planning-session agenda from a list's top-N ideas. */
    generateAgenda: async (args) => {
      const n = typeof args.n === 'number' ? args.n : 5;
      const session = await createPlanningSession(tenantId, surfaceStr(args.listId), 'workflow', {
        ...(surfaceOptStr(args.name) ? { name: surfaceOptStr(args.name) } : {}),
        mode: 'top-n',
        n,
      });
      return { sessionId: session.id, name: session.name, agendaMarkdown: session.agendaMarkdown, ...(session.agendaDocumentId ? { agendaDocumentId: session.agendaDocumentId } : {}) };
    },
  };
}
