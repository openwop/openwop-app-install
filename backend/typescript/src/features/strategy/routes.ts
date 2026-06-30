/**
 * Strategy routes (ADR 0079) — host-extension under
 * /v1/host/openwop-app/strategy/*.
 *
 * Gating order, fail-closed (ADR 0006). Every strategy carries a MANDATORY
 * `orgId` (the RBAC + IDOR anchor); `scope` is a visibility MODIFIER on top
 * (ADR 0079 §Correction):
 *   1. toggle `strategy` ON for the caller                  (requireFeatureEnabled)
 *   2. READ — `user`: creator only · `org`: workspace:read in `orgId` ·
 *      `workspace`: workspace:read in ANY org of the tenant (broader read). A
 *      caller who fails read gets a uniform 404 (no existence leak).
 *   3. WRITE — `user`: creator only · `org`/`workspace`: workspace:write in the
 *      OWNING `orgId` (visibility ≠ write-authority).
 *   4. CONFIG AUTHORITY — change scope/owner/orgId, archive, or hard-delete:
 *      the creator OR `host:org:manage` in the strategy's org.
 *   5. LINKS — creating a link to a project / priority target requires
 *      workspace:read on that target's org (403 otherwise); context projection
 *      silently OMITS any unreadable linked entity.
 *
 * @see docs/adr/0079-strategic-planning.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { type Scope } from '../../host/accessControlService.js';
import { requireFeatureEnabled, requireString } from '../featureRoute.js';
import { getProject } from '../projects/projectsService.js';
import { getList } from '../priority-matrix/priorityMatrixService.js';
import {
  createStrategy, getStrategy, listStrategies, updateStrategy, archiveStrategy,
  hardDeleteStrategy, replaceLinks, resolveStrategyContext, resolveStrategyHealth, parseLink,
  strategiesLinkingProject, strategiesLinkingPriorityList, strategiesLinkingPriorityIdea,
  strategiesLinkingBoard, subjectHasOrgScope, canSubjectReadStrategy,
  type StrategyListFilter,
} from './strategyService.js';
import {
  STRATEGY_SCOPES, PLANNING_HORIZONS, STRATEGY_STATUSES,
  type Strategy, type StrategyScope, type StrategyLink,
} from './types.js';
import { backfillStrategyKb, strategyShareableKbProvider } from './strategyKnowledgeService.js';
import { registerShareableKb } from '../../host/shareableKb.js';

const TOGGLE_ID = 'strategy';
const LABEL = 'Strategy';
const log = createLogger('features.strategy.routes');

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

// Request-level wrappers over the canonical subject-based RBAC in strategyService
// (one source of the scope rules — the resolver path reuses the same functions).
const hasOrgScope = (req: Request, orgId: string, scope: Scope): Promise<boolean> =>
  subjectHasOrgScope(tenantOf(req), actingUserOf(req), orgId, scope);
const canReadStrategy = (req: Request, s: Strategy): Promise<boolean> =>
  canSubjectReadStrategy(tenantOf(req), actingUserOf(req), s);

/** Can the caller WRITE this strategy? (write always in the owning org; user
 *  scope is creator-only.) */
async function canWriteStrategy(req: Request, s: Strategy): Promise<boolean> {
  if (s.scope === 'user') return actingUserOf(req) === s.createdBy;
  return hasOrgScope(req, s.orgId, 'workspace:write');
}

/**
 * Load a strategy + gate. No-existence-leak: a caller who cannot READ it gets a
 * uniform 404. When `write` is set, additionally require write authority (403).
 */
async function loadStrategyScoped(req: Request, write: boolean): Promise<Strategy> {
  const s = await getStrategy(tenantOf(req), req.params.id);
  if (!s || !(await canReadStrategy(req, s))) {
    // STRAT-2: the response is a uniform 404 (no existence leak), but the LOG
    // distinguishes a genuine access-denial from a truly-missing record so an
    // operator can tell an RBAC mishap from a dead id.
    log.debug('strategy_access_denied', {
      tenantId: tenantOf(req), strategyId: req.params.id, subject: actingUserOf(req),
      reason: s ? 'forbidden_read' : 'not_found', op: write ? 'write' : 'read',
    });
    throw new OpenwopError('not_found', 'Strategy not found.', 404, { id: req.params.id });
  }
  if (write && !(await canWriteStrategy(req, s))) {
    log.debug('strategy_access_denied', {
      tenantId: tenantOf(req), strategyId: s.id, subject: actingUserOf(req), reason: 'forbidden_write', op: 'write',
    });
    throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write' });
  }
  return s;
}

