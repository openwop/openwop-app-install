/**
 * Priority Matrix routes (ADR 0058) — host-extension under
 * /v1/host/openwop-app/priority-matrix/*.
 *
 * Gating order, fail-closed (ADR 0006), mirroring the projects feature's
 * per-entity org gate so a project-scoped list can't be read/mutated across orgs:
 *   1. toggle `priority-matrix` ON for the caller        (requireFeatureEnabled)
 *   2. RBAC IN THE LIST'S ORG — read ops need workspace:read in `list.orgId`
 *      (a caller without it gets a uniform 404, no existence leak); write ops
 *      additionally need workspace:write there.
 *   3. CONFIG AUTHORITY — changing a list's criteria/weights (or deleting it)
 *      requires being the list creator OR holding `host:org:manage` in its org.
 *
 * @see docs/adr/0058-priority-matrix.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { resolveSubjectAccess, levelSatisfies } from '../../host/subjectAccess.js';
import { requireFeatureEnabled, requireString } from '../featureRoute.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import {
  resolveIdeaCancellationLane, resolveIdeaCompletionLane,
  listLists, getList, createList, updateList, deleteList,
  listRankedIdeas, submitIdea, editIdea, deleteIdea, cloneIdea, moveIdeaStatus, setIdeaScore, getVoteBreakdown,
  setIdeaSchedule, clearIdeaSchedule, getScheduleStatus,
  createPlanningSession, updatePlanningSession, listSessions, buildPortfolio, NORMALIZE_MODES, type NormalizeMode,
} from './priorityMatrixService.js';
import { listPeers, addPeer, deletePeer, setPeerCredential, buildFederatedPortfolio } from './federationService.js';
import { getIdeaIntake, listIdeaEvidence, upsertIdeaIntake, addIdeaEvidence, removeIdeaEvidence, mergeIdeaOverlays, markPromoted, assertNotPromoted } from './intake.js';
import { listIdeaScoreHistory } from './scoreHistory.js';
import { addScenario, resolveScenarios, compareScenarios, selectScenario, getScenario } from './scenarios.js';
import { findApprovalForScenario } from '../../host/approvalService.js';
import { claimApproval, rejectApproval } from '../../host/approvalDecision.js';
import { registerScenarioSelectGate } from './scenarioApproval.js';
import { createProject, deleteProject } from '../projects/projectsService.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { CRITERIA_PRESETS, type PriorityList } from './types.js';
import { backfillPriorityMatrixKb, priorityMatrixShareableKbProvider } from './priorityMatrixKnowledgeService.js';
import { registerShareableKb } from '../../host/shareableKb.js';

const TOGGLE_ID = 'priority-matrix';
const LABEL = 'Priority Matrix';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/**
 * PMX-14 (ADR 0590) — the ONE org-scope predicate, EXPORTED so the agent tools
 * import it instead of keeping a byte-parallel copy that can drift (the CRM
 * `orgScopeGranted` pattern — same host function is not enough; it must be the
 * same PREDICATE).
 */
export async function orgScopeGranted(tenantId: string, subject: string | undefined, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  return access.scopes.includes(scope);
}

/** Does the caller hold `scope` in `orgId`? (the tenant owner implicitly holds
 *  every scope in every org — same semantics as the projects feature.) */
async function hasOrgScope(req: Request, orgId: string, scope: Scope): Promise<boolean> {
  return orgScopeGranted(tenantOf(req), actingUserOf(req), orgId, scope);
}

async function requireOrgScopeFor(req: Request, orgId: string, scope: Scope): Promise<void> {
  if (!(await hasOrgScope(req, orgId, scope))) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope, orgId });
  }
}


/**
 * Load a list + gate on the caller's scope IN THE LIST'S ORG. No-existence-leak:
 * a caller without `workspace:read` in the list's org gets a uniform 404 (never
 * learns the id is valid, even tenant-internally). A WRITE op missing write → 403.
 */
