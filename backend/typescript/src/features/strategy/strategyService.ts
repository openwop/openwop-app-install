/**
 * Strategy service (ADR 0079). Owns the executive strategy record and its
 * canonical alignment links. Reads back into the surfaces it connects (projects,
 * priority lists/ideas) through projection helpers rather than denormalizing
 * `strategyIds[]` onto those stores — links live in exactly one place.
 *
 * Tenant + IDOR discipline: every read/write is tenant-keyed (`${tenantId}::${id}`)
 * and reads use the bounded `listForTenant` scan (never a cross-tenant `list()`).
 * A foreign-tenant id reads `null` (fail-closed, no existence leak).
 *
 * RBAC lives at the ROUTE layer (it needs the request); this service takes an
 * injected `canReadOrg` predicate for cross-entity context enrichment so the
 * data-join lives here while authority stays with the route.
 *
 * @see docs/adr/0079-strategic-planning.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { cleanString, optionalCleanString } from '../../host/boundedStrings.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { getProject, resolveProjectAccess } from '../projects/projectsService.js';
import { computeStrategyHealth } from './strategyHealth.js';
import { getList, listRankedIdeas } from '../priority-matrix/priorityMatrixService.js';
import { indexStrategy, removeStrategy } from './strategyKnowledgeService.js';
import {
  STRATEGY_LIMITS, STRATEGY_SCOPES, PLANNING_HORIZONS, STRATEGY_STATUSES,
  STRATEGY_CONFIDENCES, STRATEGY_RISKS, STRATEGY_LINK_KINDS, STRATEGY_HEALTH_STATES,
  type Strategy, type StrategyScope, type PlanningHorizon, type StrategyStatus,
  type StrategyHealthState,
  type StrategyObjective, type StrategyKeyResult,
  type StrategyInitiative, type StrategyLink, type StrategyPeriod,
  type StrategyContextEntry, type StrategyRef, type StrategyHealthRow,
} from './types.js';

const log = createLogger('features.strategy');

// STRAT-6 (ADR 0077) — a strategy's `summary` + `rationale` are free-text that can carry
// personal data (named people, performance commentary); declare them so they're masked in
// any log that emits a strategy row (defence-in-depth, like crm/profiles). `ownerUserId`/
// `createdBy` are OPAQUE principals (RFC 0048), not PII. Deliberately NO retention purger:
// a strategy is intentional, long-lived org planning data (DELETE = soft archive), NOT the
// incidental/abandoned PII the crm/comments/profiles purgers target — auto-deleting it on a
// retention timer would be wrong.
declarePiiFields('strategy.record', ['summary', 'rationale']);

const strategies = new DurableCollection<Strategy>('strategy:record', (s) => `${s.tenantId}::${s.id}`);

/** Test-only: drop all strategy rows. */
export async function __clearStrategies(): Promise<void> {
  await strategies.__clear();
}

// ── validation helpers ──────────────────────────────────────────────────────

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new OpenwopError('validation_error', `Field \`${field}\` MUST be one of: ${allowed.join(', ')}.`, 400, { field });
}

function optOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined || value === null) return undefined;
  return oneOf(value, allowed, field);
}

function reqTitle(raw: unknown, field: string, max: number): string {
  const v = cleanString(raw, max);
  if (!v) throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  return v;
}

/**
 * A bounded, non-empty IDENTIFIER validator. Unlike `cleanString` it does NOT
 * secret-scrub — link targets (card/list/project/board/document ids) and user
 * ids are OPAQUE references, not free text; a uuid-shaped id (`card-<uuid>`)
 * would otherwise be redacted to `[REDACTED:secret-shaped]` and break the link.
 */
function reqId(raw: unknown, field: string, max = 128): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  }
  return raw.trim().slice(0, max);
}

/** Optional identifier (non-scrubbing): trimmed + capped, or undefined when absent. */
function optId(raw: unknown, max = 128): string | undefined {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim().slice(0, max) : undefined;
}

