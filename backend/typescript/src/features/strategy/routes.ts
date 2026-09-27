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
import { getOrg, type Scope } from '../../host/accessControlService.js';
import { requireFeatureEnabled, requireString } from '../featureRoute.js';
import { getProject } from '../projects/projectsService.js';
import { getList, listRankedIdeas, moveIdeaStatus, resolveIdeaCompletionLane } from '../priority-matrix/priorityMatrixService.js';
import { assertNotPromoted, markPromoted } from '../priority-matrix/intake.js';
import {
  createStrategy, getStrategy, listStrategies, updateStrategy, archiveStrategy,
  hardDeleteStrategy, replaceLinks, resolveStrategyContext, resolveStrategyHealth, parseLink,
  strategiesLinkingProject, strategiesLinkingPriorityList, strategiesLinkingPriorityIdea,
  strategiesLinkingBoard, subjectHasOrgScope, subjectHasTenantScope, canSubjectReadStrategy, orgReadPredicate,
  type StrategyListFilter,
} from './strategyService.js';
import {
  STRATEGY_SCOPES, PLANNING_HORIZONS, STRATEGY_STATUSES, STRATEGY_LIMITS,
  type Strategy, type StrategyScope, type StrategyLink,
} from './types.js';
import { backfillStrategyKb, strategyShareableKbProvider } from './strategyKnowledgeService.js';
import { registerShareableKb } from '../../host/shareableKb.js';
import { strategyMutated } from './emit.js';
import { listStrategyRevisions, getStrategyRevision } from './revisions.js';
import { appendCheckIn, getCheckIn, listCheckIns } from './checkIns.js';
import { getCadenceConfig, applyCadenceConfig } from './cadence.js';
import { resolveStrategyTimeline } from './timeline.js';
import { hasPendingApprovalForStrategy, getApproval, findApprovalForCheckIn, closePendingStrategyActivationApprovals } from '../../host/approvalService.js';
import { claimApproval, rejectApproval } from '../../host/approvalDecision.js';
import { registerStrategyCheckInGate } from './checkInApproval.js';
import { createDocument, addVersion } from '../documents/documentsService.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import {
  queueStrategyActivationIfGated, strategyGateEnabled, registerStrategyActivationGate,
  PROTECTED_FIELDS, STRATEGY_GATE_TOGGLE_ID,
  requiresActivationApproval, protectedEditRequiresReapproval,
} from './activationApproval.js';
import { registerToggleDefault } from '../../host/featureToggles/registry.js';

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

/**
 * Validate that a link's target grants the caller `scope` (project / priority
 * targets — the Phase 3/4 consumers). Board / document target-gates land with
 * their consuming phases. Throws 403 on a present-but-unauthorized target.
 *
 * ADR 0597 §4 (SPC-3) — this existed ONLY in its `workspace:read` form, and the
 * promote lane called that form and then WROTE to the target board (the intake
 * stamp + the completion-lane move). The scope is a PARAMETER now so the two
 * lanes cannot diverge: a caller that needs write asks for write, from the same
 * function.
 */
async function requireLinkTargetScope(req: Request, link: StrategyLink, scope: Scope): Promise<void> {
  const verb = scope === 'workspace:write' ? 'write to' : 'read';
  if (link.kind === 'project') {
    const p = await getProject(tenantOf(req), link.projectId);
    if (!p || !(await hasOrgScope(req, p.orgId, scope))) {
      throw new OpenwopError('forbidden_scope', `Cannot use a project you cannot ${verb}.`, 403, { projectId: link.projectId, requiredScope: scope });
    }
  } else if (link.kind === 'priority-list' || link.kind === 'priority-idea') {
    const list = await getList(tenantOf(req), link.listId);
    if (!list || !(await hasOrgScope(req, list.orgId, scope))) {
      throw new OpenwopError('forbidden_scope', `Cannot use a priority list you cannot ${verb}.`, 403, { listId: link.listId, requiredScope: scope });
    }
  }
  // advisory-board / document target-gates land with their consuming phases.
}

/** LINKING a target needs only read — a link is a reference, not a mutation. */
const requireLinkTargetReadable = (req: Request, link: StrategyLink): Promise<void> =>
  requireLinkTargetScope(req, link, 'workspace:read');

/**
 * ADR 0597 §4 (SPC-4) — RELOCATING a strategy into `targetOrgId` is gated on the
 * DESTINATION, exactly as CREATING one is (`POST /strategy` requires
 * `workspace:write` in the org it will live in). `requireConfigAuthority`
 * checks the strategy's CURRENT org and the creator short-circuits it outright,
 * so before this a creator could `PATCH {orgId: <any org>}` and land their
 * content in an org they hold nothing in — where `indexStrategy` files it into
 * that org's managed Strategy KB as `contentTrust: 'trusted'`, retrievable by
 * that org's agents and advisory boards.
 *
 * The org must also EXIST IN THIS TENANT: `updateStrategy` accepted any string
 * as an `orgId`, which would mint a KB collection under a fabricated org id.
 */
