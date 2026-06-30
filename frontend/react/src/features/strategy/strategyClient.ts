/**
 * Strategy API client (ADR 0079). The executive strategy portfolio surface under
 * /v1/host/openwop-app/strategy/*. Strategies link existing host entities
 * (projects, priority lists/ideas, advisory boards) and project a compact
 * context packet into those surfaces.
 *
 * Reuses the shared client config (`authedHeaders`/`fetchOpts`/`asJson`) — no
 * bespoke fetch. Owns its small composed reads (orgs/projects) the create form
 * needs, the same way `priorityMatrixClient` does (per-feature, not a
 * cross-feature import).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type StrategyScope = 'user' | 'workspace' | 'org';
export type PlanningHorizon = 'quarter' | 'half-year' | 'annual' | 'multi-year' | 'custom';
export type StrategyStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';
export type StrategyConfidence = 'high' | 'medium' | 'low';
export type StrategyRisk = 'low' | 'medium' | 'high';

export interface StrategyKeyResult { id: string; title: string; target?: string; current?: string; unit?: string; status?: StrategyStatus }
export interface StrategyObjective { id: string; title: string; keyResults: StrategyKeyResult[] }
export interface StrategyInitiative { id: string; title: string; ownerUserId?: string; status?: StrategyStatus; linkedProjectIds?: string[] }
export interface StrategyPeriod { label: string; startDate?: string; endDate?: string }

export type StrategyLink =
  | { kind: 'project'; projectId: string }
  | { kind: 'priority-list'; listId: string }
  | { kind: 'priority-idea'; listId: string; cardId: string }
  | { kind: 'advisory-board'; boardId: string }
  | { kind: 'document'; documentId: string };

export interface Strategy {
  id: string;
  tenantId: string;
  orgId: string;
  scope: StrategyScope;
  title: string;
  summary?: string;
  rationale?: string;
  planningHorizon: PlanningHorizon;
  period: StrategyPeriod;
  ownerUserId?: string;
  accountableExecutive?: string;
  status: StrategyStatus;
  confidence?: StrategyConfidence;
  risk?: StrategyRisk;
  /** Manual health override; absent ⇒ the health badge is the computed "Auto" rollup. */
  healthOverride?: StrategyHealthState;
  objectives: StrategyObjective[];
  initiatives: StrategyInitiative[];
  links: StrategyLink[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyContextEntry {
  id: string;
  title: string;
  scope: StrategyScope;
  orgId: string;
  horizon: PlanningHorizon;
  period: StrategyPeriod;
  status: StrategyStatus;
  confidence?: StrategyConfidence;
  risk?: StrategyRisk;
  owner?: string;
  summary?: string;
  rationale?: string;
  objectives: Array<{ title: string; keyResults: Array<{ title: string; target?: string; current?: string; status?: StrategyStatus }> }>;
  initiatives: Array<{ title: string; status?: StrategyStatus; linkedProjectIds?: string[] }>;
  linkedProjects: Array<{ id: string; name: string; status?: string; health?: string }>;
  linkedPriorities: Array<{ listId: string; cardId?: string; title: string; computedPriority?: number; rank?: number }>;
}

export interface OrgRef { orgId: string; name: string }
export interface ProjectRef { id: string; name: string; orgId: string; status?: string; health?: string }

/** Thrown when the feature toggle is off (the list/read 404s) — the page renders
 *  a clean "not enabled" state instead of a raw error. */
export class FeatureDisabledError extends Error {}

const base = `${config.baseUrl}/v1/host/openwop-app/strategy`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    if (res.status === 404 && /not enabled/i.test(detail)) throw new FeatureDisabledError(detail);
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface StrategyListFilter { orgId?: string; scope?: StrategyScope; horizon?: PlanningHorizon; status?: StrategyStatus; includeArchived?: boolean }

export async function listStrategies(filter: StrategyListFilter = {}): Promise<Strategy[]> {
  const qs = new URLSearchParams();
  if (filter.orgId) qs.set('orgId', filter.orgId);
  if (filter.scope) qs.set('scope', filter.scope);
  if (filter.horizon) qs.set('horizon', filter.horizon);
  if (filter.status) qs.set('status', filter.status);
  if (filter.includeArchived) qs.set('includeArchived', 'true');
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetch(`${base}${suffix}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ strategies: Strategy[] }>(res, 'listStrategies')).strategies;
}

export async function getStrategy(id: string): Promise<Strategy> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<Strategy>(res, 'getStrategy');
}

export interface CreateStrategyInput {
  orgId: string;
  title: string;
  scope?: StrategyScope;
  summary?: string;
  rationale?: string;
  planningHorizon?: PlanningHorizon;
  period?: StrategyPeriod;
  ownerUserId?: string;
  accountableExecutive?: string;
  status?: StrategyStatus;
  confidence?: StrategyConfidence;
  risk?: StrategyRisk;
  objectives?: StrategyObjective[];
  initiatives?: StrategyInitiative[];
}

export async function createStrategy(input: CreateStrategyInput): Promise<Strategy> {
  const res = await fetch(`${base}`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<Strategy>(res, 'createStrategy');
}

/** A patch. The clearable optional scalars accept `null` to clear them (the
 *  backend treats `null` = clear, `undefined`/absent = leave unchanged). */
export interface UpdateStrategyPatch {
  orgId?: string;
  title?: string;
  scope?: StrategyScope;
  planningHorizon?: PlanningHorizon;
  period?: StrategyPeriod;
  status?: StrategyStatus;
  objectives?: StrategyObjective[];
  initiatives?: StrategyInitiative[];
  summary?: string | null;
  rationale?: string | null;
  ownerUserId?: string | null;
  accountableExecutive?: string | null;
  confidence?: StrategyConfidence | null;
  risk?: StrategyRisk | null;
  healthOverride?: StrategyHealthState | null;
}

export async function updateStrategy(id: string, patch: UpdateStrategyPatch): Promise<Strategy> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<Strategy>(res, 'updateStrategy');
}

/** Soft-archive (shared) — returns the archived row. */
export async function archiveStrategy(id: string): Promise<Strategy> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  return asJson<Strategy>(res, 'archiveStrategy');
}

/** Hard-delete a user-scoped draft (204). */
export async function deleteStrategy(id: string): Promise<void> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}?hard=true`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) {
    let detail = ''; try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `deleteStrategy returned ${res.status}`);
  }
}