/** ADR 0610 D3′ / CPC-14 — a list bound to a project (`list.projectId`) is
 *  membership-scoped: the org gate is NOT sufficient (a private project's list must
 *  not read to a non-member org viewer). Consult the ONE `host/subjectAccess.ts`
 *  seam. Null ⇒ not membership-scoped (an org-scoped list) ⇒ the org gate stands.
 *  READ minimum (a write op's org-write holder resolves to 'write' ≥ 'read'). */
async function projectReadable(req: Request, list: PriorityList): Promise<boolean> {
  if (!list.projectId) return true;
  const level = await resolveSubjectAccess(tenantOf(req), { kind: 'project', id: list.projectId }, actingUserOf(req));
  return level === null || levelSatisfies(level, 'read');
}

async function loadListScoped(req: Request, scope: Scope): Promise<PriorityList> {
  const list = await getList(tenantOf(req), req.params.listId);
  if (!list || !(await hasOrgScope(req, list.orgId, 'workspace:read')) || !(await projectReadable(req, list))) {
    throw new OpenwopError('not_found', 'Priority list not found.', 404, { listId: req.params.listId });
  }
  if (scope !== 'workspace:read') await requireOrgScopeFor(req, list.orgId, scope);
  return list;
}

/** ADR 0058 §8 — the elevated bar for editing the scoring model / deleting a list:
 *  the list creator, or an org admin (`host:org:manage` in the list's org). */
async function requireListConfigAuthority(req: Request, list: PriorityList): Promise<void> {
  const actor = actingUserOf(req);
  if (actor && list.createdBy === actor) return;
  if (await hasOrgScope(req, list.orgId, 'host:org:manage')) return;
  throw new OpenwopError('forbidden_scope', "Changing a list's criteria/weights (or deleting it) requires being the list owner or an org admin.", 403, { requiredScope: 'host:org:manage' });
}

/** The lists in the caller's workspace they can READ (per-org readability filter;
 *  no cross-org leak of a project-scoped list). Optionally narrowed to one org.
 *  Shared by the lists index and the portfolio rollup. */
async function readableLists(req: Request, orgId?: string): Promise<PriorityList[]> {
  const all = await listLists(tenantOf(req));
  const readable = new Map<string, boolean>();
  const out: PriorityList[] = [];
  for (const l of all) {
    if (orgId && l.orgId !== orgId) continue;
    let ok = readable.get(l.orgId);
    if (ok === undefined) { ok = await hasOrgScope(req, l.orgId, 'workspace:read'); readable.set(l.orgId, ok); }
    // ADR 0610 D3′ — org-readable is necessary but not sufficient for a
    // project-bound list; the project membership gate applies per-row.
    if (ok && (await projectReadable(req, l))) out.push(l);
  }
  return out;
}

