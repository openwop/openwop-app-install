/**
 * Priority Matrix API client (ADR 0058). The lists / ideas / scores / planning
 * sessions surface under /host/openwop-app/priority-matrix/*. An "idea" is a
 * host.kanban card; statuses are the board's columns.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type Aggregation = 'weighted-sum' | 'ratio' | 'product-ratio';
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
/** PMXU-1 (ADR 0590) — actor class stamped by the backend writer. Absent on
 *  rows written before the stamp existed (pre-fix rows are NOT claimed human). */
export type IdeaWriterSource = 'human' | 'workflow' | 'agent' | string;

export interface RankedIdea {
  /** The underlying kanban card. `createdAt`/`createdBy`/`assigneeId` come through
   *  from the full `KanbanCard` (the agenda sorts on them). */
  card: { id: string; title: string; description?: string; columnId: string; createdAt?: string; createdBy?: string; assigneeId?: string; source?: IdeaWriterSource };
  status: { columnId: string; columnName: string; terminal: boolean };
  scores: Record<string, number>;
  computedPriority: number;
  rank: number;
  /** ADR 0667 D1c — how completely this idea is scored. `computedPriority === 0`
   *  cannot distinguish "never touched" from "3 of 4 scored" (both are exactly 0 in
   *  ratio mode), so the count is carried rather than inferred from the number. */
  completeness: { declared: number; scored: number; missing: string[]; complete: boolean };
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
export interface VoteBreakdownEntry { voterId: string; scores: Record<string, number>; updatedAt: string; source?: IdeaWriterSource }

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

const base = `${config.baseUrl}/host/openwop-app/priority-matrix`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/** PMX-8b (ADR 0590) — a typed failure carrying the HTTP status, so a caller
 *  can DISCRIMINATE a 403 (a real authorization refusal) from a network/500
 *  failure instead of inventing a permissions explanation for either. */
export class PriorityMatrixApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'PriorityMatrixApiError';
  }
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new PriorityMatrixApiError(detail || `${ctx} returned ${res.status}`, res.status);
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

/** Edit an idea's title/description (ADR 0259). Scores/status/schedule unchanged. */
export async function updateIdea(listId: string, cardId: string, patch: { title?: string; description?: string }): Promise<unknown> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(cardId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson(res, 'updateIdea');
}

/** Delete an idea (ADR 0259). Idempotent — a 404 (already gone) is not an error. */
export async function deleteIdea(listId: string, cardId: string): Promise<void> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(cardId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 404) throw new Error(`deleteIdea returned ${res.status}`);
}

/** Clone an idea (ADR 0259) — a new idea seeded with the source's title + description
 *  (+ single-mode scores). An optional `title` overrides the default "… (copy)". */
export async function cloneIdea(listId: string, cardId: string, input?: { title?: string }): Promise<unknown> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(cardId)}/clone`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input ?? {}) }));
  return asJson(res, 'cloneIdea');
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

// ── intake + evidence + merge + promotion (ADR 0232) ──
export type IntakeSourceChannel = 'form' | 'chat' | 'api' | 'manual';
export interface IdeaIntake {
  listId: string; cardId: string;
  requester?: string; sourceChannel?: IntakeSourceChannel;
  estimatedValue?: number; estimatedValueUnit?: string; notes?: string;
  mergedInto?: string;
  promotedTo?: { kind: 'initiative' | 'project'; id: string; strategyId?: string };
  updatedBy: string; updatedAt: string;
}
export interface IdeaEvidence { evidenceId: string; listId: string; cardId: string; kind: 'document' | 'kb' | 'url'; ref: string; label?: string; addedBy: string; addedAt: string }

export async function getIdeaIntake(listId: string, cardId: string): Promise<{ intake: IdeaIntake | null; evidence: IdeaEvidence[] }> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(cardId)}/intake`, fetchOpts({ headers: authedHeaders() }));
  return asJson(res, 'getIdeaIntake');
}
/** Clear semantics: send `''` (strings) or `null` (value/channel) to clear a
 *  field; omit to leave unchanged (JSON drops `undefined`). */