function parsePeriod(raw: unknown): StrategyPeriod {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const period: StrategyPeriod = { label: cleanString(o.label, STRATEGY_LIMITS.label, 'Untitled period') };
  const start = optionalCleanString(o.startDate, STRATEGY_LIMITS.shortField);
  const end = optionalCleanString(o.endDate, STRATEGY_LIMITS.shortField);
  if (start) period.startDate = start;
  if (end) period.endDate = end;
  return period;
}

function parseKeyResult(raw: unknown): StrategyKeyResult {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kr: StrategyKeyResult = { id: optId(o.id, 64) ?? randomUUID(), title: reqTitle(o.title, 'keyResult.title', STRATEGY_LIMITS.title) };
  const target = optionalCleanString(o.target, STRATEGY_LIMITS.shortField);
  const current = optionalCleanString(o.current, STRATEGY_LIMITS.shortField);
  const unit = optionalCleanString(o.unit, STRATEGY_LIMITS.label);
  const status = optOneOf(o.status, STRATEGY_STATUSES, 'keyResult.status');
  if (target) kr.target = target;
  if (current) kr.current = current;
  if (unit) kr.unit = unit;
  if (status) kr.status = status;
  return kr;
}

function parseObjective(raw: unknown): StrategyObjective {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const krs = Array.isArray(o.keyResults) ? o.keyResults.slice(0, STRATEGY_LIMITS.maxKeyResults) : [];
  return {
    id: optId(o.id, 64) ?? randomUUID(),
    title: reqTitle(o.title, 'objective.title', STRATEGY_LIMITS.title),
    keyResults: krs.map(parseKeyResult),
  };
}

function parseInitiative(raw: unknown): StrategyInitiative {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const init: StrategyInitiative = {
    id: optId(o.id, 64) ?? randomUUID(),
    title: reqTitle(o.title, 'initiative.title', STRATEGY_LIMITS.title),
  };
  const owner = optId(o.ownerUserId, STRATEGY_LIMITS.ownerField);
  const status = optOneOf(o.status, STRATEGY_STATUSES, 'initiative.status');
  if (owner) init.ownerUserId = owner;
  if (status) init.status = status;
  if (Array.isArray(o.linkedProjectIds)) {
    const ids = o.linkedProjectIds.map((p) => optId(p, 128)).filter((p): p is string => !!p).slice(0, STRATEGY_LIMITS.maxLinkedProjectIds);
    if (ids.length) init.linkedProjectIds = ids;
  }
  return init;
}

/** Validate one alignment link's discriminated shape (ADR 0079). */
export function parseLink(raw: unknown): StrategyLink {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = oneOf(o.kind, STRATEGY_LINK_KINDS, 'link.kind');
  switch (kind) {
    case 'project': return { kind, projectId: reqId(o.projectId, 'link.projectId') };
    case 'priority-list': return { kind, listId: reqId(o.listId, 'link.listId') };
    case 'priority-idea': return { kind, listId: reqId(o.listId, 'link.listId'), cardId: reqId(o.cardId, 'link.cardId') };
    case 'advisory-board': return { kind, boardId: reqId(o.boardId, 'link.boardId') };
    case 'document': return { kind, documentId: reqId(o.documentId, 'link.documentId') };
  }
}

function parseLinks(raw: unknown): StrategyLink[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, STRATEGY_LIMITS.maxLinks).map(parseLink);
}

function parseObjectives(raw: unknown): StrategyObjective[] {
  return Array.isArray(raw) ? raw.slice(0, STRATEGY_LIMITS.maxObjectives).map(parseObjective) : [];
}

function parseInitiatives(raw: unknown): StrategyInitiative[] {
  return Array.isArray(raw) ? raw.slice(0, STRATEGY_LIMITS.maxInitiatives).map(parseInitiative) : [];
}

// ── filters ──────────────────────────────────────────────────────────────────

export interface StrategyListFilter {
  orgId?: string;
  scope?: StrategyScope;
  horizon?: PlanningHorizon;
  status?: StrategyStatus;
  /** Exclude archived rows unless explicitly asked for. Default true. */
  includeArchived?: boolean;
}

// ── subject-based RBAC (the canonical scope logic; the routes delegate here so
//    the read rules live in ONE place — ADR 0079 §RBAC) ────────────────────────