export function registerPriorityMatrixRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/priority-matrix';
  registerShareableKb(priorityMatrixShareableKbProvider); // ADR 0100 D2
  // CHAT-FIRST-PORT-AUDIT D3 — register the agent-proposed scenario decide handler
  // on the core approvals hook (the inbox claim/reject path AND the page "Select"
  // route both dispatch here for `kind:'pm-scenario-select'`).
  registerScenarioSelectGate();

  // ── built-in criteria presets (static — any authenticated member) ──
  app.get(`${BASE}/presets`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      res.json({ presets: Object.values(CRITERIA_PRESETS) });
    } catch (err) { next(err); }
  });

  // ── reindex into the managed Priority Matrix KB (ADR 0100 Phase 3 backfill) ──
  app.post(`${BASE}/reindex-kb`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString((req.body ?? {})?.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const processed = await backfillPriorityMatrixKb(tenantOf(req), orgId);
      res.json({ processed });
    } catch (err) { next(err); }
  });

  // ── lists ──
  app.get(`${BASE}/lists`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      res.json({ lists: await readableLists(req) });
    } catch (err) { next(err); }
  });

  // ── portfolio: cross-list rollup across the workspace's readable lists (ADR 0060) ──
  app.get(`${BASE}/portfolio`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = typeof req.query.orgId === 'string' && req.query.orgId.length > 0 ? req.query.orgId : undefined;
      const topN = typeof req.query.topN === 'string' ? Number(req.query.topN) : undefined;
      const normalize: NormalizeMode = (NORMALIZE_MODES as readonly string[]).includes(String(req.query.normalize)) ? (req.query.normalize as NormalizeMode) : 'none';
      const lists = await readableLists(req, orgId);
      res.json(await buildPortfolio(tenantOf(req), lists, topN, normalize));
    } catch (err) { next(err); }
  });

  // ── federated peers (app↔app, ADR 0061) — list = workspace:read; mutate = superadmin ──
  app.get(`${BASE}/peers`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await resolveCallerUser(req); // authenticated workspace member; peers are non-secret config
      res.json({ peers: await listPeers(tenantOf(req)) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/peers`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireSuperadmin(req, 'Add a Priority Matrix federation peer');
      res.status(201).json(await addPeer(tenantOf(req), actingUserOf(req) ?? 'unknown', req.body ?? {}));
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/peers/:peerId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await requireSuperadmin(req, 'Remove a Priority Matrix federation peer');
      const ok = await deletePeer(tenantOf(req), req.params.peerId);
      if (!ok) throw new OpenwopError('not_found', 'Peer not found.', 404, { peerId: req.params.peerId });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── set a peer credential (ADR 0062, BYOK-enveloped) — scope:'tenant' (workspace-
  //    shared) is superadmin; scope:'user' (the caller's own, which closes the authz
  //    asymmetry per-user) is any authenticated member. ──
  app.put(`${BASE}/peers/:peerId/credential`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const scope = body.scope === 'user' ? 'user' : 'tenant';
      if (scope === 'tenant') await requireSuperadmin(req, 'Set a Priority Matrix federation peer credential');
      else await resolveCallerUser(req);
      await setPeerCredential(tenantOf(req), req.params.peerId, requireString(body.token, 'token'), scope, actingUserOf(req));
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── federated portfolio: local (RBAC-filtered) + each peer's portfolio, merged. The
  //    per-(peer,user) credential (ADR 0062) makes a peer's slice per-caller when set. ──
  app.get(`${BASE}/portfolio/federated`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      await resolveCallerUser(req); // authenticated; the local slice is org-filtered by readableLists
      const topN = typeof req.query.topN === 'string' ? Number(req.query.topN) : 20;
      const effectiveTopN = Number.isFinite(topN) ? topN : 20;
      const lists = await readableLists(req);
      const local = await buildPortfolio(tenantOf(req), lists, effectiveTopN);
      const peers = await listPeers(tenantOf(req));
      const ctx = { tenantId: tenantOf(req), ...(actingUserOf(req) ? { actingUserId: actingUserOf(req) } : {}) };
      res.json(await buildFederatedPortfolio(local.items, peers, effectiveTopN, ctx));
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/lists`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = requireString((req.body ?? {})?.orgId, 'orgId');
      await requireOrgScopeFor(req, orgId, 'workspace:write');
      const list = await createList(tenantOf(req), orgId, actingUserOf(req) ?? 'unknown', req.body ?? {});
      res.status(201).json(list);
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/lists/:listId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      res.json(await loadListScoped(req, 'workspace:read'));
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/lists/:listId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Editing the scoring model — criteria/weights, the voting mode/aggregation, OR
      // the per-voter weights (ADR 0059) — is the elevated, config-authority gate.
      if (body.criteriaSet !== undefined || body.presetId !== undefined || body.votingMode !== undefined || body.voteAggregation !== undefined || body.voterWeights !== undefined) {
        await requireListConfigAuthority(req, list);
      }
      res.json(await updateList(tenantOf(req), list.id, body, actingUserOf(req) ?? 'unknown'));
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/lists/:listId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      await requireListConfigAuthority(req, list);
      await deleteList(tenantOf(req), list.id, actingUserOf(req) ?? 'unknown');
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── ideas (ranked) + scoring ──
  app.get(`${BASE}/lists/:listId/ideas`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:read');
      // Pass the caller as the voter so multi-voter lists return the caller's own
      // vote (`myScores`) for the editable grid (ADR 0059).
      res.json({ ideas: await listRankedIdeas(tenantOf(req), list.id, actingUserOf(req)) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/lists/:listId/ideas`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const card = await submitIdea(tenantOf(req), list.id, actingUserOf(req) ?? 'unknown', req.body ?? {});
      res.status(201).json(card);
    } catch (err) { next(err); }
  });

  // ── edit / delete / clone an idea (ADR 0259) — workspace:write, same as create ──
  app.patch(`${BASE}/lists/:listId/ideas/:cardId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const card = await editIdea(tenantOf(req), list.id, req.params.cardId ?? '', actingUserOf(req) ?? 'unknown', (req.body ?? {}) as Record<string, unknown>);
      res.json(card);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/lists/:listId/ideas/:cardId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const ok = await deleteIdea(tenantOf(req), list.id, req.params.cardId ?? '', actingUserOf(req) ?? 'unknown');
      if (!ok) throw new OpenwopError('not_found', 'Idea not found in this list.', 404, { cardId: req.params.cardId });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/lists/:listId/ideas/:cardId/clone`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const card = await cloneIdea(tenantOf(req), list.id, req.params.cardId ?? '', actingUserOf(req) ?? 'unknown', (req.body ?? {}) as Record<string, unknown>);
      res.status(201).json(card);
    } catch (err) { next(err); }
  });

  // ── per-voter breakdown (multi-voter; ADR 0059) — config-authority only (votes can
  //    be sensitive; members see only aggregate + their own vote on the ideas read). ──
  app.get(`${BASE}/lists/:listId/ideas/:cardId/votes`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:read');
      await requireListConfigAuthority(req, list);
      res.json({ votes: await getVoteBreakdown(tenantOf(req), list.id, req.params.cardId) });
    } catch (err) { next(err); }
  });

  app.patch(`${BASE}/lists/:listId/ideas/:cardId/status`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const toColumnId = requireString((req.body ?? {})?.columnId, 'columnId');
      const card = await moveIdeaStatus(tenantOf(req), list.id, req.params.cardId, toColumnId, actingUserOf(req) ?? 'unknown');
      if (!card) throw new OpenwopError('not_found', 'Idea or status column not found.', 404, { cardId: req.params.cardId });
      res.json(card);
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/lists/:listId/ideas/:cardId/scores`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const score = await setIdeaScore(tenantOf(req), list.id, req.params.cardId, actingUserOf(req) ?? 'unknown', body.scores);
      res.json(score);
    } catch (err) { next(err); }
  });

  // ── schedule status (ADR 0103) — ahead/behind derivation over target dates ──
  app.get(`${BASE}/lists/:listId/schedule`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:read');
      res.json(await getScheduleStatus(tenantOf(req), list.id));
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/lists/:listId/ideas/:cardId/schedule`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const row = await setIdeaSchedule(tenantOf(req), list.id, req.params.cardId, actingUserOf(req) ?? 'unknown', (req.body ?? {}) as Record<string, unknown>);
      res.json(row);
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/lists/:listId/ideas/:cardId/schedule`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const ok = await clearIdeaSchedule(tenantOf(req), list.id, req.params.cardId, actingUserOf(req) ?? 'unknown');
      if (!ok) throw new OpenwopError('not_found', 'No schedule set for this idea.', 404, { cardId: req.params.cardId });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── scenarios (ADR 0235 §D1): what-if selections under constraint sets ──
  app.post(`${BASE}/lists/:listId/sessions/:sessionId/scenarios`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      res.status(201).json(await addScenario({
        tenantId: tenantOf(req), orgId: list.orgId, listId: list.id, sessionId: req.params.sessionId ?? '',
        actor: actingUserOf(req) ?? 'unknown', body: (req.body ?? {}) as Record<string, unknown>,
      }));
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/lists/:listId/sessions/:sessionId/scenarios`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:read');
      res.json({ scenarios: await resolveScenarios(tenantOf(req), list.id, req.params.sessionId ?? '') });
    } catch (err) { next(err); }
  });

  // Idea movements only — strategy-coverage annotation is FE-composition over
  // the strategyRefs map (the ADR 0079 import direction; architect ruling).
  app.get(`${BASE}/lists/:listId/sessions/:sessionId/scenarios/compare`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:read');
      const a = typeof req.query.a === 'string' ? req.query.a : '';
      const b = typeof req.query.b === 'string' ? req.query.b : '';
      if (!a || !b) throw new OpenwopError('validation_error', 'Query params `a` and `b` (scenario ids) are required.', 400, {});
      res.json(await compareScenarios(tenantOf(req), list.id, req.params.sessionId ?? '', a, b));
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/lists/:listId/sessions/:sessionId/scenarios/:scenarioId/select`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const sessionId = req.params.sessionId ?? '';
      const scenarioId = req.params.scenarioId ?? '';
      const scenario = await getScenario(tenantOf(req), list.id, sessionId, scenarioId);
      if (!scenario) throw new OpenwopError('not_found', 'Scenario not found.', 404, { scenarioId });
      // CHAT-FIRST-PORT-AUDIT D3 — an AGENT-proposed scenario is adopted through
      // its shared approval (the SAME CAS operation as the reviews inbox), so
      // deciding here and from the inbox converge on ONE durable record. A
      // HUMAN-created scenario has no approval and stays a plain select. A missing
      // approval on an agent scenario ⇒ it was already decided ⇒ 409 (the bespoke
      // route can no longer mint a fresh decision without the shared row).
      if (scenario.proposedBy === 'agent') {
        // PMX-6 (ADR 0590) — PENDING-only: the any-status lookup let an
        // already-decided row reach the decision core, whose raw "Approval
        // already rejected." fired instead of this route's well-worded 409.
        const appr = await findApprovalForScenario(tenantOf(req), scenarioId);
        if (!appr || appr.status !== 'pending') throw new OpenwopError('conflict', 'This proposed scenario has already been decided.', 409, { scenarioId });
        const dctx = { storage: deps.storage, hostSuite: deps.hostSuite };
        const ctx = { tenantId: tenantOf(req), ...(actingUserOf(req) ? { decidedBy: actingUserOf(req)! } : {}) };
        await claimApproval(dctx, ctx, appr.approvalId);
        res.json(await getScenario(tenantOf(req), list.id, sessionId, scenarioId));
        return;
      }
      res.json(await selectScenario({
        tenantId: tenantOf(req), orgId: list.orgId, listId: list.id,
        sessionId, scenarioId, actor: actingUserOf(req) ?? 'unknown',
      }));
    } catch (err) { next(err); }
  });

  // PMX-6 / PMXU-2 (ADR 0590) — the page-level REJECT action (the strategy
  // check-in dismiss pattern, strategy/routes.ts): a reviewer on the scenario
  // page can decline an agent proposal without finding the inbox. Decides the
  // SHARED approval row through the one decision core — same CAS, same 409
  // finality — so page and inbox converge on ONE durable record.
  app.post(`${BASE}/lists/:listId/sessions/:sessionId/scenarios/:scenarioId/reject`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const sessionId = req.params.sessionId ?? '';
      const scenarioId = req.params.scenarioId ?? '';
      const scenario = await getScenario(tenantOf(req), list.id, sessionId, scenarioId);
      if (!scenario) throw new OpenwopError('not_found', 'Scenario not found.', 404, { scenarioId });
      if (scenario.proposedBy !== 'agent') {
        throw new OpenwopError('conflict', 'Only an agent-proposed scenario under review can be rejected; a human scenario has no approval to decide.', 409, { scenarioId });
      }
      const appr = await findApprovalForScenario(tenantOf(req), scenarioId);
      if (!appr || appr.status !== 'pending') throw new OpenwopError('conflict', 'This proposed scenario has already been decided.', 409, { scenarioId });
      const dctx = { storage: deps.storage, hostSuite: deps.hostSuite };
      const ctx = { tenantId: tenantOf(req), ...(actingUserOf(req) ? { decidedBy: actingUserOf(req)! } : {}) };
      await rejectApproval(dctx, ctx, appr.approvalId);
      res.json({ scenarioId, approvalStatus: 'rejected' });
    } catch (err) { next(err); }
  });

  // ── score history + "why ranked here" (ADR 0234 §C7 over the ADR 0230 B4 trail) ──
  app.get(`${BASE}/lists/:listId/ideas/:cardId/score-history`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:read');
      const cardId = req.params.cardId ?? '';
      const history = await listIdeaScoreHistory(tenantOf(req), list.id, cardId);
      // The rank explanation: per-criterion weighted components over the idea's
      // CURRENT effective scores (single: the shared row; multi: the aggregate).
      const idea = (await listRankedIdeas(tenantOf(req), list.id)).find((r) => r.card.id === cardId);
      const breakdown = idea
        ? list.criteriaSet.criteria.map((c) => {
            const score = idea.scores[c.id];
            return { criterionId: c.id, name: c.name, weight: c.weight, ...(score !== undefined ? { score, weighted: score * c.weight } : {}) };
          })
        : [];
      res.json({ history, breakdown, ...(idea ? { computedPriority: idea.computedPriority, rank: idea.rank } : {}) });
    } catch (err) { next(err); }
  });

  // ── intake + evidence + merge + promote-to-project (ADR 0232) ──
  app.get(`${BASE}/lists/:listId/ideas/:cardId/intake`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:read');
      res.json({
        intake: await getIdeaIntake(list.id, req.params.cardId ?? ''),
        evidence: await listIdeaEvidence(list.id, req.params.cardId ?? ''),
      });
    } catch (err) { next(err); }
  });

  // The card-exists guard now lives in the intake SERVICE (single owner, so the
  // run-driven surface verbs inherit it too — code-review STRAT-PM1).
  app.patch(`${BASE}/lists/:listId/ideas/:cardId/intake`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      res.json(await upsertIdeaIntake({
        tenantId: tenantOf(req), orgId: list.orgId, listId: list.id, cardId: req.params.cardId ?? '',
        actor: actingUserOf(req) ?? 'unknown', patch: (req.body ?? {}) as Record<string, unknown>,
      }));
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/lists/:listId/ideas/:cardId/evidence`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.status(201).json(await addIdeaEvidence({
        tenantId: tenantOf(req), orgId: list.orgId, listId: list.id, cardId: req.params.cardId ?? '',
        actor: actingUserOf(req) ?? 'unknown', kind: body.kind, ref: body.ref, label: body.label,
      }));
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/lists/:listId/ideas/:cardId/evidence/:evidenceId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const ok = await removeIdeaEvidence(tenantOf(req), list.orgId, list.id, req.params.cardId ?? '', req.params.evidenceId ?? '', actingUserOf(req) ?? 'unknown');
      if (!ok) throw new OpenwopError('not_found', 'Evidence link not found.', 404, {});
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // Merge a duplicate into the canonical idea (ADR 0232 §4): overlays union onto
  // the canonical; the duplicate moves to the terminal cancellation lane. Scores
  // and votes are deliberately NOT merged (re-score the canonical if needed).
  app.post(`${BASE}/lists/:listId/ideas/:cardId/merge`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const duplicateCardId = requireString((req.body ?? {})?.duplicateCardId, 'duplicateCardId');
      const canonicalCardId = req.params.cardId ?? '';
      if (duplicateCardId === canonicalCardId) {
        throw new OpenwopError('validation_error', 'An idea cannot be merged into itself.', 400, {});
      }
      // R2 PM2-M3 — the overlays were COMMITTED first (the intake union, and every
      // evidence row RE-KEYED onto the canonical with a fresh id) and only then was the
      // lane move attempted. On a board whose columns were renamed or replaced — which
      // this feature's own types say is expected ("existing boards keep whatever columns
      // they were created with") — `moveCard` returns null for the unknown `wont-do`,
      // and the route threw "Duplicate idea not found in this list". So the evidence had
      // already moved, the duplicate was left live with none, the user was told the
      // duplicate does not exist, and the retry was a no-op union. Irreversible, because
      // the evidence ids were regenerated. Resolve the lane BEFORE writing anything.
      const moveTarget = await resolveIdeaCancellationLane(tenantOf(req), list.id);
      if (!moveTarget) {
        throw new OpenwopError('validation_error', 'This list\u2019s board has no lane to move a merged duplicate into, so the merge was not applied. Add a cancellation column (e.g. "Won\u2019t do") first.', 400, { listId: list.id });
      }
      await mergeIdeaOverlays({
        tenantId: tenantOf(req), orgId: list.orgId, listId: list.id,
        canonicalCardId, duplicateCardId, actor: actingUserOf(req) ?? 'unknown',
      });
      const moved = await moveIdeaStatus(tenantOf(req), list.id, duplicateCardId, moveTarget, actingUserOf(req) ?? 'unknown');
      if (!moved) throw new OpenwopError('not_found', 'Duplicate idea not found in this list.', 404, { duplicateCardId });
      res.json({ canonicalCardId, duplicateCardId, merged: true });
    } catch (err) { next(err); }
  });

  // Promote-to-project (ADR 0232 §5 — the PM-side half; promote-to-initiative
  // lives on the strategy routes to preserve the strategy→PM import direction).
  app.post(`${BASE}/lists/:listId/ideas/:cardId/promote-to-project`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const cardId = req.params.cardId ?? '';
      const ranked = await listRankedIdeas(tenantOf(req), list.id);
      const idea = ranked.find((r) => r.card.id === cardId);
      if (!idea) throw new OpenwopError('not_found', 'Idea not found in this list.', 404, { cardId });
      // PMX-2 (ADR 0590) — resolve the COMPLETION lane from the board's own
      // columns BEFORE minting anything (the R2 PM2-M3 merge-route pattern):
      // the literal `'done'` failed silently on any renamed board, leaving the
      // card in its old lane while the project minted and `promotedTo` stamped.
      const completionLane = await resolveIdeaCompletionLane(tenantOf(req), list.id);
      if (!completionLane) {
        throw new OpenwopError('validation_error', 'This list’s board has no completion lane to move a promoted idea into, so it was not promoted. Add a completion column (e.g. "Done") first.', 400, { listId: list.id });
      }
      // R2 review — BEFORE minting anything: the 409 used to fire after `createProject`
      // had already written a project that linked to nothing.
      await assertNotPromoted(list.id, cardId);
      const project = await createProject(tenantOf(req), list.orgId, { name: idea.card.title });
      try {
        await markPromoted({
          tenantId: tenantOf(req), orgId: list.orgId, listId: list.id, cardId,
          actor: actingUserOf(req) ?? 'unknown', promotedTo: { kind: 'project', id: project.id },
        });
      } catch (err) {
        // PMX-2 — the stamp race was lost AFTER this request minted its project:
        // compensate (delete the just-minted project) so the 409 leaves no orphan
        // — the exact debris the PM2-M2 note documents.
        try { await deleteProject(tenantOf(req), project.id); } catch { /* best-effort compensation */ }
        throw err;
      }
      // PMX-2 — the move outcome is REPORTED, never swallowed: a card that
      // vanished mid-flight leaves `moved:false` for the caller to surface.
      const movedCard = await moveIdeaStatus(tenantOf(req), list.id, cardId, completionLane, actingUserOf(req) ?? 'unknown');
      res.status(201).json({ projectId: project.id, cardId, moved: movedCard !== null, ...(movedCard ? { movedToColumnId: completionLane } : {}) });
    } catch (err) { next(err); }
  });

  // ── planning sessions (→ meeting agenda) ──
  app.get(`${BASE}/lists/:listId/sessions`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:read');
      res.json({ sessions: await listSessions(tenantOf(req), list.id) });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/lists/:listId/sessions`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const session = await createPlanningSession(tenantOf(req), list.id, actingUserOf(req) ?? 'unknown', req.body ?? {});
      res.status(201).json(session);
    } catch (err) { next(err); }
  });

  // Re-order an existing agenda in place (ADR 0058 — no duplicate session per reorder).
  app.patch(`${BASE}/lists/:listId/sessions/:sessionId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      const session = await updatePlanningSession(tenantOf(req), list.id, req.params.sessionId, actingUserOf(req) ?? 'unknown', req.body ?? {});
      res.json(session);
    } catch (err) { next(err); }
  });
}
