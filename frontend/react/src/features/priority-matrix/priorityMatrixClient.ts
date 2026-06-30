/**
 * Priority Matrix API client (ADR 0058). The lists / ideas / scores / planning
 * sessions surface under /v1/host/openwop-app/priority-matrix/*. An "idea" is a
 * host.kanban card; statuses are the board's columns.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type Aggregation = 'weighted-sum' | 'ratio';
export type CriterionDirection = 'benefit' | 'cost';
export type PresetId = 'weighted' | 'wsjf' | 'rice' | 'ice' | 'value-effort';

export interface Criterion {
  id: string;
  name: string;
  description?: string;
  weight: number;
  direction: CriterionDirection;
  scaleHint?: string;
}
export interface CriteriaSet {
  presetId?: PresetId;
  aggregation: Aggregation;
  criteria: Criterion[];
}
export type VotingMode = 'single' | 'multi-voter';
export type VoteAggregation = 'mean' | 'median';

export interface PriorityList {
  id: string;
  tenantId: string;
  orgId: string;
  projectId?: string;
  name: string;
  boardId: string;
  criteriaSet: CriteriaSet;
  votingMode: VotingMode;
  voteAggregation: VoteAggregation;
  /** Per-voter weights for multi-voter aggregation (ADR 0059); voterId → 1..10
   *  (absent = 1). Config-authority-set. */
  voterWeights?: Record<string, number>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface RankedIdea {
  /** The underlying kanban card. `createdAt`/`createdBy`/`assigneeId` come through
   *  from the full `KanbanCard` (the agenda sorts on them). */
  card: { id: string; title: string; description?: string; columnId: string; createdAt?: string; createdBy?: string; assigneeId?: string };
  status: { columnId: string; columnName: string; terminal: boolean };
  scores: Record<string, number>;
  computedPriority: number;
  rank: number;
  /** Multi-voter only — how many members voted, and the caller's own vote. */
  voterCount?: number;
  myScores?: Record<string, number>;
}
export interface PlanningSession {
  id: string;
  listId: string;
  name: string;
  agendaDocumentId?: string;
  agendaMarkdown: string;
  createdAt: string;
}
export interface PortfolioItem {
  listId: string;
  listName: string;
  votingMode: VotingMode;
  scoringModel: string;
  cardId: string;
  title: string;
  status: string;
  computedPriority: number;
  inListRank: number;
  normalizedPriority?: number;
}
export interface PortfolioListRef { listId: string; name: string; scoringModel: string; ideaCount: number }
export type NormalizeMode = 'none' | 'list-relative' | 'percentile';
export interface VoteBreakdownEntry { voterId: string; scores: Record<string, number>; updatedAt: string }

export interface FederatedPeer { id: string; label: string; baseUrl: string; createdAt: string }
export interface PeerStatus { peerId: string; label: string; ok: boolean; count: number; error?: string }
export interface FederatedItem extends PortfolioItem { source: string }

export interface OrgRef { orgId: string; name: string }
export interface ProjectRef { id: string; name: string; orgId: string }

// ── schedule status (ADR 0103) ──
export type ScheduleState = 'unscheduled' | 'on-track' | 'at-risk' | 'behind' | 'done-early' | 'done-late';
export interface IdeaScheduleStatus {
  cardId: string;
  title: string;
  status: string;
  state: ScheduleState;
  targetDate?: string;
  dueInDays?: number;
  overdueByDays?: number;
  completedAt?: string;
}
export interface ScheduleRollup {
  behind: number;
  atRisk: number;
  onTrack: number;
  doneLate: number;
  doneEarly: number;
  unscheduled: number;
  total: number;
  health: 'on-track' | 'at-risk' | 'behind';
}

const base = `${config.baseUrl}/v1/host/openwop-app/priority-matrix`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listPresets(): Promise<CriteriaSet[]> {
  const res = await fetch(`${base}/presets`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ presets: CriteriaSet[] }>(res, 'listPresets')).presets;
}

export async function listLists(): Promise<PriorityList[]> {
  const res = await fetch(`${base}/lists`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ lists: PriorityList[] }>(res, 'listLists')).lists;
}

export interface CreateListInput { orgId: string; name: string; projectId?: string; presetId?: PresetId; votingMode?: VotingMode; voteAggregation?: VoteAggregation }
export async function createList(input: CreateListInput): Promise<PriorityList> {
  const res = await fetch(`${base}/lists`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<PriorityList>(res, 'createList');
}

export async function updateList(listId: string, patch: { name?: string; criteriaSet?: CriteriaSet; presetId?: PresetId; votingMode?: VotingMode; voteAggregation?: VoteAggregation; voterWeights?: Record<string, number> }): Promise<PriorityList> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<PriorityList>(res, 'updateList');
}

export async function deleteList(listId: string): Promise<void> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 404) throw new Error(`deleteList returned ${res.status}`);
}

export async function listIdeas(listId: string): Promise<RankedIdea[]> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ ideas: RankedIdea[] }>(res, 'listIdeas')).ideas;
}

export async function submitIdea(listId: string, input: { title: string; description?: string }): Promise<unknown> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson(res, 'submitIdea');
}

