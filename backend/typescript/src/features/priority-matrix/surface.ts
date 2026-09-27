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
import { listLists, listRankedIdeas, submitIdea, setIdeaScore, createPlanningSession, buildPortfolio, getScheduleStatus, getList, getSessionRow } from './priorityMatrixService.js';
import { addScenario } from './scenarios.js';
import { ignitionKey, claimIgnition, recordIgnitionRun } from '../../host/ignitionGuard.js';
import { getIdeaIntake, listIdeaEvidence, upsertIdeaIntake, addIdeaEvidence } from './intake.js';

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
      // ADR 0246 — when `orgId` is supplied (the forms→intake bridge chain), the
      // target list MUST belong to it (write-boundary org guard).
      const expectedOrgId = surfaceOptStr(args.orgId);
      const listId = surfaceStr(args.listId);
      // PMXU-1 (ADR 0590) — a run-filed idea is stamped source:'workflow' so it
      // is distinguishable from a human's in the store, on the wire, and in the UI.
      const card = await submitIdea(tenantId, listId, 'workflow', {
        title: surfaceStr(args.title),
        ...(surfaceOptStr(args.description) ? { description: surfaceOptStr(args.description) } : {}),
      }, expectedOrgId, 'workflow');
      // ADR 0247 OQ-5 — when filed from a form submission, stamp provenance
      // (sourceChannel:'form' + submissionId) on the new idea's intake overlay.
      // Same feature (no cross-feature import); best-effort — the idea is already
      // created, so a stamp hiccup must not fail the run.
      const sourceSubmissionId = surfaceOptStr(args.sourceSubmissionId);
      if (sourceSubmissionId) {
        try {
          const list = await getList(tenantId, listId);
          if (list) await upsertIdeaIntake({ tenantId, orgId: list.orgId, listId, cardId: card.id, actor: 'workflow', patch: { sourceChannel: 'form', sourceSubmissionId } });
        } catch { /* provenance is best-effort */ }
      }
      return { cardId: card.id, title: card.title, status: card.columnId };
    },

    /** Score one idea against the list's criteria (criterionId → 1..10). In a
     *  multi-voter list this records the run-cast `workflow` vote (ADR 0059). */
    scoreIdea: async (args) => {
      const scores = (args.scores && typeof args.scores === 'object') ? args.scores as Record<string, number> : {};
      // PMXU-1 (ADR 0590) — a run-cast score/vote is stamped source:'workflow'.
      // ADR 0667 D4 (PMXWF-11) — 'merge', same reasoning as the agent tool: a run
      // asserting a subset of criteria must not silently clear the others.
      const row = await setIdeaScore(tenantId, surfaceStr(args.listId), surfaceStr(args.cardId), 'workflow', scores, 'workflow', 'merge');
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

    /**
     * Generate a planning-session agenda from a list's top-N ideas.
     *
     * ADR 0667 D3 (PMXWF-9) — claims the SAME `host/ignitionGuard` latch the chat tool
     * already claims for this verb (`agentTools.ts`). This is the RUN lane, and it was
     * the unguarded one: `createPlanningSession` mints a session id PLUS a
     * `board-agenda` Document PLUS an `addVersion`, so a `:fork` (which re-executes
     * everything past the fork point, and mints a FRESH runId — hence no run-derived id
     * can collapse it, per ADR 0590 Decision 4's falsification) duplicated all three.
     *
     * The latch's window is what bounds the dedup. ADR 0590 Decision 4 used "while the
     * approval is still PENDING" to keep decision finality; a session has no such state,
     * so an unbounded content key would have no exit — the same list would return the
     * same agenda forever. An honest re-generation after the window is allowed by design.
     */
    generateAgenda: async (args) => {
      const n = typeof args.n === 'number' ? args.n : 5;
      const listId = surfaceStr(args.listId);
      const name = surfaceOptStr(args.name);
      const key = ignitionKey('priority-matrix.generate-agenda', listId, (name ?? '').toLowerCase(), String(n));
      const claim = await claimIgnition(tenantId, key);
      if (!claim.claimed && claim.existingRunId) {
        const prior = await getSessionRow(tenantId, claim.existingRunId);
        if (prior && prior.listId === listId) {
          return { sessionId: prior.id, name: prior.name, agendaMarkdown: prior.agendaMarkdown, deduped: true, ...(prior.agendaDocumentId ? { agendaDocumentId: prior.agendaDocumentId } : {}) };
        }
      }
      const session = await createPlanningSession(tenantId, listId, 'workflow', {
        ...(name ? { name } : {}),
        mode: 'top-n',
        n,
      });
      await recordIgnitionRun(tenantId, key, session.id);
      return { sessionId: session.id, name: session.name, agendaMarkdown: session.agendaMarkdown, ...(session.agendaDocumentId ? { agendaDocumentId: session.agendaDocumentId } : {}) };
    },

    /** ADR 0235 §D1 — the AI arm: PROPOSE a scenario (stamped
     *  `proposedBy:'agent'`). A scenario is inert until a HUMAN selects it as
     *  plan of record via the route — inherently proposal-safe (the ADR 0231
     *  firewall lesson: node calls bypass the capability firewall, so safety
     *  must be structural, in the owner). */
    proposeScenario: async (args) => {
      const list = await getList(tenantId, surfaceStr(args.listId));
      if (!list) return { scenario: null };
      const scenario = await addScenario({
        tenantId, orgId: list.orgId, listId: list.id,
        sessionId: surfaceStr(args.sessionId),
        actor: surfaceOptStr(args.actor) ?? 'workflow',
        body: {
          name: args.name,
          selection: args.selection,
          ...(args.constraints !== undefined ? { constraints: args.constraints } : {}),
        },
        proposedBy: 'agent',
      });
      return { scenario };
    },

    /** ADR 0232 §7 (grade-code STRAT-PM1) — read an idea's intake overlay +
     *  evidence pointers. Read-only; matches the `submitIdea` content-metadata
     *  class already exposed to runs. */
    getIntake: async (args) => {
      const list = await getList(tenantId, surfaceStr(args.listId));
      if (!list) return { intake: null, evidence: [] };
      const cardId = surfaceStr(args.cardId);
      return { intake: await getIdeaIntake(list.id, cardId), evidence: await listIdeaEvidence(list.id, cardId) };
    },

    /** Update an idea's intake fields (requester/source/estimatedValue/notes).
     *  Same content class as `submitIdea`; every write is audited via
     *  `priorityMutated`. NO promote verb — promotion creates work containers
     *  (authority-granting) and stays human/route-only (architect ruling). */
    updateIntake: async (args) => {
      const list = await getList(tenantId, surfaceStr(args.listId));
      if (!list) return { intake: null };
      const patch = (args.patch && typeof args.patch === 'object') ? args.patch as Record<string, unknown> : {};
      const intake = await upsertIdeaIntake({
        tenantId, orgId: list.orgId, listId: list.id, cardId: surfaceStr(args.cardId),
        actor: surfaceOptStr(args.actor) ?? 'workflow', patch,
      });
      return { intake };
    },

    /** Attach an evidence pointer (document/kb/url) to an idea. */
    addEvidence: async (args) => {
      const list = await getList(tenantId, surfaceStr(args.listId));
      if (!list) return { evidence: null };
      const evidence = await addIdeaEvidence({
        tenantId, orgId: list.orgId, listId: list.id, cardId: surfaceStr(args.cardId),
        actor: surfaceOptStr(args.actor) ?? 'workflow',
        kind: args.kind, ref: args.ref, label: args.label,
      });
      return { evidence };
    },
  };
}