async function requireOrgRelocationTarget(req: Request, targetOrgId: string): Promise<void> {
  const org = await getOrg(targetOrgId);
  if (!org || org.tenantId !== tenantOf(req) || !(await hasOrgScope(req, targetOrgId, 'workspace:write'))) {
    log.debug('strategy_access_denied', {
      tenantId: tenantOf(req), subject: actingUserOf(req), reason: 'forbidden_relocation_target', orgId: targetOrgId,
    });
    throw new OpenwopError(
      'forbidden_scope',
      'Moving a strategy into another organization requires workspace:write in the DESTINATION organization.',
      403,
      { requiredScope: 'workspace:write', orgId: targetOrgId },
    );
  }
}

/**
 * The `workspace:read` org predicate handed to every projection.
 *
 * ADR 0597 §Correction 1/5 — delegates to the ONE rule in `strategyService`
 * (this was the third hand-written copy) and is MEMOIZED per construction: each
 * evaluation is a `resolveEffectiveAccess` → `members.list()` full scan with no
 * cache of its own, and the projections call it once per link. Construct it
 * ONCE PER REQUEST — hoisted out of the portfolio fan-out below, not rebuilt
 * inside the `.map`, or every strategy gets a fresh empty cache and the memo
 * buys nothing across the portfolio (which is exactly where the fan-out is).
 */
const canReadOrgPredicate = (req: Request) => orgReadPredicate(tenantOf(req), actingUserOf(req));

/**
 * ADR 0597 §Correction 4 — withdraw a pending activation review whose PROTECTED
 * content just changed, so an approver can never activate objectives they were
 * never shown.
 *
 * ONE rule, called by every verb that can rewrite a protected field. There are
 * TWO: `PATCH /:id` and `POST /:id/versions/:n/restore` — restore writes all
 * four (`planningHorizon`, `period`, `objectives`, `accountableExecutive`) and
 * does not pass through the gate block at all, which is how the identical
 * escalation lived one verb away from the one the review found. A second
 * hand-written copy is what SPC-2 was; this is a function.
 *
 * Presence-based, exactly like the `autoRevertedFields` rule it sits beside: a
 * protected key being WRITTEN is the trigger, not a value diff. Deliberate — a
 * value-diff rule is a different (and unmeasured) semantics, and splitting the
 * two rules apart is how they drift.
 *
 * Returns true when a review was withdrawn, so the caller can SAY SO. Never
 * silent: the owner's own edit retracted their submission.
 */
async function withdrawActivationReview(
  gateOn: boolean,
  tenantId: string,
  strategy: Strategy,
  actor: string,
  changed: string[],
): Promise<boolean> {
  if (!gateOn) return false;
  const closed = await closePendingStrategyActivationApprovals(
    tenantId, strategy.id,
    "The strategy's protected content changed after this was submitted, so the review was withdrawn. Re-submit it to activate.",
  );
  if (closed === 0) return false;
  strategyMutated({ entity: 'strategy', verb: 'activation-withdrawn', tenantId, actor, strategyId: strategy.id, orgId: strategy.orgId, changed });
  return true;
}

