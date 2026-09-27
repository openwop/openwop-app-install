/**
 * Strategy API client (ADR 0079). The executive strategy portfolio surface under
 * /host/openwop-app/strategy/*. Strategies link existing host entities
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

/** ADR 0231 — a standing, human-configured metric source (authorizes sync writes). */
export type MetricSourceKind = 'crm-deal-total' | 'analytics-conversions' | 'commerce-revenue' | 'bigquery';
export interface MetricSource { kind: MetricSourceKind; orgId: string; query?: string }
export type KrMeasureKind = 'numeric' | 'percent' | 'currency' | 'boolean';
export interface KrMeasure { kind: KrMeasureKind; baseline?: number; target?: number; direction?: 'increase' | 'decrease'; unit?: string; source?: MetricSource }
export interface StrategyKeyResult { id: string; title: string; target?: string; current?: string; unit?: string; status?: StrategyStatus; measure?: KrMeasure; weight?: number }
export interface StrategyObjective { id: string; title: string; keyResults: StrategyKeyResult[]; weight?: number }
export interface InitiativePlan { budgetAmount?: number; budgetCurrency?: string; capacityPoints?: number; actualAmount?: number; actualPoints?: number }
export interface StrategyInitiative { id: string; title: string; ownerUserId?: string; status?: StrategyStatus; linkedProjectIds?: string[]; startDate?: string; endDate?: string; dependsOn?: string[]; plan?: InitiativePlan }
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
  /** ADR 0230 §B3 — PROJECTED (never stored): true when the activation gate is
   *  ON and a strategy-activation approval is pending. Rides GET /:id + PATCH. */
  activationPending?: boolean;
  /** R2 STR2-M5 — this save DEACTIVATED the strategy: editing a protected field on an
   *  active strategy reverts it to draft and it must be re-approved. The marker rode the
   *  event and the audit and never reached the client, so the status chip just changed
   *  and nothing said why. `autoRevertedFields` names which edit did it. */
  autoRevertedToDraft?: boolean;
  autoRevertedFields?: string[];
  /** ADR 0597 §Correction 4 — this edit touched a PROTECTED field while an
   *  activation review was pending, so the submission was WITHDRAWN (an approver
   *  must not approve content that moved under them). PR-A shipped the field with
   *  no SPA reader and filed it; ADR 0598 reads it. The owner's own edit closed
   *  their own submission — a silent version of that is the STR2-M5 lesson again. */
  activationReviewClosed?: boolean;
  /** ADR 0235 §D3 — the one-level grouping lens. */
  parentStrategyId?: string;
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

const base = `${config.baseUrl}/host/openwop-app/strategy`;
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
  /** ADR 0235 §D3 — set a parent (validated server-side) or null to clear. */
  parentStrategyId?: string | null;
}

/** ADR 0235 §D3 — CSV objective import (`objective,keyResult,target,unit`). */
export async function importObjectives(id: string, csv: string): Promise<{ imported: number; skipped: Array<{ line: number; reason: string }>; strategy: Strategy }> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}/import-objectives`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ csv }) }));
  return asJson(res, 'importObjectives');
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
  /** ADR 0231 — read-time measurement signals (absent when nothing is measured). */
  progress?: number; staleKrCount?: number; measuredKrCount?: number; proposedCheckInCount?: number;
}

// ── check-ins (ADR 0231 §C1) ──────────────────────────────────────────────────
export type CheckInStatus = 'confirmed' | 'proposed' | 'dismissed';
export interface StrategyCheckIn {
  checkInId: string; strategyId: string; krId: string;
  value?: number; note?: string; confidence?: StrategyConfidence;
  status: CheckInStatus; origin: 'human' | 'agent' | 'sync'; actor: string;
  createdAt: string; decidedBy?: string; decidedAt?: string;
}

export async function listStrategyCheckIns(id: string, krId?: string): Promise<StrategyCheckIn[]> {
  const qs = krId ? `?krId=${encodeURIComponent(krId)}` : '';
  const res = await fetch(`${base}/${encodeURIComponent(id)}/check-ins${qs}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ checkIns: StrategyCheckIn[] }>(res, 'listStrategyCheckIns')).checkIns;
}

export async function createCheckIn(id: string, krId: string, input: { value?: number; note?: string; confidence?: StrategyConfidence }): Promise<StrategyCheckIn> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}/key-results/${encodeURIComponent(krId)}/check-ins`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<StrategyCheckIn>(res, 'createCheckIn');
}

export async function decideCheckIn(id: string, checkInId: string, decision: 'confirm' | 'dismiss'): Promise<StrategyCheckIn> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}/check-ins/${encodeURIComponent(checkInId)}/${decision}`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return asJson<StrategyCheckIn>(res, 'decideCheckIn');
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

/** The resolved context packet for ONE strategy (strategy-gap A3): linked idea
 *  scores/ranks + project health in one fetch — the detail page must never fan
 *  out per-list reads (the rate-limit gotcha). Null when nothing resolved. */
export async function getStrategyDetailContext(id: string): Promise<StrategyContextEntry | null> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}/context`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ strategy: StrategyContextEntry | null }>(res, 'getStrategyDetailContext')).strategy;
}

// ── timeline (ADR 0234 §C6 — a read projection; slip flags computed server-side) ──
export interface TimelineItem {
  kind: 'initiative' | 'milestone' | 'idea-schedule';
  id: string;
  title: string;
  startDate?: string;
  dueDate?: string;
  status?: string;
  done?: boolean;
  source: { strategyId: string; kind: string; projectId?: string; listId?: string; cardId?: string };
  overdue?: boolean;
  dependencyLate?: string[];
}
export async function getStrategyTimeline(id: string): Promise<TimelineItem[]> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}/timeline`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ items: TimelineItem[] }>(res, 'getStrategyTimeline')).items;
}

// ── composed reads from sibling surfaces (for the create form + link picker) ──
export async function listOrgs(): Promise<OrgRef[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: OrgRef[] }>(res, 'listOrgs')).orgs;
}
interface ProjectListRow { id: string; name: string; orgId: string; charter?: { status?: string; health?: string } }
export async function listProjects(): Promise<ProjectRef[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/projects`, fetchOpts({ headers: authedHeaders() }));
  const rows = (await asJson<{ projects: ProjectListRow[] }>(res, 'listProjects')).projects;
  return rows.map((p) => ({ id: p.id, name: p.name, orgId: p.orgId, ...(p.charter?.status ? { status: p.charter.status } : {}), ...(p.charter?.health ? { health: p.charter.health } : {}) }));
}