/** The elevated bar for changing scope/owner/org, archiving, or deleting:
 *  the creator, or an org admin (`host:org:manage` in the strategy's org). */
async function requireConfigAuthority(req: Request, s: Strategy): Promise<void> {
  const actor = actingUserOf(req);
  if (actor && s.createdBy === actor) return;
  if (await hasOrgScope(req, s.orgId, 'host:org:manage')) return;
  throw new OpenwopError('forbidden_scope', "Changing a strategy's scope/owner/org, archiving, or deleting it requires being the creator or an org admin.", 403, { requiredScope: 'host:org:manage' });
}

/** The tenant's strategies the caller can READ (per-scope filter). */
async function readableStrategies(req: Request, filter: StrategyListFilter): Promise<Strategy[]> {
  const all = await listStrategies(tenantOf(req), filter);
  const out: Strategy[] = [];
  for (const s of all) if (await canReadStrategy(req, s)) out.push(s);
  return out;
}

/** A patch that changes scope / owner / org or archives is config-sensitive
 *  (ADR 0079 §RBAC). `accountableExecutive` is a descriptive label, not the
 *  system owner (`ownerUserId`), so it stays a plain writable field. */
function patchIsConfigSensitive(body: Record<string, unknown>): boolean {
  return body.scope !== undefined || body.ownerUserId !== undefined || body.orgId !== undefined
    || body.status === 'archived';
}

/** Validate that a link's target is READABLE by the caller (project / priority
 *  targets — the Phase 3/4 consumers). Board / document target-gates land with
 *  their consuming phases. Throws 403 on an unreadable, present target. */
async function requireLinkTargetReadable(req: Request, link: StrategyLink): Promise<void> {
  if (link.kind === 'project') {
    const p = await getProject(tenantOf(req), link.projectId);
    if (!p || !(await hasOrgScope(req, p.orgId, 'workspace:read'))) {
      throw new OpenwopError('forbidden_scope', 'Cannot link a project you cannot read.', 403, { projectId: link.projectId });
    }
  } else if (link.kind === 'priority-list' || link.kind === 'priority-idea') {
    const list = await getList(tenantOf(req), link.listId);
    if (!list || !(await hasOrgScope(req, list.orgId, 'workspace:read'))) {
      throw new OpenwopError('forbidden_scope', 'Cannot link a priority list you cannot read.', 403, { listId: link.listId });
    }
  }
  // advisory-board / document target read-gates land with their consuming phases.
}

const canReadOrgPredicate = (req: Request) => (orgId: string): Promise<boolean> => hasOrgScope(req, orgId, 'workspace:read');

