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
import { requireFeatureEnabled, requireString } from '../featureRoute.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import {
  listLists, getList, createList, updateList, deleteList,
  listRankedIdeas, submitIdea, moveIdeaStatus, setIdeaScore, getVoteBreakdown,
  setIdeaSchedule, clearIdeaSchedule, getScheduleStatus,
  createPlanningSession, updatePlanningSession, listSessions, buildPortfolio, NORMALIZE_MODES, type NormalizeMode,
} from './priorityMatrixService.js';
import { listPeers, addPeer, deletePeer, setPeerCredential, buildFederatedPortfolio } from './federationService.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { CRITERIA_PRESETS, type PriorityList } from './types.js';
import { backfillPriorityMatrixKb, priorityMatrixShareableKbProvider } from './priorityMatrixKnowledgeService.js';
import { registerShareableKb } from '../../host/shareableKb.js';

const TOGGLE_ID = 'priority-matrix';
const LABEL = 'Priority Matrix';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/** Does the caller hold `scope` in `orgId`? (the tenant owner implicitly holds
 *  every scope in every org — same semantics as the projects feature.) */
async function hasOrgScope(req: Request, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req), orgId });
  return access.scopes.includes(scope);
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
async function loadListScoped(req: Request, scope: Scope): Promise<PriorityList> {
  const list = await getList(tenantOf(req), req.params.listId);
  if (!list || !(await hasOrgScope(req, list.orgId, 'workspace:read'))) {
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
    if (ok) out.push(l);
  }
  return out;
}

export function registerPriorityMatrixRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/priority-matrix';
  registerShareableKb(priorityMatrixShareableKbProvider); // ADR 0100 D2

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
      res.json(await updateList(tenantOf(req), list.id, body));
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/lists/:listId`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const list = await loadListScoped(req, 'workspace:write');
      await requireListConfigAuthority(req, list);
      await deleteList(tenantOf(req), list.id);
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
      const card = await moveIdeaStatus(tenantOf(req), list.id, req.params.cardId, toColumnId);
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
      const ok = await clearIdeaSchedule(tenantOf(req), list.id, req.params.cardId);
      if (!ok) throw new OpenwopError('not_found', 'No schedule set for this idea.', 404, { cardId: req.params.cardId });
      res.status(204).end();
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