export async function moveIdeaStatus(listId: string, cardId: string, columnId: string): Promise<unknown> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(cardId)}/status`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ columnId }) }));
  return asJson(res, 'moveIdeaStatus');
}

export async function setIdeaScores(listId: string, cardId: string, scores: Record<string, number>): Promise<unknown> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(cardId)}/scores`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ scores }) }));
  return asJson(res, 'setIdeaScores');
}

/** Per-voter breakdown for an idea (multi-voter; owner/admin only — 403 otherwise). */
export async function getVoteBreakdown(listId: string, cardId: string): Promise<VoteBreakdownEntry[]> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(cardId)}/votes`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ votes: VoteBreakdownEntry[] }>(res, 'getVoteBreakdown')).votes;
}

export async function listSessions(listId: string): Promise<PlanningSession[]> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/sessions`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ sessions: PlanningSession[] }>(res, 'listSessions')).sessions;
}

/** How a saved meeting agenda is ordered (ADR 0058). */
export type AgendaSort = 'priority' | 'created' | 'owner' | 'status' | 'title';
export async function createSession(listId: string, input: { name?: string; mode?: 'top-n' | 'manual' | 'both'; n?: number; cardIds?: string[]; sort?: AgendaSort; sortDir?: 'asc' | 'desc' }): Promise<PlanningSession> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/sessions`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<PlanningSession>(res, 'createSession');
}

/** Re-order an existing agenda in place (ADR 0058 — no duplicate session per reorder). */
export async function updateSession(listId: string, sessionId: string, patch: { sort?: AgendaSort; sortDir?: 'asc' | 'desc' }): Promise<PlanningSession> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/sessions/${encodeURIComponent(sessionId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<PlanningSession>(res, 'updateSession');
}

export async function listPortfolio(topN?: number, orgId?: string, normalize?: NormalizeMode): Promise<{ items: PortfolioItem[]; lists: PortfolioListRef[]; normalize: NormalizeMode }> {
  const qs = new URLSearchParams();
  if (topN) qs.set('topN', String(topN));
  if (orgId) qs.set('orgId', orgId);
  if (normalize && normalize !== 'none') qs.set('normalize', normalize);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetch(`${base}/portfolio${suffix}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<{ items: PortfolioItem[]; lists: PortfolioListRef[]; normalize: NormalizeMode }>(res, 'listPortfolio');
}

// ── federation (ADR 0061) ──
export async function listPeers(): Promise<FederatedPeer[]> {
  const res = await fetch(`${base}/peers`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ peers: FederatedPeer[] }>(res, 'listPeers')).peers;
}
export async function addPeer(label: string, baseUrl: string): Promise<FederatedPeer> {
  const res = await fetch(`${base}/peers`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ label, baseUrl }) }));
  return asJson<FederatedPeer>(res, 'addPeer');
}
export async function deletePeer(id: string): Promise<void> {
  const res = await fetch(`${base}/peers/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 404) throw new Error(`deletePeer returned ${res.status}`);
}
/** Set a peer's bearer (ADR 0062). scope 'user' = the caller's own (closes the authz
 *  asymmetry); 'tenant' = workspace-shared (superadmin — a 403 surfaces otherwise). */
export async function setPeerCredential(peerId: string, token: string, scope: 'tenant' | 'user'): Promise<void> {
  const res = await fetch(`${base}/peers/${encodeURIComponent(peerId)}/credential`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ token, scope }) }));
  if (!res.ok) {
    let detail = ''; try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `setPeerCredential returned ${res.status}`);
  }
}

export async function listFederatedPortfolio(topN?: number): Promise<{ items: FederatedItem[]; peers: PeerStatus[] }> {
  const suffix = topN ? `?topN=${topN}` : '';
  const res = await fetch(`${base}/portfolio/federated${suffix}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<{ items: FederatedItem[]; peers: PeerStatus[] }>(res, 'listFederatedPortfolio');
}

// ── schedule status (ADR 0103) ──
export async function getScheduleStatus(listId: string): Promise<{ ideas: IdeaScheduleStatus[]; rollup: ScheduleRollup }> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/schedule`, fetchOpts({ headers: authedHeaders() }));
  return asJson<{ ideas: IdeaScheduleStatus[]; rollup: ScheduleRollup }>(res, 'getScheduleStatus');
}
export async function setIdeaSchedule(listId: string, cardId: string, targetDate: string, startDate?: string): Promise<unknown> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(cardId)}/schedule`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ targetDate, ...(startDate ? { startDate } : {}) }) }));
  return asJson(res, 'setIdeaSchedule');
}
export async function clearIdeaSchedule(listId: string, cardId: string): Promise<void> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(cardId)}/schedule`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 404) throw new Error(`clearIdeaSchedule returned ${res.status}`);
}

// ── composed reads from sibling surfaces (for the create form) ──
export async function listOrgs(): Promise<OrgRef[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: OrgRef[] }>(res, 'listOrgs')).orgs;
}
export async function listProjects(): Promise<ProjectRef[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/projects`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ projects: ProjectRef[] }>(res, 'listProjects')).projects;
}