/** Does `subject` hold `scope` in `orgId`? */
export async function subjectHasOrgScope(tenantId: string, subject: string | undefined, orgId: string, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
  return access.scopes.includes(scope);
}

/** Does `subject` hold `scope` in ANY org of the tenant? (the tenant-wide read
 *  `workspace` scope uses.) */
export async function subjectHasTenantScope(tenantId: string, subject: string | undefined, scope: Scope): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantId, { subject });
  return access.scopes.includes(scope);
}

/** Can `subject` READ this strategy? (scope-aware — ADR 0079 §Correction.) */
export async function canSubjectReadStrategy(tenantId: string, subject: string | undefined, s: Strategy): Promise<boolean> {
  if (s.scope === 'user') return subject === s.createdBy;
  if (s.scope === 'workspace') return subjectHasTenantScope(tenantId, subject, 'workspace:read');
  return subjectHasOrgScope(tenantId, subject, s.orgId, 'workspace:read');
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export interface CreateStrategyInput {
  scope?: unknown;
  title?: unknown;
  summary?: unknown;
  rationale?: unknown;
  planningHorizon?: unknown;
  period?: unknown;
  ownerUserId?: unknown;
  accountableExecutive?: unknown;
  status?: unknown;
  confidence?: unknown;
  risk?: unknown;
  objectives?: unknown;
  initiatives?: unknown;
  links?: unknown;
}

/** Create a strategy in `orgId`. The caller's authority over `orgId` is gated at
 *  the route; this records the validated entity. */
export async function createStrategy(tenantId: string, orgId: string, createdBy: string, input: CreateStrategyInput): Promise<Strategy> {
  const now = new Date().toISOString();
  const owner = optId(input.ownerUserId, STRATEGY_LIMITS.ownerField);
  const exec = optionalCleanString(input.accountableExecutive, STRATEGY_LIMITS.ownerField);
  const summary = optionalCleanString(input.summary, STRATEGY_LIMITS.summary);
  const rationale = optionalCleanString(input.rationale, STRATEGY_LIMITS.rationale);
  const confidence = optOneOf(input.confidence, STRATEGY_CONFIDENCES, 'confidence');
  const risk = optOneOf(input.risk, STRATEGY_RISKS, 'risk');
  const strategy: Strategy = {
    id: randomUUID(),
    tenantId,
    orgId,
    scope: input.scope === undefined ? 'org' : oneOf(input.scope, STRATEGY_SCOPES, 'scope'),
    title: reqTitle(input.title, 'title', STRATEGY_LIMITS.title),
    planningHorizon: input.planningHorizon === undefined ? 'annual' : oneOf(input.planningHorizon, PLANNING_HORIZONS, 'planningHorizon'),
    period: parsePeriod(input.period),
    status: input.status === undefined ? 'draft' : oneOf(input.status, STRATEGY_STATUSES, 'status'),
    objectives: parseObjectives(input.objectives),
    initiatives: parseInitiatives(input.initiatives),
    links: parseLinks(input.links),
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
  if (summary) strategy.summary = summary;
  if (rationale) strategy.rationale = rationale;
  if (owner) strategy.ownerUserId = owner;
  if (exec) strategy.accountableExecutive = exec;
  if (confidence) strategy.confidence = confidence;
  if (risk) strategy.risk = risk;
  await strategies.put(strategy);
  // ADR 0100: keep the managed 'Strategy KB' fresh. Best-effort — never throws
  // into the CRUD; reconciles scope/status (shared+live ⇒ index, else remove).
  await indexStrategy(tenantId, strategy, createdBy);
  return strategy;
}

/** Read one strategy, tenant-keyed (foreign tenant ⇒ null, no existence leak). */
export async function getStrategy(tenantId: string, id: string): Promise<Strategy | null> {
  return strategies.get(`${tenantId}::${id}`);
}

/** Every strategy in the tenant (bounded scan), newest first, post-filtered. */
export async function listStrategies(tenantId: string, filter: StrategyListFilter = {}): Promise<Strategy[]> {
  const all = await strategies.listForTenant(tenantId);
  const includeArchived = filter.includeArchived ?? false;
  return all
    .filter((s) => (includeArchived || s.status !== 'archived'))
    .filter((s) => (filter.orgId === undefined || s.orgId === filter.orgId))
    .filter((s) => (filter.scope === undefined || s.scope === filter.scope))
    .filter((s) => (filter.horizon === undefined || s.planningHorizon === filter.horizon))
    .filter((s) => (filter.status === undefined || s.status === filter.status))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export interface UpdateStrategyPatch extends CreateStrategyInput {
  /** Reassign the owning org — config-sensitive, gated at the route. */
  orgId?: unknown;
  /** Manual health override; null clears it back to the computed "Auto" verdict. */
  healthOverride?: StrategyHealthState | null;
}

/** Patch a strategy (full-replace of any provided field). The route enforces
 *  config-authority for `scope`/`ownerUserId`/`orgId`/`status:archived`. `links`
 *  is NOT patched here — use `replaceLinks` (its own read-gate). */
export async function updateStrategy(tenantId: string, id: string, patch: UpdateStrategyPatch): Promise<Strategy> {
  const existing = await getStrategy(tenantId, id);
  if (!existing) throw new OpenwopError('not_found', 'Strategy not found.', 404, { id });
  const next: Strategy = { ...existing, updatedAt: new Date().toISOString() };
  if (patch.title !== undefined) next.title = reqTitle(patch.title, 'title', STRATEGY_LIMITS.title);
  if (patch.scope !== undefined) next.scope = oneOf(patch.scope, STRATEGY_SCOPES, 'scope');
  if (patch.orgId !== undefined) next.orgId = reqId(patch.orgId, 'orgId');
  if (patch.planningHorizon !== undefined) next.planningHorizon = oneOf(patch.planningHorizon, PLANNING_HORIZONS, 'planningHorizon');
  if (patch.status !== undefined) next.status = oneOf(patch.status, STRATEGY_STATUSES, 'status');
  if (patch.period !== undefined) next.period = parsePeriod(patch.period);
  if (patch.objectives !== undefined) next.objectives = parseObjectives(patch.objectives);
  if (patch.initiatives !== undefined) next.initiatives = parseInitiatives(patch.initiatives);
  // optional scalars — explicit null clears, undefined leaves unchanged
  applyOptional(next, 'summary', patch.summary, (v) => optionalCleanString(v, STRATEGY_LIMITS.summary));
  applyOptional(next, 'rationale', patch.rationale, (v) => optionalCleanString(v, STRATEGY_LIMITS.rationale));
  applyOptional(next, 'ownerUserId', patch.ownerUserId, (v) => optId(v, STRATEGY_LIMITS.ownerField));
  applyOptional(next, 'accountableExecutive', patch.accountableExecutive, (v) => optionalCleanString(v, STRATEGY_LIMITS.ownerField));
  applyOptional(next, 'confidence', patch.confidence, (v) => optOneOf(v, STRATEGY_CONFIDENCES, 'confidence'));
  applyOptional(next, 'risk', patch.risk, (v) => optOneOf(v, STRATEGY_RISKS, 'risk'));
  applyOptional(next, 'healthOverride', patch.healthOverride, (v) => optOneOf(v, STRATEGY_HEALTH_STATES, 'healthOverride'));
  await strategies.put(next);
  // ADR 0100: one hook covers update AND archive (archiveStrategy delegates
  // here) AND scope/status changes — indexStrategy reconciles presence.
  await indexStrategy(tenantId, next, next.createdBy);
  return next;
}

function applyOptional<K extends keyof Strategy>(target: Strategy, key: K, raw: unknown, parse: (v: unknown) => Strategy[K] | undefined): void {
  if (raw === undefined) return;
  const parsed = raw === null ? undefined : parse(raw);
  if (parsed === undefined) delete target[key];
  else target[key] = parsed;
}

/** Soft-archive (shared strategies keep their history — ADR 0079 story #10). */
export async function archiveStrategy(tenantId: string, id: string): Promise<Strategy> {
  return updateStrategy(tenantId, id, { status: 'archived' });
}

/** Hard-delete (permitted only for user-scoped drafts by their creator — route-gated). */
export async function hardDeleteStrategy(tenantId: string, id: string): Promise<boolean> {
  // Load FIRST for the orgId (the managed-collection id is org-qualified), so a
  // hard-delete also evicts the strategy from its 'Strategy KB' (ADR 0100).
  const existing = await getStrategy(tenantId, id);
  const deleted = await strategies.delete(`${tenantId}::${id}`);
  if (existing) await removeStrategy(tenantId, existing.orgId, id);
  return deleted;
}

/** Replace a strategy's links wholesale (the route validates target readability first). */
export async function replaceLinks(tenantId: string, id: string, links: StrategyLink[]): Promise<Strategy> {
  const existing = await getStrategy(tenantId, id);
  if (!existing) throw new OpenwopError('not_found', 'Strategy not found.', 404, { id });
  const next: Strategy = { ...existing, links: links.slice(0, STRATEGY_LIMITS.maxLinks), updatedAt: new Date().toISOString() };
  await strategies.put(next);
  return next;
}

// ── projection helpers (links read BACK; the route applies readability) ────────

/** Strategies in the tenant whose links satisfy `pred` (excludes archived). The
 *  ROUTE filters the result by per-org readability before exposing it. */
async function strategiesLinking(tenantId: string, pred: (l: StrategyLink) => boolean): Promise<Strategy[]> {
  const all = await listStrategies(tenantId, { includeArchived: false });
  return all.filter((s) => s.links.some(pred));
}

export async function strategiesLinkingProject(tenantId: string, projectId: string): Promise<Strategy[]> {
  return strategiesLinking(tenantId, (l) => l.kind === 'project' && l.projectId === projectId);
}

export async function strategiesLinkingPriorityList(tenantId: string, listId: string): Promise<Strategy[]> {
  return strategiesLinking(tenantId, (l) => (l.kind === 'priority-list' && l.listId === listId) || (l.kind === 'priority-idea' && l.listId === listId));
}

export async function strategiesLinkingPriorityIdea(tenantId: string, listId: string, cardId: string): Promise<Strategy[]> {
  return strategiesLinking(tenantId, (l) => l.kind === 'priority-idea' && l.listId === listId && l.cardId === cardId);
}

export async function strategiesLinkingBoard(tenantId: string, boardId: string): Promise<Strategy[]> {
  return strategiesLinking(tenantId, (l) => l.kind === 'advisory-board' && l.boardId === boardId);
}

/** A compact reference for chip projection into a consumer surface. */
export function toStrategyRef(s: Strategy): StrategyRef {
  return { id: s.id, title: s.title, scope: s.scope, status: s.status, horizon: s.planningHorizon };
}

// ── context packet (cross-entity enrichment, RBAC-filtered via injected predicate) ──

/**
 * Enrich the given (already readability-filtered) strategies into a compact
 * context packet. Each cross-entity join is RBAC-gated so an unreadable linked
 * entity is SILENTLY OMITTED (no existence leak):
 *   - priority lists/ideas are org-scoped → gated on `canReadOrg(list.orgId)`.
 *   - PROJECTS honor member-scoped visibility (ADR 0054 — a `private` project
 *     grants read by membership, NOT org-read) → gated on the project's OWN
 *     `resolveProjectAccess` (using `callerSubject`), never plain org-read.
 * Resolution is LIVE (no snapshot) — revocation takes effect immediately.
 */
export async function resolveStrategyContext(
  tenantId: string,
  readableStrategies: Strategy[],
  callerSubject: string | undefined,
  canReadOrg: (orgId: string) => Promise<boolean>,
): Promise<StrategyContextEntry[]> {
  const orgCache = new Map<string, boolean>();
  const readable = async (orgId: string): Promise<boolean> => {
    let ok = orgCache.get(orgId);
    if (ok === undefined) { ok = await canReadOrg(orgId); orgCache.set(orgId, ok); }
    return ok;
  };
  const projCache = new Map<string, boolean>();
  const canReadProject = async (projectId: string): Promise<boolean> => {
    let ok = projCache.get(projectId);
    if (ok === undefined) { ok = (await resolveProjectAccess(tenantId, projectId, callerSubject)) !== 'none'; projCache.set(projectId, ok); }
    return ok;
  };
  // STRAT-1: memo the project DATA read PER RESOLVE too (sibling of `projCache`,
  // which only memoed the access boolean). `/strategy/health` resolves the WHOLE
  // readable portfolio in one call, so the same project linked from K strategies
  // re-ran `getProject` K times — an N+1 against the project store. Now ≤1 per id.
  const projDataCache = new Map<string, Awaited<ReturnType<typeof getProject>>>();
  const cachedGetProject = async (projectId: string): Promise<Awaited<ReturnType<typeof getProject>>> => {
    if (!projDataCache.has(projectId)) projDataCache.set(projectId, await getProject(tenantId, projectId));
    return projDataCache.get(projectId) ?? null;
  };
  // ADR 0080 follow-on (perf): memo the priority-list reads PER RESOLVE. Without
  // this, a portfolio with K priority-idea links into the same list re-ran
  // `listRankedIdeas` (a full list re-rank) K times — and `/strategy/health`
  // fans this resolve across the WHOLE readable portfolio, multiplying the
  // redundancy. Each list is now fetched + ranked at most once per resolve.
  const listCache = new Map<string, Awaited<ReturnType<typeof getList>>>();
  const cachedGetList = async (listId: string): Promise<Awaited<ReturnType<typeof getList>>> => {
    if (!listCache.has(listId)) listCache.set(listId, await getList(tenantId, listId));
    return listCache.get(listId) ?? null;
  };
  const rankedCache = new Map<string, Awaited<ReturnType<typeof listRankedIdeas>>>();
  const cachedRankedIdeas = async (listId: string): Promise<Awaited<ReturnType<typeof listRankedIdeas>>> => {
    let r = rankedCache.get(listId);
    if (!r) { r = await listRankedIdeas(tenantId, listId); rankedCache.set(listId, r); }
    return r;
  };

  const out: StrategyContextEntry[] = [];
  for (const s of readableStrategies) {
    const entry: StrategyContextEntry = {
      id: s.id,
      title: s.title,
      scope: s.scope,
      orgId: s.orgId,
      horizon: s.planningHorizon,
      period: s.period,
      status: s.status,
      objectives: s.objectives.map((o) => ({ title: o.title, keyResults: o.keyResults.map((k) => ({ title: k.title, ...(k.target ? { target: k.target } : {}), ...(k.current ? { current: k.current } : {}), ...(k.status ? { status: k.status } : {}) })) })),
      initiatives: s.initiatives.map((i) => ({ title: i.title, ...(i.status ? { status: i.status } : {}), ...(i.linkedProjectIds ? { linkedProjectIds: i.linkedProjectIds } : {}) })),
      linkedProjects: [],
      linkedPriorities: [],
    };
    if (s.confidence) entry.confidence = s.confidence;
    if (s.risk) entry.risk = s.risk;
    if (s.ownerUserId) entry.owner = s.ownerUserId;
    if (s.summary) entry.summary = s.summary;
    if (s.rationale) entry.rationale = s.rationale;

    // STRAT-2: count links dropped from the projection (and WHY) so a silently
    // shrinking context is observable. A drop is legitimate (RBAC / archived /
    // deleted target) but invisible before — it just vanished from the prompt.
    let droppedUnreadable = 0; // link target the caller may not read
    let droppedMissing = 0;    // link target no longer exists
    let droppedError = 0;      // STRAT-4: a transient fetch error on ONE link
    for (const l of s.links) {
      // STRAT-4 — fail SOFT per link: a transient `getProject`/`getList`/`listRankedIdeas`
      // error must degrade to skipping THIS link (the prompt loses one entity), not 500 the
      // whole resolve — `/strategy/health` fans this across the entire portfolio, so a single
      // flaky dependency would otherwise sink the whole page.
      try {
        if (l.kind === 'project') {
          // Member-scoped visibility (ADR 0054): a `private` project must NOT leak
          // to a non-member org-reader — gate on the project's own access, not org-read.
          if (await canReadProject(l.projectId)) {
            const p = await cachedGetProject(l.projectId);
            if (p) {
              const ms = p.charter?.milestones ?? [];
              entry.linkedProjects.push({
                id: p.id, name: p.name,
                ...(p.charter?.status ? { status: p.charter.status } : {}),
                ...(p.charter?.health ? { health: p.charter.health } : {}),
                ...(ms.length ? { milestonesDone: ms.filter((m) => m.done).length, milestonesTotal: ms.length } : {}),
              });
            } else { droppedMissing += 1; }
          } else { droppedUnreadable += 1; }
        } else if (l.kind === 'priority-idea') {
          const list = await cachedGetList(l.listId);
          if (list && await readable(list.orgId)) {
            const ideas = await cachedRankedIdeas(l.listId);
            const idea = ideas.find((i) => i.card.id === l.cardId);
            if (idea) entry.linkedPriorities.push({ listId: l.listId, cardId: l.cardId, title: idea.card.title, computedPriority: idea.computedPriority, rank: idea.rank });
            else droppedMissing += 1;
          } else if (!list) { droppedMissing += 1; } else { droppedUnreadable += 1; }
        } else if (l.kind === 'priority-list') {
          const list = await cachedGetList(l.listId);
          if (list && await readable(list.orgId)) {
            entry.linkedPriorities.push({ listId: l.listId, title: list.name });
          } else if (!list) { droppedMissing += 1; } else { droppedUnreadable += 1; }
        }
      } catch (err) {
        droppedError += 1;
        log.warn('strategy_context_link_error', {
          tenantId, strategyId: s.id, linkKind: l.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (droppedUnreadable > 0 || droppedMissing > 0 || droppedError > 0) {
      log.debug('strategy_context_links_dropped', {
        tenantId, strategyId: s.id, subject: callerSubject,
        droppedUnreadable, droppedMissing, droppedError, kept: entry.linkedProjects.length + entry.linkedPriorities.length,
      });
    }
    // Live health rollup over the resolved linked entities (ADR 0080 Phase A).
    // A manual `healthOverride` on the strategy wins over the computed verdict
    // (the signals stay the computed truth so the "why" is still surfaced).
    const computed = computeStrategyHealth(entry);
    entry.health = s.healthOverride
      ? { ...computed, health: s.healthOverride, overridden: true }
      : computed;
    out.push(entry);
  }
  return out;
}

/** Project a resolved context entry to its compact health row (ADR 0080). One
 *  source for the REST `/health` route + the `getHealth` surface method. */
export function toHealthRow(e: StrategyContextEntry): StrategyHealthRow {
  return { id: e.id, title: e.title, health: e.health?.health ?? 'on-track', ...(e.health?.signals ? { signals: e.health.signals } : {}) };
}

/**
 * Resolve a readable strategy set to its compact health rows — the SINGLE entry
 * point shared by the REST `/health` route and the `getHealth` surface (ADR 0080
 * §Follow-on). It deliberately reuses the FULL `resolveStrategyContext`: the
 * health verdict reads `linkedPriorities` (`hasExecution` + `linkedPriorityCount`
 * in computeStrategyHealth), so a "health-only" resolve that skipped priority
 * reads would change the verdict AND report a dishonest priority count. The
 * per-resolve read memo (PR #487) already bounds the cost to O(distinct-lists),
 * so consolidating here keeps one truthful path rather than a faster wrong one.
 */
export async function resolveStrategyHealth(
  tenantId: string,
  readableStrategies: Strategy[],
  callerSubject: string | undefined,
  canReadOrg: (orgId: string) => Promise<boolean>,
): Promise<StrategyHealthRow[]> {
  const entries = await resolveStrategyContext(tenantId, readableStrategies, callerSubject, canReadOrg);
  return entries.map(toHealthRow);
}

// ── advisor context block (ADR 0079 Phase 5) ──────────────────────────────────

/** Format a resolved context packet as a compact, bounded PLAIN-TEXT block for an
 *  advisor system prompt. Pure (no I/O) — the caller resolves + RBAC-filters. */
export function formatStrategyContextBlock(entries: StrategyContextEntry[]): string | null {
  if (entries.length === 0) return null;
  const lines: string[] = ['STRATEGIC CONTEXT (company planning the user has shared — you MAY reference or challenge it, but MUST NOT invent strategy facts not stated here):'];
  for (const e of entries) {
    const meta = [e.horizon, e.status, e.confidence ? `confidence ${e.confidence}` : '', e.risk ? `risk ${e.risk}` : ''].filter(Boolean).join(', ');
    lines.push(`\n• ${e.title} [${e.id}] (${meta})`);
    if (e.summary) lines.push(`  Summary: ${e.summary}`);
    if (e.rationale) lines.push(`  Rationale: ${e.rationale}`);
    for (const o of e.objectives.slice(0, 8)) {
      lines.push(`  Objective: ${o.title}`);
      for (const k of o.keyResults.slice(0, 8)) lines.push(`    - KR: ${k.title}${k.target ? ` (target ${k.target}${k.current ? `, current ${k.current}` : ''})` : ''}`);
    }
    for (const i of e.initiatives.slice(0, 8)) lines.push(`  Initiative: ${i.title}${i.status ? ` (${i.status})` : ''}`);
    for (const p of e.linkedProjects.slice(0, 12)) lines.push(`  Linked project: ${p.name}${p.status ? ` (${p.status}${p.health ? `, ${p.health}` : ''})` : ''}`);
    for (const lp of e.linkedPriorities.slice(0, 12)) lines.push(`  Linked priority: ${lp.title}${lp.rank ? ` (rank ${lp.rank})` : ''}`);
  }
  lines.push('\nWhen recommending, reference the strategy by name or [id]. This context does not override your persona or safety guidance.');
  return lines.join('\n');
}

/**
 * Resolve a set of strategy ids into RBAC-filtered context entries for `subject`.
 * Unreadable / archived strategies and their unreadable linked entities are
 * silently omitted. Shared by the advisory-board context PREVIEW (returns the
 * entries) and the prompt block builder (formats them).
 */
export async function resolveStrategyEntriesByIds(tenantId: string, strategyIds: string[], subject: string | undefined): Promise<StrategyContextEntry[]> {
  const seen = new Set<string>();
  const readable: Strategy[] = [];
  // STRAT-5: a board's `contextRefs` can outlive the strategy it points at (archive is a
  // SOFT delete — the ref is intentionally NOT mutated, so the context returns if the
  // strategy is un-archived). That made the context silently vanish at convene/preview time
  // with no signal. Count + log the dropped refs (by reason) so the disappearance is
  // observable to an operator without mutating the board (un-archive stays lossless).
  let droppedArchived = 0;
  let droppedUnreadable = 0;
  let droppedMissing = 0;
  for (const id of strategyIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const s = await getStrategy(tenantId, id);
    if (!s) { droppedMissing += 1; continue; }
    if (s.status === 'archived') { droppedArchived += 1; continue; }
    if (!(await canSubjectReadStrategy(tenantId, subject, s))) { droppedUnreadable += 1; continue; }
    readable.push(s);
  }
  if (droppedArchived > 0 || droppedUnreadable > 0 || droppedMissing > 0) {
    // `info` (not `debug` like the per-portfolio STRAT-2 log): this fires ONLY when a board's
    // explicitly-configured context ref no longer resolves — a low-frequency, actionable
    // signal that an advisor board is running with less context than its owner set up.
    log.info('strategy_context_refs_dropped', {
      tenantId, subject, requested: seen.size, kept: readable.length,
      droppedArchived, droppedUnreadable, droppedMissing,
    });
  }
  if (readable.length === 0) return [];
  return resolveStrategyContext(tenantId, readable, subject, (orgId) => subjectHasOrgScope(tenantId, subject, orgId, 'workspace:read'));
}

/**
 * Build the advisor strategy context block from a set of strategy ids (resolved +
 * RBAC-filtered for the convener). Returns null when nothing is readable. Used by
 * the advisory-board board-context resolver (ADR 0079 §Correction).
 */
export async function buildStrategyContextBlock(tenantId: string, strategyIds: string[], subject: string | undefined): Promise<string | null> {
  return formatStrategyContextBlock(await resolveStrategyEntriesByIds(tenantId, strategyIds, subject));
}
