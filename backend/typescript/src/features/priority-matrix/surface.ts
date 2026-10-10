/**
 * Priority Matrix workflow surface (ADR 0058 / ADR 0014 Phase 1) — the typed
 * `ctx.features['priority-matrix']` a workflow node calls. Tenant comes from the
 * run scope (CTI-1); toggle-gated at the registry seam (featureSurfaces.gate).
 * Reads are replay-safe; the write methods are intended for `role:action` pack
 * nodes (recorded → replay reads the recorded output, no re-issue).
 *
 * ADR 0842 D1 — WHO the run is for. This surface used to resolve every verb by tenant
 * alone ("a run is tenant-trusted"), the premise ADR 0597 §Correction 1 falsified for
 * strategy: `scope.actingUserId` is the run owner's durable principal for every
 * HUMAN-started run (re-stamped to the forking person on `:fork`). So an org-A editor's
 * workflow read org-B lists and scored, filed, annotated and planned on them while the
 * route, the agent tool and the KB all refused the same person.
 *
 * Now, with an actor, every verb applies the routes' rule (`listAccess.ts`): an
 * unreadable list is indistinguishable from a missing one, and a write needs
 * `workspace:write` in the list's org. WITHOUT an actor (a webhook-fired or system run —
 * the `forms-intake` chain is one) the surface stays tenant-trusted, as before: there is
 * no person to narrow to, and narrowing to "nobody" would stop the forms bridge filing.
 * Every verb is classified in `adr0842-priority-matrix-access.test.ts`; a new one fails
 * that ratchet until it is.
 *
 * @see docs/adr/0058-priority-matrix.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { type FeatureSurface, surfaceStr, surfaceOptStr } from '../../host/featureSurfaces.js';
import { listLists, listRankedIdeas, submitIdea, setIdeaScore, createPlanningSession, buildPortfolio, getScheduleStatus, getList, getSessionRow } from './priorityMatrixService.js';
import { addScenario } from './scenarios.js';
import { ignitionKey, claimIgnition, recordIgnitionRun } from '../../host/ignitionGuard.js';
import { getIdeaIntake, listIdeaEvidence, upsertIdeaIntake, addIdeaEvidence } from './intake.js';
import { listAccessLevel, orgScopeGranted, listProjectReadable } from './listAccess.js';
import { OpenwopError } from '../../types.js';
import type { PriorityList } from './types.js';

export function buildPriorityMatrixSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const actor = scope.actingUserId;
  const notFound = (listId: string): OpenwopError => new OpenwopError('not_found', 'Priority list not found.', 404, { listId });
  /** ADR 0842 D1 — the lists this run may read (all of them for an actorless run). */
  const readableLists = async (): Promise<PriorityList[]> => {
    const all = await listLists(tenantId);
    if (!actor) return all;
    // The org half of the rule is per-org: resolve it once per org, the project half per row.
    const orgRead = new Map<string, Promise<boolean>>();
    const out: PriorityList[] = [];
    for (const l of all) {
      let ok = orgRead.get(l.orgId);
      if (!ok) { ok = orgScopeGranted(tenantId, actor, l.orgId, 'workspace:read'); orgRead.set(l.orgId, ok); }
      if ((await ok) && (await listProjectReadable(tenantId, l, actor))) out.push(l);
    }
    return out;
  };
  /** A list this run may read, or null — null is exactly what a missing id yields. */
  const readList = async (listId: string): Promise<PriorityList | null> => {
    const list = await getList(tenantId, listId);
    if (!list || !actor) return list;
    return (await listAccessLevel(tenantId, list, actor)) === 'none' ? null : list;
  };
  /** Refuse a read on an unreadable list with the error a missing one produces. */
  const assertReadable = async (listId: string): Promise<void> => {
    if (!(await readList(listId))) throw notFound(listId);
  };
  /** A list this run may WRITE: the route's 404/403 split. */
  const writeList = async (listId: string): Promise<PriorityList> => {
    const list = await getList(tenantId, listId);
    if (!list) throw notFound(listId);
    if (!actor) return list;
    const level = await listAccessLevel(tenantId, list, actor);
    if (level === 'none') throw notFound(listId);
    if (level !== 'write') throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write', orgId: list.orgId });
    return list;
  };
  return {
    /** The workspace's priority lists (id, name, scoping) this run may read. */
    listLists: async () => ({
      lists: (await readableLists()).map((l) => ({
        listId: l.id,
        name: l.name,
        boardId: l.boardId,
        ...(l.projectId ? { projectId: l.projectId } : {}),
        criteria: l.criteriaSet.criteria.map((c) => ({ id: c.id, name: c.name, weight: c.weight, direction: c.direction })),
      })),
    }),

    /** A list's ideas ranked by computed weighted priority (descending). */
    listRankedIdeas: async (args) => {
      await assertReadable(surfaceStr(args.listId));
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
      await writeList(listId);
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
      await writeList(surfaceStr(args.listId));
      const row = await setIdeaScore(tenantId, surfaceStr(args.listId), surfaceStr(args.cardId), 'workflow', scores, 'workflow', 'merge');
      return { cardId: row.cardId, computedPriority: row.computedPriority };
    },

    /** The workspace portfolio — ideas across the lists this run may read, ranked by
     *  computed priority (ADR 0060). ADR 0842 D1: the REST route's per-org + project
     *  filter for a human-started run; every list for an actorless one. */
    listPortfolio: async (args) => {
      const topN = typeof args.topN === 'number' ? args.topN : undefined;
      const portfolio = await buildPortfolio(tenantId, await readableLists(), topN);
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
      await assertReadable(surfaceStr(args.listId));
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
      await writeList(listId);
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
      // ADR 0842 D1 — a missing OR unreadable list keeps the historical `{scenario:null}`
      // (no existence oracle); a readable-but-unwritable one is refused like the route.
      if (!(await readList(surfaceStr(args.listId)))) return { scenario: null };
      const list = await writeList(surfaceStr(args.listId));
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
      const list = await readList(surfaceStr(args.listId));
      if (!list) return { intake: null, evidence: [] };
      const cardId = surfaceStr(args.cardId);
      return { intake: await getIdeaIntake(list.id, cardId), evidence: await listIdeaEvidence(list.id, cardId) };
    },

    /** Update an idea's intake fields (requester/source/estimatedValue/notes).
     *  Same content class as `submitIdea`; every write is audited via
     *  `priorityMutated`. NO promote verb — promotion creates work containers
     *  (authority-granting) and stays human/route-only (architect ruling). */
    updateIntake: async (args) => {
      if (!(await readList(surfaceStr(args.listId)))) return { intake: null }; // missing ≡ unreadable
      const list = await writeList(surfaceStr(args.listId));
      const patch = (args.patch && typeof args.patch === 'object') ? args.patch as Record<string, unknown> : {};
      const intake = await upsertIdeaIntake({
        tenantId, orgId: list.orgId, listId: list.id, cardId: surfaceStr(args.cardId),
        actor: surfaceOptStr(args.actor) ?? 'workflow', patch,
      });
      return { intake };
    },

    /** Attach an evidence pointer (document/kb/url) to an idea. */
    addEvidence: async (args) => {
      if (!(await readList(surfaceStr(args.listId)))) return { evidence: null }; // missing ≡ unreadable
      const list = await writeList(surfaceStr(args.listId));
      const evidence = await addIdeaEvidence({
        tenantId, orgId: list.orgId, listId: list.id, cardId: surfaceStr(args.cardId),
        actor: surfaceOptStr(args.actor) ?? 'workflow',
        kind: args.kind, ref: args.ref, label: args.label,
      });
      return { evidence };
    },
  };
}