export function registerStrategyRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/strategy';
  registerShareableKb(strategyShareableKbProvider); // ADR 0100 D2 — board can share the Strategy KB

  // ── context: resolve a compact, RBAC-bounded packet for a consumer surface ──
  // (declared BEFORE `/:id` so `/context` isn't captured as an id.)
  app.get(`${BASE}/context`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const projectId = typeof req.query.projectId === 'string' && req.query.projectId.length > 0 ? req.query.projectId : undefined;
      const priorityListId = typeof req.query.priorityListId === 'string' && req.query.priorityListId.length > 0 ? req.query.priorityListId : undefined;
      const cardId = typeof req.query.cardId === 'string' && req.query.cardId.length > 0 ? req.query.cardId : undefined;
      const boardId = typeof req.query.boardId === 'string' && req.query.boardId.length > 0 ? req.query.boardId : undefined;

      let linked: Strategy[];
      if (projectId) linked = await strategiesLinkingProject(tenantOf(req), projectId);
      else if (priorityListId && cardId) linked = await strategiesLinkingPriorityIdea(tenantOf(req), priorityListId, cardId);
      else if (priorityListId) linked = await strategiesLinkingPriorityList(tenantOf(req), priorityListId);
      else if (boardId) linked = await strategiesLinkingBoard(tenantOf(req), boardId);
      else throw new OpenwopError('validation_error', 'One of projectId, priorityListId, or boardId is required.', 400, {});

      const readable: Strategy[] = [];
      for (const s of linked) if (await canReadStrategy(req, s)) readable.push(s);
      const strategies = await resolveStrategyContext(tenantOf(req), readable, actingUserOf(req), canReadOrgPredicate(req));
      res.json({ strategies });
    } catch (err) { next(err); }
  });

  // ── health: per-strategy rollup over the caller's readable portfolio (ADR 0080) ──
  // (declared BEFORE `/:id` so `/health` isn't captured as an id.)
  app.get(`${BASE}/health`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const readable = await readableStrategies(req, { includeArchived: false });
      const strategies = await resolveStrategyHealth(tenantOf(req), readable, actingUserOf(req), canReadOrgPredicate(req));
      res.json({ strategies });
    } catch (err) { next(err); }
  });

  // ── list ──
  app.get(`${BASE}`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const filter: StrategyListFilter = { includeArchived: req.query.includeArchived === 'true' };
      if (typeof req.query.orgId === 'string' && req.query.orgId.length > 0) filter.orgId = req.query.orgId;
      if (typeof req.query.scope === 'string' && (STRATEGY_SCOPES as readonly string[]).includes(req.query.scope)) filter.scope = req.query.scope as StrategyScope;
      if (typeof req.query.horizon === 'string' && (PLANNING_HORIZONS as readonly string[]).includes(req.query.horizon)) filter.horizon = req.query.horizon as Strategy['planningHorizon'];
      if (typeof req.query.status === 'string' && (STRATEGY_STATUSES as readonly string[]).includes(req.query.status)) filter.status = req.query.status as Strategy['status'];
      res.json({ strategies: await readableStrategies(req, filter) });
    } catch (err) { next(err); }
  });

  // ── create ──
  app.post(`${BASE}`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = requireString(body.orgId, 'orgId');
      // WRITE authority in the owning org. (user-scope is creator-only, but the
      // creator must still be able to write in some org they belong to.)
      if (!(await hasOrgScope(req, orgId, 'workspace:write'))) {
        throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write', orgId });
      }
      const created = await createStrategy(tenantOf(req), orgId, actingUserOf(req) ?? 'unknown', body);
      res.status(201).json(created);
    } catch (err) { next(err); }
  });

  // ── reindex into the managed Strategy KB (ADR 0100 Phase 3 backfill) ──
  // Reconciles EVERY strategy in the org against the KB — for entities that
  // predate the toggles flipping on (always-on gating only catches future CRUD).
  app.post(`${BASE}/reindex-kb`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = requireString(body.orgId, 'orgId');
      if (!(await hasOrgScope(req, orgId, 'workspace:write'))) {
        throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write', orgId });
      }
      const processed = await backfillStrategyKb(tenantOf(req), orgId);
      res.json({ processed });
    } catch (err) { next(err); }
  });

  // ── get one ──
  app.get(`${BASE}/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      res.json(await loadStrategyScoped(req, false));
    } catch (err) { next(err); }
  });

  // ── update ──
  app.patch(`${BASE}/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const s = await loadStrategyScoped(req, true);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (patchIsConfigSensitive(body)) await requireConfigAuthority(req, s);
      res.json(await updateStrategy(tenantOf(req), s.id, body));
    } catch (err) { next(err); }
  });

  // ── delete: soft-archive by default; hard-delete only user-scoped drafts ──
  app.delete(`${BASE}/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const s = await loadStrategyScoped(req, true);
      await requireConfigAuthority(req, s);
      // Hard-delete is permitted for ANY scope — the elevated config-authority
      // check above (creator or org admin) is the gate. Soft-archive stays the
      // default (no `?hard=true`) so shared history is preserved unless an
      // authorized user explicitly chooses to remove it.
      const hard = req.query.hard === 'true';
      if (hard) {
        await hardDeleteStrategy(tenantOf(req), s.id);
        res.status(204).end();
      } else {
        res.json(await archiveStrategy(tenantOf(req), s.id));
      }
    } catch (err) { next(err); }
  });

  // ── links: replace/upsert (read-target + write-strategy gated) ──
  app.put(`${BASE}/:id/links`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const s = await loadStrategyScoped(req, true);
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const linksRaw = Array.isArray(raw.links) ? raw.links : [];
      const links: StrategyLink[] = linksRaw.map(parseLink);
      for (const l of links) await requireLinkTargetReadable(req, l);
      res.json(await replaceLinks(tenantOf(req), s.id, links));
    } catch (err) { next(err); }
  });
}