export async function replaceLinks(id: string, links: StrategyLink[]): Promise<Strategy> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}/links`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ links }) }));
  return asJson<Strategy>(res, 'replaceLinks');
}

export type StrategyHealthState = 'on-track' | 'at-risk' | 'off-track';
export interface StrategyHealthSignals {
  linkedProjectCount: number; projectsOnTrack: number; projectsAtRisk: number; projectsOffTrack: number;
  milestonesDone: number; milestonesTotal: number; linkedPriorityCount: number; objectiveCount: number; hasExecution: boolean;
}
export interface StrategyHealthRow { id: string; title: string; health: StrategyHealthState; signals?: StrategyHealthSignals }

/** Per-strategy health rollup for the caller's readable portfolio (ADR 0080). */
export async function getStrategyHealth(): Promise<StrategyHealthRow[]> {
  const res = await fetch(`${base}/health`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ strategies: StrategyHealthRow[] }>(res, 'getStrategyHealth')).strategies;
}

export interface ContextQuery { projectId?: string; priorityListId?: string; cardId?: string; boardId?: string }
export async function getStrategyContext(q: ContextQuery): Promise<StrategyContextEntry[]> {
  const qs = new URLSearchParams();
  if (q.projectId) qs.set('projectId', q.projectId);
  if (q.priorityListId) qs.set('priorityListId', q.priorityListId);
  if (q.cardId) qs.set('cardId', q.cardId);
  if (q.boardId) qs.set('boardId', q.boardId);
  const res = await fetch(`${base}/context?${qs.toString()}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ strategies: StrategyContextEntry[] }>(res, 'getStrategyContext')).strategies;
}

// ── composed reads from sibling surfaces (for the create form + link picker) ──
export async function listOrgs(): Promise<OrgRef[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: OrgRef[] }>(res, 'listOrgs')).orgs;
}
interface ProjectListRow { id: string; name: string; orgId: string; charter?: { status?: string; health?: string } }
export async function listProjects(): Promise<ProjectRef[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/projects`, fetchOpts({ headers: authedHeaders() }));
  const rows = (await asJson<{ projects: ProjectListRow[] }>(res, 'listProjects')).projects;
  return rows.map((p) => ({ id: p.id, name: p.name, orgId: p.orgId, ...(p.charter?.status ? { status: p.charter.status } : {}), ...(p.charter?.health ? { health: p.charter.health } : {}) }));
}