export async function patchIdeaIntake(listId: string, cardId: string, patch: {
  requester?: string; sourceChannel?: IntakeSourceChannel | null;
  estimatedValue?: number | null; estimatedValueUnit?: string; notes?: string;
}): Promise<IdeaIntake> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(cardId)}/intake`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson(res, 'patchIdeaIntake');
}
export async function addIdeaEvidence(listId: string, cardId: string, input: { kind: IdeaEvidence['kind']; ref: string; label?: string }): Promise<IdeaEvidence> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(cardId)}/evidence`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson(res, 'addIdeaEvidence');
}
export async function removeIdeaEvidence(listId: string, cardId: string, evidenceId: string): Promise<void> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(cardId)}/evidence/${encodeURIComponent(evidenceId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  // Tolerate 404 — delete is idempotent, so a double-click's second DELETE
  // (already-removed id) is a no-op, not a spurious error (grade-code FE#9;
  // matches deleteList/deletePeer).
  if (!res.ok && res.status !== 204 && res.status !== 404) throw new Error(`removeIdeaEvidence returned ${res.status}`);
}
export async function mergeIdea(listId: string, canonicalCardId: string, duplicateCardId: string): Promise<void> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(canonicalCardId)}/merge`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ duplicateCardId }) }));
  await asJson(res, 'mergeIdea');
}
/** PMX-2 (ADR 0590) — the backend now REPORTS the completion-lane move outcome:
 *  `moved:false` means the project minted + promotion stamped but the card
 *  could not be moved (surface it — never silently claim the full promotion). */
export async function promoteIdeaToProject(listId: string, cardId: string): Promise<{ projectId: string; cardId: string; moved: boolean; movedToColumnId?: string }> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(cardId)}/promote-to-project`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return asJson(res, 'promoteIdeaToProject');
}

// ── score history + "why ranked here" (ADR 0234 §C7 / STRAT-FE2) ──
export interface ScoreChange { changeId: string; priorPriority?: number; newPriority?: number; scores: Record<string, number>; actor: string; voterId?: string; createdAt: string }
export interface ScoreBreakdownRow { criterionId: string; name: string; weight: number; score?: number; weighted?: number }
export async function getIdeaScoreHistory(listId: string, cardId: string): Promise<{ history: ScoreChange[]; breakdown: ScoreBreakdownRow[]; computedPriority?: number; rank?: number }> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/ideas/${encodeURIComponent(cardId)}/score-history`, fetchOpts({ headers: authedHeaders() }));
  return asJson(res, 'getIdeaScoreHistory');
}

// ── planning-session scenarios (ADR 0235 §D1 / STRAT-FE2) ──
export type ScenarioSelection = { mode: 'top-n'; n: number } | { mode: 'manual'; cardIds: string[] };
export interface ScenarioConstraints { maxItems?: number; maxBudget?: number }
export interface SessionScenario { scenarioId: string; name: string; selection: ScenarioSelection; constraints?: ScenarioConstraints; proposedBy?: 'agent'; planOfRecord?: boolean; createdBy: string; createdAt: string }
export interface ResolvedScenarioLine { cardId: string; title: string; rank: number; estimatedValue?: number; droppedBy?: 'maxItems' | 'maxBudget' | 'selection' }
/** `approvalStatus` (PMXU-2, ADR 0590) — decision state of the agent-proposal
 *  gate, joined by the backend at read (absent for human scenarios). */
export interface ResolvedScenario extends SessionScenario { aboveLine: ResolvedScenarioLine[]; belowLine: ResolvedScenarioLine[]; totalEstimatedValue: number; approvalStatus?: 'pending' | 'approved' | 'rejected' }

export async function listScenarios(listId: string, sessionId: string): Promise<ResolvedScenario[]> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/sessions/${encodeURIComponent(sessionId)}/scenarios`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ scenarios: ResolvedScenario[] }>(res, 'listScenarios')).scenarios;
}
export async function addScenario(listId: string, sessionId: string, input: { name: string; selection: ScenarioSelection; constraints?: ScenarioConstraints }): Promise<SessionScenario> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/sessions/${encodeURIComponent(sessionId)}/scenarios`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson(res, 'addScenario');
}
/** PMXU-2 (ADR 0590) — decline an agent-proposed scenario from the page (the
 *  strategy check-in dismiss pattern); decides the SHARED approval row. */
export async function rejectScenario(listId: string, sessionId: string, scenarioId: string): Promise<{ scenarioId: string; approvalStatus: 'rejected' }> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/sessions/${encodeURIComponent(sessionId)}/scenarios/${encodeURIComponent(scenarioId)}/reject`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return asJson(res, 'rejectScenario');
}
export async function selectScenario(listId: string, sessionId: string, scenarioId: string): Promise<SessionScenario> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/sessions/${encodeURIComponent(sessionId)}/scenarios/${encodeURIComponent(scenarioId)}/select`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return asJson(res, 'selectScenario');
}
export async function compareScenarios(listId: string, sessionId: string, a: string, b: string): Promise<{ a: ResolvedScenario; b: ResolvedScenario; gainedInB: Array<{ cardId: string; title: string }>; droppedInB: Array<{ cardId: string; title: string }> }> {
  const res = await fetch(`${base}/lists/${encodeURIComponent(listId)}/sessions/${encodeURIComponent(sessionId)}/scenarios/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson(res, 'compareScenarios');
}

// ── composed reads from sibling surfaces (for the create form) ──
export async function listOrgs(): Promise<OrgRef[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: OrgRef[] }>(res, 'listOrgs')).orgs;
}
export async function listProjects(): Promise<ProjectRef[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/projects`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ projects: ProjectRef[] }>(res, 'listProjects')).projects;
}