export function registerStrategyRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/strategy';
  registerShareableKb(strategyShareableKbProvider); // ADR 0100 D2 — board can share the Strategy KB
  // ADR 0230 §B3 — register the strategy-activation decision handler on the
  // core approvals hook (the inbox claim/reject path dispatches here for
  // `kind:'strategy-activation'` rows). Direction: feature → core only.
  registerStrategyActivationGate();
  // CHAT-FIRST-PORT-AUDIT D3 — register the agent-proposed check-in decide handler
  // on the core approvals hook (the inbox claim/reject path AND the page
  // confirm/dismiss route both dispatch here for `kind:'strategy-checkin'`).
  registerStrategyCheckInGate();
  // ADR 0230 §B3 — interrupt-backed activation gate (opt-in). When ON, a PATCH
  // moving a strategy draft→active queues a strategy-activation approval in the
  // shared ApprovalsInbox instead of transitioning, and protected-field edits
  // on an active strategy auto-revert it to draft (visible, audited). OFF ⇒
  // every path byte-identical (the cms-approval-gate posture, ADR 0066).
  registerToggleDefault({
    id: STRATEGY_GATE_TOGGLE_ID,
    label: 'Strategy activation approval gate',
    description: 'Gate strategy activation (draft → active) on a human approval surfaced in the Approvals inbox, with protected-field re-approval on active strategies (ADR 0230). OFF ⇒ status-only workflow.',
    category: 'Leadership',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'strategy-approval-gate-v1',
  });

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
      const actor = actingUserOf(req) ?? 'unknown';
      const created = await createStrategy(tenantOf(req), orgId, actor, body);
      strategyMutated({ entity: 'strategy', verb: 'created', tenantId: tenantOf(req), actor, strategyId: created.id, orgId: created.orgId });
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

  // ── cadence (ADR 0231 §C2/§C3): reconcile the scheduled chains ──
  // (declared BEFORE `/:id` so `/cadence` isn't captured as an id.)
  app.get(`${BASE}/cadence`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      if (!(await subjectHasTenantScope(tenantOf(req), actingUserOf(req), 'workspace:write'))) {
        throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write' });
      }
      res.json({ config: await getCadenceConfig(tenantOf(req)) });
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/cadence`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const actor = actingUserOf(req);
      if (!actor || !(await subjectHasTenantScope(tenantOf(req), actor, 'workspace:write'))) {
        throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Each entry carries its own `{enabled, cron, timezone?, params?}` —
      // `params` is ADR 0597 §5 (a chain whose REQUIRED parameters nothing could
      // supply registered a permanently-failing job after a 200 OK).
      const config = await applyCadenceConfig({
        tenantId: tenantOf(req),
        ownerUserId: actor,
        weeklyCheckin: body.weeklyCheckin,
        metricSync: body.metricSync,
        boardPack: body.boardPack,
      });
      strategyMutated({ entity: 'strategy', verb: 'cadence-updated', tenantId: tenantOf(req), actor, strategyId: 'cadence' });
      res.json({ config });
    } catch (err) { next(err); }
  });

  // ── timeline: the caller's readable PORTFOLIO (ADR 0234 §C6) ──
  // (declared BEFORE `/:id` so `/timeline` isn't captured as an id.)
  app.get(`${BASE}/timeline`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const readable = await readableStrategies(req, { includeArchived: false });
      // ADR 0597 §Correction 5 — ONE memoized predicate for the whole fan-out.
      // Built inside the `.map` it was a fresh cache per strategy, i.e. one
      // uncached member-table scan per (strategy × priority link) over an org
      // id set that repeats almost entirely.
      const canReadOrg = canReadOrgPredicate(req);
      const items = (await Promise.all(readable.map((s) => resolveStrategyTimeline(tenantOf(req), s, actingUserOf(req), canReadOrg)))).flat();
      res.json({ items });
    } catch (err) { next(err); }
  });

  // ── get one ──
  app.get(`${BASE}/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const s = await loadStrategyScoped(req, false);
      // ADR 0230 §B3 (architect Q2) — `activationPending` is a PROJECTION over
      // the pending-approval lookup, never stored on the entity. Only a draft
      // can be awaiting activation, so the lookup is skipped otherwise.
      // ADR 0597 §3 — a pending activation is no longer necessarily over a
      // DRAFT: the gate fires on the destination, so paused/completed/archived
      // can all be awaiting activation. Keyed on "not yet active" instead.
      const pending = s.status !== 'active' && (await hasPendingApprovalForStrategy(tenantOf(req), s.id));
      res.json({ ...s, ...(pending ? { activationPending: true } : {}) });
    } catch (err) { next(err); }
  });

  // ── get one, RESOLVED: the same context packet consumers get, for ONE
  //    strategy (strategy-gap A3 — the detail page renders linked idea
  //    scores/ranks + project health from this in ONE fetch, never an N+1
  //    per-list fan-out). Same read gate + uniform 404 as `GET /:id`; per-link
  //    RBAC (private projects, unreadable orgs) is enforced INSIDE
  //    `resolveStrategyContext` (STRAT-2 drop semantics, ADR 0079 §5). ──
  app.get(`${BASE}/:id/context`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const s = await loadStrategyScoped(req, false);
      const entries = await resolveStrategyContext(tenantOf(req), [s], actingUserOf(req), canReadOrgPredicate(req));
      res.json({ strategy: entries[0] ?? null });
    } catch (err) { next(err); }
  });

  // ── update ──
  app.patch(`${BASE}/:id`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const s = await loadStrategyScoped(req, true);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (patchIsConfigSensitive(body)) await requireConfigAuthority(req, s);
      // ADR 0597 §4 — CREATION is gated on the destination org; RELOCATION was
      // not. `requireConfigAuthority` above only ever looks at the OLD org.
      if (typeof body.orgId === 'string' && body.orgId !== s.orgId) {
        await requireOrgRelocationTarget(req, body.orgId);
      }
      const tenantId = tenantOf(req);
      const actor = actingUserOf(req) ?? 'unknown';

      // ADR 0230 §B3 — the activation gate. Mixed-patch semantics (architect
      // Q2): the other fields apply; the status flip is intercepted and queued.
      let patch: Record<string, unknown> = body;
      // ADR 0597 §Correction 3 — the gate's DECISION is made here; its SIDE
      // EFFECT (queueing the approval) happens after `updateStrategy`, which is
      // the validator. It used to happen before, so `PATCH {status:'active',
      // planningHorizon:'not-a-horizon'}` returned 400, changed nothing, and
      // left a LIVE pending approval — an approver holding a request to
      // activate a strategy whose owner was told the change was rejected.
      // Pre-existing, but §3 widened the reachable origins from `draft` alone to
      // {draft, paused, completed, archived}, so every one of them inherited it.
      // Same write-then-validate family as §Correction 2 in `cadence.ts`, and
      // the same rule closes both: decide, validate, THEN write.
      let queueActivation = false;
      let autoReverted = false;
      const gateOn = await strategyGateEnabled(tenantId);
      const touchesProtected = PROTECTED_FIELDS.some((f) => body[f] !== undefined);
      if (gateOn) {
        // ADR 0597 §3 — the gate is expressed over the STATE SET, in
        // `activationApproval.STATUS_GATE_POSTURE`, not over the transitions
        // someone enumerated here.
        //
        // It shipped as `body.status === 'active' && s.status === 'draft'` plus a
        // protected-field branch scoped to `s.status === 'active'`. `paused`
        // matched NEITHER, so pause → edit protected fields → activate bypassed
        // the whole gate in three ordinary PATCHes. An earlier R2 review had
        // already fixed one instance of this class here (`body.status ===
        // undefined` "was the wrong test") and still left the cure keyed on the
        // origin state — which is why the rule now lives in a total function of
        // the status union instead of in this `if`.
        const nextStatus = typeof body.status === 'string' ? body.status : s.status;
        if (requiresActivationApproval(s.status, nextStatus)) {
          // Mixed-patch semantics (architect Q2) are unchanged: the other fields
          // apply, the status flip is withheld and queued.
          patch = { ...body };
          delete patch.status;
          queueActivation = true;
        } else if (touchesProtected && protectedEditRequiresReapproval(s.status)) {
          // Protected-field re-approval (architect Q4) — visible auto-revert:
          // the response returns status:'draft'; audit + event carry the marker.
          patch = { ...body, status: 'draft' };
          autoReverted = true;
        }
      }

      const updated = await updateStrategy(tenantId, s.id, patch, actor);
      // ADR 0597 §Correction 3 — the write the caller asked for is now VALID and
      // applied; only now is it honest to queue a review of it. `updated` rather
      // than `s`: the same PATCH may have changed the title (and, with a
      // relocation, the org), and an approval card must name the strategy as it
      // now stands, in the org whose approvers actually hold authority over it.
      // `status` was stripped from the patch above, so `updated.status` is still
      // the ORIGIN status `strategyFromStatus` must record.
      // ADR 0597 §Correction 4 — APPROVE WHAT YOU SEE, checked rather than
      // asserted. `decideStrategyActivation` enforces it by comparing the
      // strategy's current status against the `strategyFromStatus` frozen at
      // queue time, and §3 claimed that made the guarantee hold "for every
      // origin state". It does not: the compare only catches an edit that MOVES
      // THE STATUS, and whether a protected edit moves it is decided by
      // `protectedEditRequiresReapproval` — false for `draft` (unapproved) and
      // false for the terminal states (no un-archive on a plain write). So a
      // protected-field rewrite while a review was pending sailed through from
      // `draft`, `completed` AND `archived`, and the approver activated content
      // nobody had shown them. It held for `paused` alone, and only because the
      // auto-revert happens to move the status the compare reads.
      //
      // The cure is NOT to widen the revert — that re-opens the escalation the
      // terminal carve-out correctly refuses. The submission is WITHDRAWN
      // instead: the content under review changed, so there is nothing left to
      // approve. One rule for every origin, and it runs BEFORE the queue below
      // so `PATCH {status:'active', objectives:<swapped>}` against an already
      // pending review replaces that review rather than inheriting it.
      const activationReviewClosed = touchesProtected
        && await withdrawActivationReview(gateOn, tenantId, updated, actor, PROTECTED_FIELDS.filter((f) => body[f] !== undefined));
      const activationQueued = queueActivation
        ? await queueStrategyActivationIfGated(tenantId, updated, actor)
        : false;
      const changed = Object.keys(body);
      const verb = updated.status !== s.status && ['active', 'paused', 'completed', 'archived'].includes(updated.status)
        ? (updated.status === 'active' ? 'activated' : updated.status)
        : 'updated';
      strategyMutated({
        entity: 'strategy', verb: autoReverted ? 'updated' : verb, tenantId, actor,
        strategyId: updated.id, orgId: updated.orgId, changed,
        ...(autoReverted ? { autoRevertedToDraft: true } : {}),
      });
      const pending = activationQueued || (updated.status !== 'active' && (await hasPendingApprovalForStrategy(tenantId, updated.id)));
      // R2 STR2-M5 — the comment above says "visible auto-revert: the response returns
      // status:'draft'". A status field flipping is not a message: the user edits one
      // key-result title, Save succeeds, and the chip silently reads Draft — the strategy
      // is DEACTIVATED, no approval was queued (nothing to queue: the edit is what
      // reverted it), and no copy anywhere explains it. The marker rode the event and the
      // audit and never reached the client, so the screen could not say what happened.
      res.json({
        ...updated,
        ...(pending ? { activationPending: true } : {}),
        ...(autoReverted ? { autoRevertedToDraft: true, autoRevertedFields: PROTECTED_FIELDS.filter((f) => body[f] !== undefined) } : {}),
        // ADR 0597 §Correction 4 — never silent: the owner's submission was
        // withdrawn by their own edit, and the screen has to be able to say so.
        ...(activationReviewClosed ? { activationReviewClosed: true } : {}),
      });
    } catch (err) { next(err); }
  });

  // ── timeline for ONE strategy (ADR 0234 §C6 — slip flags computed at read) ──
  app.get(`${BASE}/:id/timeline`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const s = await loadStrategyScoped(req, false);
      res.json({ items: await resolveStrategyTimeline(tenantOf(req), s, actingUserOf(req), canReadOrgPredicate(req)) });
    } catch (err) { next(err); }
  });

  // ── check-ins (ADR 0231 §C1): the measurement trail under key results ──
  app.get(`${BASE}/:id/check-ins`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const s = await loadStrategyScoped(req, false);
      const krId = typeof req.query.krId === 'string' && req.query.krId ? req.query.krId : undefined;
      res.json({ checkIns: await listCheckIns(tenantOf(req), s.id, krId) });
    } catch (err) { next(err); }
  });

  // Human check-in ⇒ CONFIRMED (routes are the human path; agent/run writes go
  // through the surface verb and land as PROPOSED — ADR 0231 actor classing).
  app.post(`${BASE}/:id/key-results/:krId/check-ins`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const s = await loadStrategyScoped(req, true);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const row = await appendCheckIn({
        strategy: s,
        krId: req.params.krId ?? '',
        ...(typeof body.value === 'number' ? { value: body.value } : {}),
        ...(typeof body.note === 'string' ? { note: body.note } : {}),
        ...(body.confidence === 'high' || body.confidence === 'medium' || body.confidence === 'low' ? { confidence: body.confidence } : {}),
        origin: 'human',
        actor: actingUserOf(req) ?? 'unknown',
      });
      res.status(201).json(row);
    } catch (err) { next(err); }
  });

  // Decide an agent-PROPOSED check-in (write authority; audited + evented).
  // CHAT-FIRST-PORT-AUDIT D3 — the page confirm/dismiss now resolves THE shared
  // approval row (`kind:'strategy-checkin'`, raised at propose time) through the
  // SAME decision core the reviews inbox uses: confirm ⇒ claim (approve), dismiss
  // ⇒ reject. The handler applies the check-in effect + the CAS finality, so a
  // decided row refuses a second decide (typed 409) — there is ONE durable
  // decision record whether decided here or from the inbox. No bespoke minting.
  const decideCheckInRoute = (outcome: 'confirmed' | 'dismissed') =>
    async (req: Request, res: import('express').Response, next: import('express').NextFunction): Promise<void> => {
      try {
        await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
        const s = await loadStrategyScoped(req, true); // preserves the route's workspace:write bar
        const checkInId = req.params.checkInId ?? '';
        const appr = await findApprovalForCheckIn(tenantOf(req), checkInId);
        if (!appr) throw new OpenwopError('not_found', 'Check-in not found.', 404, { checkInId });
        const dctx = { storage: deps.storage, hostSuite: deps.hostSuite };
        const ctx = { tenantId: tenantOf(req), ...(actingUserOf(req) ? { decidedBy: actingUserOf(req)! } : {}) };
        if (outcome === 'confirmed') await claimApproval(dctx, ctx, appr.approvalId);
        else await rejectApproval(dctx, ctx, appr.approvalId);
        const row = await getCheckIn(tenantOf(req), s.id, checkInId);
        if (!row) throw new OpenwopError('not_found', 'Check-in not found.', 404, { checkInId });
        res.json(row);
      } catch (err) { next(err); }
    };
  app.post(`${BASE}/:id/check-ins/:checkInId/confirm`, decideCheckInRoute('confirmed'));
  app.post(`${BASE}/:id/check-ins/:checkInId/dismiss`, decideCheckInRoute('dismissed'));

  // ── versions (ADR 0230 §B4): list · get snapshot · content-only restore ──
  app.get(`${BASE}/:id/versions`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const s = await loadStrategyScoped(req, false);
      const revs = await listStrategyRevisions(tenantOf(req), s.id);
      res.json({ versions: revs.map((r) => ({ n: r.n, actor: r.actor, createdAt: r.createdAt, title: r.snapshot.title, status: r.snapshot.status })) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/:id/versions/:n`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const s = await loadStrategyScoped(req, false);
      const n = Number.parseInt(req.params.n ?? '', 10);
      const rev = Number.isFinite(n) ? await getStrategyRevision(tenantOf(req), s.id, n) : null;
      if (!rev) throw new OpenwopError('not_found', 'Revision not found.', 404, { id: s.id, n: req.params.n });
      res.json(rev);
    } catch (err) { next(err); }
  });

  // Content-only restore: title/summary/rationale/horizon/period/objectives/
  // initiatives/confidence/risk/accountableExecutive. Deliberately NOT
  // scope/orgId/owner/status/links/healthOverride — restoring config or links
  // from history would bypass the config-authority and link-readability gates.
  app.post(`${BASE}/:id/versions/:n/restore`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const s = await loadStrategyScoped(req, true);
      const tenantId = tenantOf(req);
      const actor = actingUserOf(req) ?? 'unknown';
      const n = Number.parseInt(req.params.n ?? '', 10);
      const rev = Number.isFinite(n) ? await getStrategyRevision(tenantId, s.id, n) : null;
      if (!rev) throw new OpenwopError('not_found', 'Revision not found.', 404, { id: s.id, n: req.params.n });
      const snap = rev.snapshot;
      const restored = await updateStrategy(tenantId, s.id, {
        title: snap.title,
        summary: snap.summary ?? null,
        rationale: snap.rationale ?? null,
        planningHorizon: snap.planningHorizon,
        period: snap.period,
        objectives: snap.objectives,
        initiatives: snap.initiatives,
        confidence: snap.confidence ?? null,
        risk: snap.risk ?? null,
        accountableExecutive: snap.accountableExecutive ?? null,
      }, actor);
      strategyMutated({ entity: 'revision', verb: 'restored', tenantId, actor, strategyId: s.id, orgId: restored.orgId, changed: [`revision:${n}`] });
      // ADR 0597 §Correction 4 — a restore rewrites EVERY protected field, so it
      // swaps the content under a pending review exactly as a PATCH does. Same
      // rule, same helper; found by walking `updateStrategy`'s callers rather
      // than the finding's one example.
      const activationReviewClosed = await withdrawActivationReview(
        await strategyGateEnabled(tenantId), tenantId, restored, actor, [...PROTECTED_FIELDS],
      );
      res.json({ ...restored, ...(activationReviewClosed ? { activationReviewClosed: true } : {}) });
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
      const actor = actingUserOf(req) ?? 'unknown';
      if (hard) {
        await hardDeleteStrategy(tenantOf(req), s.id);
        strategyMutated({ entity: 'strategy', verb: 'deleted', tenantId: tenantOf(req), actor, strategyId: s.id, orgId: s.orgId });
        res.status(204).end();
      } else {
        const archived = await archiveStrategy(tenantOf(req), s.id, actor);
        strategyMutated({ entity: 'strategy', verb: 'archived', tenantId: tenantOf(req), actor, strategyId: s.id, orgId: s.orgId });
        res.json(archived);
      }
    } catch (err) { next(err); }
  });

  // ── promote a priority idea into an initiative (ADR 0232 §5) ──
  // Lives HERE (not in PM) to preserve the strategy→PM import direction the
  // ADR 0079 design chose. Appends an initiative titled from the idea, adds
  // the canonical {kind:'priority-idea'} link, stamps the idea's intake
  // overlay, and moves the card to the terminal `done` lane.
  app.post(`${BASE}/:id/initiatives/from-idea`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const s = await loadStrategyScoped(req, true);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const listId = requireString(body.listId, 'listId');
      const cardId = requireString(body.cardId, 'cardId');
      const tenantId = tenantOf(req);
      const actor = actingUserOf(req) ?? 'unknown';
      const link: StrategyLink = { kind: 'priority-idea', listId, cardId };
      // ADR 0597 §4 (SPC-3) — WRITE, not read. This route stamps the idea's
      // intake overlay and MOVES the card into the completion lane; neither
      // `markPromoted` nor `moveIdeaStatus` authorizes anything of its own.
      // Priority Matrix's own mirror routes for exactly these two operations
      // (`PATCH /lists/:listId/ideas/:cardId/status`, `POST
      // /lists/:listId/ideas/:cardId/promote-to-project`) both use
      // `loadListScoped(req, 'workspace:write')` — proof by sibling.
      await requireLinkTargetScope(req, link, 'workspace:write');
      const list = await getList(tenantId, listId);
      const idea = (await listRankedIdeas(tenantId, listId)).find((r) => r.card.id === cardId);
      if (!list || !idea) throw new OpenwopError('not_found', 'Idea not found in this list.', 404, { cardId });

      // R2 STR2-B5 — at the initiative cap this route consumed the idea and recorded the
      // promotion against the WRONG initiative. `parseInitiatives` SLICES the append away,
      // and the code then took `initiatives[length - 1]` — a pre-existing, unrelated
      // initiative — stamped its id onto the idea's intake overlay, moved the card to the
      // terminal `done` lane, and returned `201 { initiativeId }` naming it. Nothing in
      // the response looked false. Refuse instead of silently mis-attributing.
      // R2 PM review — refuse a re-promotion BEFORE the initiative is appended and the link
      // written: the priority-matrix guard used to fire after both, leaving the initiative in
      // place, a slot consumed against the cap, and the idea untouched.
      // F2 / PMX-2 (ADR 0590 correction) — the SIBLING promote lane kept every
      // defect the PM route was fixed for: the literal 'done' move (silent
      // no-op on any renamed board), the swallowed move result, and no
      // compensation when `markPromoted` throws AFTER the initiative + link
      // are written — a hole this batch itself WIDENED by adding the
      // double-CAS-loss 409 to markPromoted's throw surface. Same treatment
      // as the PM route: resolve the completion lane BEFORE any write, refuse
      // when none, compensate the initiative + link + cap slot on a lost
      // stamp, and REPORT the move outcome.
      const completionLane = await resolveIdeaCompletionLane(tenantId, listId);
      if (!completionLane) {
        throw new OpenwopError('validation_error', 'This list’s board has no completion lane to move a promoted idea into, so it was not promoted. Add a completion column (e.g. "Done") first.', 400, { listId });
      }
      await assertNotPromoted(listId, cardId);
      if (s.initiatives.length >= STRATEGY_LIMITS.maxInitiatives) {
        throw new OpenwopError('conflict', `This strategy already has the maximum ${STRATEGY_LIMITS.maxInitiatives} initiatives, so this idea cannot be promoted into it.`, 409, { max: STRATEGY_LIMITS.maxInitiatives });
      }
      const before = new Set(s.initiatives.map((i) => i.id));
      const updated = await updateStrategy(tenantId, s.id, {
        initiatives: [...s.initiatives, { title: idea.card.title }],
      }, actor);
      const hasLink = s.links.some((l) => l.kind === 'priority-idea' && l.listId === listId && l.cardId === cardId);
      const withLinks = hasLink ? updated : await replaceLinks(tenantId, s.id, [...s.links, link], actor);
      // …and resolve the initiative by the id that was actually MINTED, never by array
      // position — position is what made a sliced append point at someone else's row.
      const initiative = withLinks.initiatives.find((i) => !before.has(i.id));
      if (!initiative) {
        throw new OpenwopError('conflict', 'The initiative could not be created for this idea, so the idea was left where it is.', 409, { strategyId: s.id });
      }
      try {
        await markPromoted({
          tenantId, orgId: list.orgId, listId, cardId, actor,
          promotedTo: { kind: 'initiative', id: initiative.id, strategyId: s.id },
        });
      } catch (err) {
        // F2 — a lost stamp race must not strand the initiative (a cap slot
        // consumed), the link, or the "promoted" claim: compensate both writes
        // (best-effort, the PM route's deleteProject shape), then rethrow.
        try {
          await updateStrategy(tenantId, s.id, {
            initiatives: withLinks.initiatives.filter((i) => i.id !== initiative.id),
          }, actor);
          if (!hasLink) await replaceLinks(tenantId, s.id, s.links, actor);
        } catch { /* best-effort compensation */ }
        throw err;
      }
      // F2 — the move outcome is REPORTED, never swallowed.
      const movedCard = await moveIdeaStatus(tenantId, listId, cardId, completionLane, actor);
      strategyMutated({ entity: 'strategy', verb: 'initiative-promoted', tenantId, actor, strategyId: s.id, orgId: s.orgId, changed: [cardId] });
      res.status(201).json({ strategy: withLinks, initiativeId: initiative.id, moved: movedCard !== null, ...(movedCard ? { movedToColumnId: completionLane } : {}) });
    } catch (err) { next(err); }
  });

  // ── CSV objective import (ADR 0235 §D3) — `objective,keyResult,target,unit`
  //    (header row optional; the campaign csvImport.ts posture, no new deps).
  //    Appends within the existing caps; revisioned + audited like any PATCH.
  app.post(`${BASE}/:id/import-objectives`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const s = await loadStrategyScoped(req, true);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const csv = typeof body.csv === 'string' ? body.csv : '';
      if (!csv.trim()) throw new OpenwopError('validation_error', 'Field `csv` is required.', 400, { field: 'csv' });

      const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      const first = lines[0]?.toLowerCase() ?? '';
      const rows = (first.startsWith('objective') ? lines.slice(1) : lines)
        .map((l) => l.split(',').map((c) => c.trim()));
      if (rows.length === 0) throw new OpenwopError('validation_error', 'The CSV has no data rows.', 400, {});

      // Group by objective title; merge into EXISTING objectives by exact title.
      const objectives = s.objectives.map((o) => ({ ...o, keyResults: [...o.keyResults] }));
      let imported = 0;
      const skipped: Array<{ line: number; reason: string }> = [];
      // Which CSV line minted which row, so an over-cap drop can be reported against the
      // line the author actually wrote.
      const rowLineOf = new Map<string, number>();
      rows.forEach((cols, idx) => {
        const [objTitle, krTitle, target, unit] = cols;
        if (!objTitle) { skipped.push({ line: idx + 1, reason: 'missing objective title' }); return; }
        let obj = objectives.find((o) => o.title === objTitle);
        if (!obj) {
          obj = { id: `imp-${idx}-${Date.now().toString(36)}`, title: objTitle, keyResults: [] };
          objectives.push(obj);
          rowLineOf.set(obj.id, idx + 1);
        }
        if (krTitle) {
          const krId = `impkr-${idx}-${Date.now().toString(36)}`;
          obj.keyResults.push({
            id: krId,
            title: krTitle,
            ...(target ? { target } : {}),
            ...(unit ? { unit } : {}),
          });
          rowLineOf.set(krId, idx + 1);
        }
        imported++;
      });
      // R2 STR2-B4 — this comment claimed "the shared parse/caps re-validate everything (a
      // too-large import 400s)". They do not: `parseObjectives` SLICES at
      // `maxObjectives`, and `parseObjective` slices key results at `maxKeyResults` —
      // nothing throws. And `imported` was counted from the CSV rows BEFORE persistence,
      // so a strategy holding 45 objectives importing 20 more answered
      // "20 rows imported, 0 skipped" while five were dropped on the floor. Silent loss
      // reported as success. The overflow is now named, per row, in `skipped` — the field
      // the panel already renders — and never counted as imported.
      const overflowObjectives = objectives.slice(STRATEGY_LIMITS.maxObjectives);
      const overflowIds = new Set(overflowObjectives.map((o) => o.id));
      for (const o of objectives) {
        if (overflowIds.has(o.id)) continue;
        const dropped = o.keyResults.slice(STRATEGY_LIMITS.maxKeyResults);
        for (const k of dropped) {
          const line = rowLineOf.get(k.id);
          if (line !== undefined) { skipped.push({ line, reason: `objective "${o.title}" is at the ${STRATEGY_LIMITS.maxKeyResults} key-result limit` }); imported--; }
        }
      }
      for (const o of overflowObjectives) {
        const line = rowLineOf.get(o.id);
        if (line !== undefined) { skipped.push({ line, reason: `this strategy is at the ${STRATEGY_LIMITS.maxObjectives} objective limit` }); imported--; }
        // …and every key result the CSV added under a dropped objective goes with it.
        for (const k of o.keyResults) {
          const krLine = rowLineOf.get(k.id);
          if (krLine !== undefined && krLine !== line) { skipped.push({ line: krLine, reason: `its objective "${o.title}" exceeded the ${STRATEGY_LIMITS.maxObjectives} objective limit` }); imported--; }
        }
      }
      if (imported < 0) imported = 0;
      const updated = await updateStrategy(tenantOf(req), s.id, { objectives }, actingUserOf(req) ?? 'unknown');
      strategyMutated({ entity: 'strategy', verb: 'objectives-imported', tenantId: tenantOf(req), actor: actingUserOf(req) ?? 'unknown', strategyId: s.id, orgId: s.orgId, changed: [`rows:${imported}`] });
      res.json({ imported, skipped, strategy: updated });
    } catch (err) { next(err); }
  });

  // ── decision records (ADR 0233 §C8): a register without a new store ──
  // Persists a `decision-record` Document (OPEN kind vocabulary, ADR 0053) and
  // links it canonically on the strategy. `approvalId` cites the quorum-ledger
  // provenance when the decision came through the B3 gate.
  app.post(`${BASE}/:id/decisions`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const s = await loadStrategyScoped(req, true);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = requireString(body.title, 'title');
      const decision = requireString(body.decision, 'decision');
      const rationale = typeof body.rationale === 'string' ? body.rationale.trim() : '';
      const alternatives = typeof body.alternatives === 'string' ? body.alternatives.trim() : '';
      const tenantId = tenantOf(req);
      const actor = actingUserOf(req) ?? 'unknown';
      // The Document IS the record — without the documents feature there is no
      // honest place to persist it (the PM agenda degrades; a decision record
      // must not).
      const docsOn = await resolveOne('documents', { tenantId });
      if (!docsOn?.enabled) {
        throw new OpenwopError('conflict', 'Decision records require the `documents` feature to be enabled.', 409, { requires: 'documents' });
      }

      let approvalCitation = '';
      if (typeof body.approvalId === 'string' && body.approvalId) {
        const appr = await getApproval(body.approvalId);
        if (appr && appr.tenantId === tenantId && appr.status !== 'pending') {
          approvalCitation = `\n\n**Approval provenance:** ${appr.approvalId} (${appr.status}${appr.note ? ` — ${appr.note}` : ''}).`;
        }
      }
      const markdown = [
        `# Decision: ${title}`,
        '',
        `**Strategy:** ${s.title} (${s.id})`,
        `**Decided:** ${new Date().toISOString().slice(0, 10)} · **Recorded by:** ${actor}`,
        '',
        '## Decision',
        decision,
        ...(rationale ? ['', '## Rationale', rationale] : []),
        ...(alternatives ? ['', '## Alternatives considered', alternatives] : []),
      ].join('\n') + approvalCitation;

      const doc = await createDocument({
        tenantId, orgId: s.orgId, title: `Decision — ${title}`, kind: 'decision-record', format: 'markdown',
        provenance: { producedBy: { kind: 'user', id: actor } }, createdBy: actor,
      });
      await addVersion(tenantId, s.orgId, doc.documentId, { content: markdown, producedBy: { kind: 'user', id: actor } });
      const updated = await replaceLinks(tenantId, s.id, [...s.links, { kind: 'document', documentId: doc.documentId }], actor);
      strategyMutated({ entity: 'strategy', verb: 'decision-recorded', tenantId, actor, strategyId: s.id, orgId: s.orgId, changed: [doc.documentId] });
      res.status(201).json({ documentId: doc.documentId, strategy: updated });
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
      const actor = actingUserOf(req) ?? 'unknown';
      const updated = await replaceLinks(tenantOf(req), s.id, links, actor);
      strategyMutated({ entity: 'links', verb: 'updated', tenantId: tenantOf(req), actor, strategyId: s.id, orgId: s.orgId });
      res.json(updated);
    } catch (err) { next(err); }
  });
}
