/**
 * Priority Matrix service (ADR 0058). Owns lists + criteria sets + per-idea score
 * overlays + planning sessions. Reuses `host.kanban` for the board, the ideas
 * (cards), and the statuses (columns) — no parallel board/idea/status store
 * ([[no-parallel-architecture]]). Composes the `documents` feature (ADR 0053) for
 * the planning-session agenda, degrading to inline markdown when it is OFF.
 *
 * Tenant + IDOR discipline: every read/write is tenant-keyed; a foreign-tenant
 * list/board/card reads `null` (fail-closed, no existence leak).
 *
 * @see docs/adr/0058-priority-matrix.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import {
  createBoard, deleteBoard, getBoard, listCards, getCard, createCard, moveCard,
  isTerminalColumn, type KanbanBoard, type KanbanCard,
} from '../../host/kanbanService.js';
import { getProject } from '../projects/projectsService.js';
import { createDocument, addVersion, deleteDocument } from '../documents/documentsService.js';
import { computePriority, rankByPriority } from './scoring.js';
import { deriveScheduleStatus, rollupSchedule, type ScheduleRollup, type ScheduleState, type ScheduleStatus } from './schedule.js';
import { indexList, indexIdea, removeList, ideaCardIds, reindexListIdeas } from './priorityMatrixKnowledgeService.js';
import {
  CRITERIA_PRESETS, DEFAULT_STATUS_COLUMNS, PRESET_IDS,
  type Aggregation, type AgendaSort, type Criterion, type CriteriaSet, type IdeaSchedule, type IdeaScore, type IdeaVote,
  type PlanningSession, type PresetId, type PriorityList, type SessionSelection,
  type VoteAggregation, type VotingMode,
} from './types.js';

const lists = new DurableCollection<PriorityList>('priority-matrix:list', (l) => `${l.tenantId}::${l.id}`);
const scores = new DurableCollection<IdeaScore>('priority-matrix:score', (s) => `${s.listId}::${s.cardId}`);
const votes = new DurableCollection<IdeaVote>('priority-matrix:vote', (v) => `${v.listId}::${v.cardId}::${v.voterId}`);
const sessions = new DurableCollection<PlanningSession>('priority-matrix:session', (s) => `${s.tenantId}::${s.id}`);
const schedules = new DurableCollection<IdeaSchedule>('priority-matrix:schedule', (s) => `${s.listId}::${s.cardId}`);

/** A scored value + the voter's weight (ADR 0059 weighted voters). */
interface WeightedScore { value: number; weight: number }

const unweightedMean = (vals: number[]): number => vals.reduce((s, n) => s + n, 0) / vals.length;
const unweightedMedian = (vals: number[]): number => {
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};
const weightedMean = (e: WeightedScore[]): number => {
  const w = e.reduce((s, x) => s + x.weight, 0);
  return w > 0 ? e.reduce((s, x) => s + x.value * x.weight, 0) / w : 0;
};
/** Lower weighted median: the smallest value whose cumulative weight reaches half
 *  the total weight. (Falls back to the max when weights are degenerate.) */
const weightedMedian = (e: WeightedScore[]): number => {
  const sorted = [...e].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) return 0;
  const half = total / 2;
  let cum = 0;
  for (const x of sorted) { cum += x.weight; if (cum >= half) return x.value; }
  return sorted[sorted.length - 1].value;
};

/**
 * Aggregate every voter's per-criterion scores into one effective map. With no
 * (or uniform) `voterWeights`, this is the original equal-weight mean/median —
 * exact prior behaviour, so unweighted lists are unchanged. When weights differ
 * (ADR 0059 weighted voters / Limited Weighted Votes), it switches to the
 * weighted arithmetic mean (`mean`) or weighted median (`median`) so a higher-
 * weighted stakeholder's vote counts proportionally more — and weights are never
 * silently ignored in either mode.
 */
function aggregateVotes(
  voteRows: IdeaVote[],
  aggregation: VoteAggregation,
  voterWeights: Record<string, number> = {},
): Record<string, number> {
  const weightOf = (voterId: string): number => {
    const w = voterWeights[voterId];
    return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 1;
  };
  // "Uniform" = every present voter carries the SAME weight (not merely weight 1):
  // with equal weights the weighted mean is identical to the plain mean, but the
  // weighted (lower) median is NOT identical to the averaged unweighted median, so an
  // all-equal-but-non-1 list MUST still take the unweighted path or its median would
  // silently differ from the default (code-review 2026-06-16).
  const w0 = voteRows.length > 0 ? weightOf(voteRows[0].voterId) : 1;
  const uniform = voteRows.every((v) => weightOf(v.voterId) === w0);
  const byCriterion = new Map<string, WeightedScore[]>();
  for (const v of voteRows) {
    const weight = weightOf(v.voterId);
    for (const [cid, val] of Object.entries(v.scores)) {
      if (typeof val !== 'number' || !Number.isFinite(val)) continue;
      const arr = byCriterion.get(cid) ?? [];
      arr.push({ value: val, weight });
      byCriterion.set(cid, arr);
    }
  }
  const out: Record<string, number> = {};
  for (const [cid, entries] of byCriterion) {
    if (entries.length === 0) continue;
    if (uniform) {
      const vals = entries.map((e) => e.value);
      out[cid] = aggregation === 'median' ? unweightedMedian(vals) : unweightedMean(vals);
    } else {
      out[cid] = aggregation === 'median' ? weightedMedian(entries) : weightedMean(entries);
    }
  }
  return out;
}

const parseVotingMode = (v: unknown): VotingMode => (v === 'multi-voter' ? 'multi-voter' : 'single');
const parseVoteAggregation = (v: unknown): VoteAggregation => (v === 'median' ? 'median' : 'mean');

/** Validate a voterId → weight map (ADR 0059): each weight an integer 1..10; bad
 *  entries dropped; capped to keep the list config bounded. Default/absent = 1. */
const VOTER_WEIGHTS_CAP = 500;
function parseVoterWeights(value: unknown): Record<string, number> {
  const raw = (value ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [voterId, w] of Object.entries(raw)) {
    if (Object.keys(out).length >= VOTER_WEIGHTS_CAP) break;
    if (typeof voterId !== 'string' || !voterId) continue;
    const n = typeof w === 'number' ? w : Number(w);
    if (Number.isFinite(n) && n >= 1 && n <= 10) out[voterId] = Math.round(n);
  }
  return out;
}

const LIST_CAP = 200;
const IDEAS_CAP = 1_000;
const nowIso = (): string => new Date().toISOString();

// ─── validation ──────────────────────────────────────────────────────────────

const KEBAB = /^[a-z0-9][a-z0-9-]{0,63}$/;

function asWeight(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 10) {
    throw new OpenwopError('validation_error', `\`${field}\` MUST be a number between 1 and 10.`, 400, { field });
  }
  return Math.round(n);
}

function validateCriteriaSet(value: unknown): CriteriaSet {
  const raw = (value ?? {}) as Record<string, unknown>;
  const aggregation = raw.aggregation === 'ratio' ? 'ratio' : 'weighted-sum';
  if (!Array.isArray(raw.criteria) || raw.criteria.length === 0) {
    throw new OpenwopError('validation_error', 'A criteria set MUST have at least one criterion.', 400, { field: 'criteria' });
  }
  if (raw.criteria.length > 20) {
    throw new OpenwopError('validation_error', 'A criteria set MUST have at most 20 criteria.', 400, { field: 'criteria' });
  }
  const seen = new Set<string>();
  const criteria: Criterion[] = raw.criteria.map((c, i) => {
    const cr = (c ?? {}) as Record<string, unknown>;
    const name = cleanString(cr.name, 80);
    if (!name) throw new OpenwopError('validation_error', `criteria[${i}].name is required.`, 400, { field: `criteria[${i}].name` });
    const id = typeof cr.id === 'string' && KEBAB.test(cr.id)
      ? cr.id
      : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || `c${i}`;
    if (seen.has(id)) throw new OpenwopError('validation_error', `Duplicate criterion id \`${id}\`.`, 400, { field: `criteria[${i}].id` });
    seen.add(id);
    const direction = cr.direction === 'cost' ? 'cost' : 'benefit';
    return {
      id,
      name,
      ...(cleanString(cr.description, 280) ? { description: cleanString(cr.description, 280) } : {}),
      weight: asWeight(cr.weight ?? 5, `criteria[${i}].weight`),
      direction,
      ...(cleanString(cr.scaleHint, 200) ? { scaleHint: cleanString(cr.scaleHint, 200) } : {}),
    };
  });
  return {
    aggregation: aggregation as Aggregation,
    criteria,
    ...(typeof raw.presetId === 'string' && (PRESET_IDS as readonly string[]).includes(raw.presetId) ? { presetId: raw.presetId as PresetId } : {}),
  };
}

/** Resolve the criteria set for create/update: an explicit set wins; else a named
 *  preset; else the default "weighted" preset. */
function resolveCriteriaInput(body: Record<string, unknown>): CriteriaSet {
  if (body.criteriaSet !== undefined) return validateCriteriaSet(body.criteriaSet);
  if (typeof body.presetId === 'string') {
    const preset = CRITERIA_PRESETS[body.presetId as PresetId];
    if (!preset) throw new OpenwopError('validation_error', `Unknown preset \`${body.presetId}\`. One of: ${PRESET_IDS.join(', ')}.`, 400, { field: 'presetId' });
    // Deep clone so per-list weight edits don't mutate the shared preset.
    return { ...preset, criteria: preset.criteria.map((c) => ({ ...c })) };
  }
  return { ...CRITERIA_PRESETS.weighted, criteria: CRITERIA_PRESETS.weighted.criteria.map((c) => ({ ...c })) };
}

// ─── lists ───────────────────────────────────────────────────────────────────

export async function listLists(tenantId: string): Promise<PriorityList[]> {
  return (await lists.listByPrefix(`${tenantId}::`))
    .filter((l) => l.tenantId === tenantId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getList(tenantId: string, id: string): Promise<PriorityList | null> {
  const l = await lists.get(`${tenantId}::${id}`);
  return l && l.tenantId === tenantId ? l : null;
}

export async function createList(
  tenantId: string,
  orgId: string,
  createdBy: string,
  body: Record<string, unknown>,
): Promise<PriorityList> {
  const name = cleanString(body.name, 120);
  if (!name) throw new OpenwopError('validation_error', 'Field `name` is required.', 400, { field: 'name' });
  if ((await listLists(tenantId)).length >= LIST_CAP) {
    throw new OpenwopError('validation_error', `This workspace already has the maximum ${LIST_CAP} priority lists.`, 400, { cap: LIST_CAP });
  }
  // Optional project scoping: the project MUST exist in this tenant + org (the
  // ADR 0046 derived-org invariant — a foreign/dangling project is a 404, no leak).
  let projectId: string | undefined;
  if (body.projectId !== undefined && body.projectId !== null && body.projectId !== '') {
    const pid = cleanString(body.projectId, 80);
    const project = pid ? await getProject(tenantId, pid) : null;
    if (!project || project.orgId !== orgId) {
      throw new OpenwopError('not_found', 'Project not found in this organization.', 404, { projectId: body.projectId });
    }
    projectId = project.id;
  }
  const criteriaSet = resolveCriteriaInput(body);

  // Provision a REAL host.kanban board with the status columns (no parallel board).
  const board = await createBoard({
    tenantId,
    name: `${name} — priorities`,
    columns: DEFAULT_STATUS_COLUMNS.map((c) => ({ ...c })),
    ...(projectId ? { ownerSubject: { kind: 'project', id: projectId } } : {}),
  });

  const ts = nowIso();
  const list: PriorityList = {
    id: `plist-${randomUUID().slice(0, 12)}`,
    tenantId,
    orgId,
    ...(projectId ? { projectId } : {}),
    name,
    boardId: board.id,
    criteriaSet,
    votingMode: parseVotingMode(body.votingMode),
    voteAggregation: parseVoteAggregation(body.voteAggregation),
    createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
  await lists.put(list);
  await indexList(tenantId, list, createdBy); // ADR 0100 — best-effort, gated, skips project-scoped
  return list;
}

/** Rename a list and/or replace its criteria set. When the criteria/weights change,
 *  every idea's cached `computedPriority` is recomputed. Caller enforces authority. */
export async function updateList(
  tenantId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<PriorityList> {
  const current = await getList(tenantId, id);
  if (!current) throw new OpenwopError('not_found', 'Priority list not found.', 404, { id });
  const next: PriorityList = { ...current, updatedAt: nowIso() };
  if (body.name !== undefined) {
    const name = cleanString(body.name, 120);
    if (!name) throw new OpenwopError('validation_error', 'Field `name` must be a non-empty string.', 400, { field: 'name' });
    next.name = name;
  }
  let criteriaChanged = false;
  if (body.criteriaSet !== undefined || body.presetId !== undefined) {
    next.criteriaSet = resolveCriteriaInput(body);
    criteriaChanged = true;
  }
  // ADR 0059 — switching the scoring model (mode/aggregation) is config-authority
  // gated at the route, alongside criteria edits.
  if (body.votingMode !== undefined) next.votingMode = parseVotingMode(body.votingMode);
  if (body.voteAggregation !== undefined) next.voteAggregation = parseVoteAggregation(body.voteAggregation);
  // ADR 0059 weighted voters — voterId → 1..10 (default/absent = 1). Config-authority
  // gated at the route; a weight change re-ranks the multi-voter aggregates.
  if (body.voterWeights !== undefined) next.voterWeights = parseVoterWeights(body.voterWeights);
  const seedSingleToMulti = current.votingMode === 'single' && next.votingMode === 'multi-voter';
  await lists.put(next);
  await indexList(tenantId, next, next.createdBy); // ADR 0100 — re-index the list's criteria doc
  if (criteriaChanged) {
    await recomputeListScores(next);
    await reindexListIdeas(tenantId, next, next.createdBy); // priorities re-ranked ⇒ refresh idea docs
  }
  // ADR 0059 follow-on — on a single→multi switch, seed the creator's vote from each
  // idea's existing shared `IdeaScore` so the scores don't vanish from the ranking
  // (the limitation the ADR flagged). Idempotent: skip a card that already has a vote.
  if (seedSingleToMulti) await seedVotesFromScores(next);
  return next;
}

/** ADR 0059 — seed the list creator's `IdeaVote` from each existing shared `IdeaScore`
 *  when a list flips single→multi-voter, so prior scores survive the switch. Only
 *  seeds cards without an existing vote by the creator (idempotent / non-destructive). */
async function seedVotesFromScores(list: PriorityList): Promise<void> {
  const scoreRows = await scores.listByPrefix(`${list.id}::`);
  for (const s of scoreRows) {
    if (Object.keys(s.scores).length === 0) continue;
    const existing = await votes.get(`${list.id}::${s.cardId}::${list.createdBy}`);
    if (existing) continue;
    await votes.put({ listId: list.id, cardId: s.cardId, voterId: list.createdBy, scores: { ...s.scores }, updatedAt: nowIso() });
  }
}

export async function deleteList(tenantId: string, id: string): Promise<boolean> {
  const current = await getList(tenantId, id);
  if (!current) return false;
  // ADR 0100 — capture the idea card ids BEFORE the board is deleted; ideas have
  // no standalone delete path, so this is the only chance to evict their KB docs.
  const cardIds = await ideaCardIds(current.boardId);
  // Board first (its cards become unreachable), then the score overlays + votes + sessions.
  await deleteBoard(current.boardId);
  await removeList(tenantId, current.orgId, id, cardIds);
  for (const s of await scores.listByPrefix(`${id}::`)) await scores.delete(`${s.listId}::${s.cardId}`);
  for (const sc of await schedules.listByPrefix(`${id}::`)) await schedules.delete(`${sc.listId}::${sc.cardId}`);
  for (const v of await votes.listByPrefix(`${id}::`)) await votes.delete(`${v.listId}::${v.cardId}::${v.voterId}`);
  for (const s of (await sessions.listByPrefix(`${tenantId}::`)).filter((x) => x.listId === id)) {
    await sessions.delete(`${tenantId}::${s.id}`);
  }
  return lists.delete(`${tenantId}::${id}`);
}

// ─── ideas (kanban cards) + scores ─────────────────────────────────────────────

/** A list's board, asserting tenant ownership (IDOR — a foreign board reads null). */
async function listBoard(list: PriorityList) {
  const board = await getBoard(list.boardId);
  return board && board.tenantId === list.tenantId ? board : null;
}

/** A ranked idea: the kanban card + status + the EFFECTIVE score map (the shared
 *  score in `single` mode, the aggregate of all votes in `multi-voter`) + computed
 *  priority + rank. In `multi-voter`, `voterCount` is how many members voted and
 *  `myScores` is the requesting caller's own vote (for the editable grid). */
export interface RankedIdea {
  card: KanbanCard;
  status: { columnId: string; columnName: string; terminal: boolean };
  scores: Record<string, number>;
  computedPriority: number;
  rank: number;
  voterCount?: number;
  myScores?: Record<string, number>;
}

export async function listRankedIdeas(tenantId: string, listId: string, voterId?: string): Promise<RankedIdea[]> {
  const list = await getList(tenantId, listId);
  if (!list) throw new OpenwopError('not_found', 'Priority list not found.', 404, { listId });
  const board = await listBoard(list);
  if (!board) return [];
  const cards = await listCards(board.id);
  const columnOf = (columnId: string) => board.columns.find((c) => c.id === columnId);
  const statusOf = (columnId: string) => ({ columnId, columnName: columnOf(columnId)?.name ?? columnId, terminal: columnOf(columnId)?.terminal === true });

  if (list.votingMode === 'multi-voter') {
    const voteRows = await votes.listByPrefix(`${listId}::`);
    const byCard = new Map<string, IdeaVote[]>();
    for (const v of voteRows) { const a = byCard.get(v.cardId) ?? []; a.push(v); byCard.set(v.cardId, a); }
    const aggByCard = new Map<string, Record<string, number>>();
    for (const [cid, rows] of byCard) aggByCard.set(cid, aggregateVotes(rows, list.voteAggregation, list.voterWeights));
    const ranked = rankByPriority(list.criteriaSet, cards, (c) => aggByCard.get(c.id) ?? {});
    return ranked.map((r) => {
      const rows = byCard.get(r.item.id) ?? [];
      const mine = voterId ? rows.find((v) => v.voterId === voterId) : undefined;
      return {
        card: r.item,
        status: statusOf(r.item.columnId),
        scores: aggByCard.get(r.item.id) ?? {},
        computedPriority: r.priority,
        rank: r.rank,
        voterCount: rows.length,
        myScores: mine?.scores ?? {},
      };
    });
  }

  // single mode (default) — the one shared IdeaScore per idea.
  const scoreRows = await scores.listByPrefix(`${listId}::`);
  const scoreByCard = new Map(scoreRows.map((s) => [s.cardId, s.scores]));
  const ranked = rankByPriority(list.criteriaSet, cards, (c) => scoreByCard.get(c.id) ?? {});
  return ranked.map((r) => ({
    card: r.item,
    status: statusOf(r.item.columnId),
    scores: scoreByCard.get(r.item.id) ?? {},
    computedPriority: r.priority,
    rank: r.rank,
    myScores: scoreByCard.get(r.item.id) ?? {},
  }));
}

// ─── portfolio (intra-host cross-list rollup, ADR 0060) ────────────────────────

/** One idea in the portfolio view — carries its source list + in-list rank +
 *  scoring model so cross-list ordering is honest (priorities aren't strictly
 *  comparable across lists with different criteria/scoring). */
export interface PortfolioItem {
  listId: string;
  listName: string;
  votingMode: VotingMode;
  scoringModel: string; // presetId, or 'custom'
  cardId: string;
  title: string;
  status: string;
  computedPriority: number;
  inListRank: number;
  /** ADR 0060 — opt-in cross-list-comparable score in [0,100], present only when a
   *  `normalize` mode was requested. `list-relative` = priority ÷ list-max; `percentile`
   *  = position within the list. Honest cross-list ordering uses THIS when requested. */
  normalizedPriority?: number;
}

/** ADR 0060 — opt-in normalization for cross-list comparability (default `none` =
 *  rank by raw priority + surface source/model, the honest-but-incomparable default). */
export type NormalizeMode = 'none' | 'list-relative' | 'percentile';
export const NORMALIZE_MODES: readonly NormalizeMode[] = ['none', 'list-relative', 'percentile'];

/** A list that contributed to a portfolio (for the "what was aggregated" header). */
export interface PortfolioListRef {
  listId: string;
  name: string;
  scoringModel: string;
  ideaCount: number;
}

const PORTFOLIO_DEFAULT_TOP_N = 20;
const PORTFOLIO_MAX_TOP_N = 200;
const scoringModelOf = (list: PriorityList): string => list.criteriaSet.presetId ?? 'custom';

/**
 * Merge the ranked ideas of the GIVEN (already-authorized) lists into one
 * descending-by-priority portfolio, sliced to `topN`. RBAC is the caller's
 * responsibility — pass only lists the caller may read (the route applies the
 * per-org readability filter; the workflow surface passes the run's tenant lists).
 */
const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function buildPortfolio(
  tenantId: string,
  lists: PriorityList[],
  topN: number = PORTFOLIO_DEFAULT_TOP_N,
  normalize: NormalizeMode = 'none',
): Promise<{ items: PortfolioItem[]; lists: PortfolioListRef[]; normalize: NormalizeMode }> {
  const limit = Math.max(1, Math.min(Math.round(topN) || PORTFOLIO_DEFAULT_TOP_N, PORTFOLIO_MAX_TOP_N));
  const items: PortfolioItem[] = [];
  const refs: PortfolioListRef[] = [];
  for (const list of lists) {
    const ranked = await listRankedIdeas(tenantId, list.id);
    const scoringModel = scoringModelOf(list);
    refs.push({ listId: list.id, name: list.name, scoringModel, ideaCount: ranked.length });
    // Per-list normalization context (ADR 0060): list-relative needs the list's max
    // priority; percentile needs the list's count. Computed once per list.
    const listMax = ranked.reduce((m, r) => Math.max(m, r.computedPriority), 0);
    const count = ranked.length;
    for (const r of ranked) {
      let normalizedPriority: number | undefined;
      if (normalize === 'list-relative') {
        normalizedPriority = listMax > 0 ? round2((r.computedPriority / listMax) * 100) : 0;
      } else if (normalize === 'percentile') {
        // rank 1 of N → 100; rank N → 0; single-item list → 100.
        normalizedPriority = count > 1 ? round2(((count - r.rank) / (count - 1)) * 100) : 100;
      }
      items.push({
        listId: list.id,
        listName: list.name,
        votingMode: list.votingMode,
        scoringModel,
        cardId: r.card.id,
        title: r.card.title,
        status: r.status.columnName,
        computedPriority: r.computedPriority,
        inListRank: r.rank,
        ...(normalizedPriority !== undefined ? { normalizedPriority } : {}),
      });
    }
  }
  // Sort by the normalized score when requested (cross-list-comparable), else by raw
  // priority desc. Ties keep insertion order (stable).
  const key = (i: PortfolioItem): number => (normalize === 'none' ? i.computedPriority : (i.normalizedPriority ?? 0));
  items.sort((a, b) => key(b) - key(a));
  return { items: items.slice(0, limit), lists: refs.sort((a, b) => a.name.localeCompare(b.name)), normalize };
}

export async function submitIdea(
  tenantId: string,
  listId: string,
  createdBy: string,
  body: Record<string, unknown>,
): Promise<KanbanCard> {
  const list = await getList(tenantId, listId);
  if (!list) throw new OpenwopError('not_found', 'Priority list not found.', 404, { listId });
  const title = cleanString(body.title, 200);
  if (!title) throw new OpenwopError('validation_error', 'Field `title` is required.', 400, { field: 'title' });
  if ((await listCards(list.boardId)).length >= IDEAS_CAP) {
    throw new OpenwopError('validation_error', `This list already has the maximum ${IDEAS_CAP} ideas.`, 400, { cap: IDEAS_CAP });
  }
  // A fresh idea lands in the `New` column. Columns carry no triggerWorkflowId, so
  // moving an idea between statuses never fires a run (ideas are organizational).
  const card = await createCard({
    boardId: list.boardId,
    columnId: 'new',
    title,
    ...(cleanString(body.description, 4000) ? { description: cleanString(body.description, 4000) } : {}),
    source: 'human',
    createdBy,
  });
  await indexIdea(tenantId, list, card.id, createdBy); // ADR 0100
  return card;
}

/** Move an idea to a different status (column). No workflow fires (priority boards
 *  carry no column triggers). Returns the moved card, or null if unknown. */
export async function moveIdeaStatus(tenantId: string, listId: string, cardId: string, toColumnId: string): Promise<KanbanCard | null> {
  const list = await getList(tenantId, listId);
  if (!list) throw new OpenwopError('not_found', 'Priority list not found.', 404, { listId });
  const card = await getCard(cardId);
  if (!card || card.boardId !== list.boardId) return null;
  const moved = await moveCard(cardId, toColumnId);
  if (moved) await indexIdea(tenantId, list, cardId, card.createdBy ?? list.createdBy); // ADR 0100 — status changed
  return moved ? moved.card : null;
}

/** The result of scoring an idea — unified across single + multi-voter modes. */
export interface ScoreResult {
  cardId: string;
  /** The caller's effective input: the shared score (single) or their own vote (multi). */
  scores: Record<string, number>;
  /** Single: this score's priority. Multi: the AGGREGATE priority after the vote. */
  computedPriority: number;
  /** Multi-voter only — how many members have voted on this idea. */
  voterCount?: number;
}

/**
 * Score one idea. In `single` mode this upserts the one shared `IdeaScore`. In
 * `multi-voter` mode (ADR 0059) it upserts the acting member's `IdeaVote` and returns
 * the AGGREGATE priority across all voters — one member can't overwrite another.
 */
export async function setIdeaScore(
  tenantId: string,
  listId: string,
  cardId: string,
  updatedBy: string,
  rawScores: unknown,
): Promise<ScoreResult> {
  const list = await getList(tenantId, listId);
  if (!list) throw new OpenwopError('not_found', 'Priority list not found.', 404, { listId });
  const card = await getCard(cardId);
  if (!card || card.boardId !== list.boardId) throw new OpenwopError('not_found', 'Idea not found in this list.', 404, { cardId });
  const map = (rawScores ?? {}) as Record<string, unknown>;
  const validIds = new Set(list.criteriaSet.criteria.map((c) => c.id));
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(map)) {
    if (!validIds.has(k)) continue; // ignore scores for criteria not in the set
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n) && n >= 1 && n <= 10) clean[k] = Math.round(n);
  }

  if (list.votingMode === 'multi-voter') {
    await votes.put({ listId, cardId, voterId: updatedBy, scores: clean, updatedAt: nowIso() });
    const all = (await votes.listByPrefix(`${listId}::${cardId}::`)).filter((v) => v.cardId === cardId);
    const aggregate = aggregateVotes(all, list.voteAggregation, list.voterWeights);
    await indexIdea(tenantId, list, cardId, updatedBy); // ADR 0100 — aggregate priority changed
    return { cardId, scores: clean, computedPriority: computePriority(list.criteriaSet, aggregate), voterCount: all.length };
  }

  const row: IdeaScore = {
    listId,
    cardId,
    scores: clean,
    computedPriority: computePriority(list.criteriaSet, clean),
    updatedBy,
    updatedAt: nowIso(),
  };
  await scores.put(row);
  await indexIdea(tenantId, list, cardId, updatedBy); // ADR 0100 — score/priority changed
  return { cardId, scores: clean, computedPriority: row.computedPriority };
}

/** One voter's entry in an idea's vote breakdown (ADR 0059). */
export interface VoteBreakdownEntry { voterId: string; scores: Record<string, number>; updatedAt: string }

/**
 * The per-voter breakdown for one idea (ADR 0059) — who scored it and how. Only
 * meaningful for `multi-voter` lists (a `single` list returns `[]`). Caller enforces
 * the elevated config-authority gate (votes can be sensitive; default is owner/admin).
 */
export async function getVoteBreakdown(tenantId: string, listId: string, cardId: string): Promise<VoteBreakdownEntry[]> {
  const list = await getList(tenantId, listId);
  if (!list) throw new OpenwopError('not_found', 'Priority list not found.', 404, { listId });
  const card = await getCard(cardId);
  if (!card || card.boardId !== list.boardId) throw new OpenwopError('not_found', 'Idea not found in this list.', 404, { cardId });
  if (list.votingMode !== 'multi-voter') return [];
  const rows = (await votes.listByPrefix(`${listId}::${cardId}::`)).filter((v) => v.cardId === cardId);
  return rows
    .map((v) => ({ voterId: v.voterId, scores: v.scores, updatedAt: v.updatedAt }))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

/** Recompute every idea's cached priority for a list (after a criteria/weight edit). */
async function recomputeListScores(list: PriorityList): Promise<void> {
  for (const row of await scores.listByPrefix(`${list.id}::`)) {
    const computedPriority = computePriority(list.criteriaSet, row.scores);
    if (computedPriority !== row.computedPriority) {
      await scores.put({ ...row, computedPriority, updatedAt: nowIso() });
    }
  }
}

// ─── schedule status (ADR 0103) ───────────────────────────────────────────────

const CANCEL_RE = /won'?t\s*do|cancel|abandon/i;
const BLOCKED_RE = /block/i;

/** Classify a card's column for schedule derivation. A `terminal` lane that is a
 *  cancellation ("Won't Do") is excluded from schedule pressure; a "Blocked"
 *  status forces at-risk while still open.
 *
 *  The STRUCTURED `column.terminalKind` (CHATP-4) is the primary, locale-independent
 *  signal — seeded on the default `wont-do`/`done` lanes and rename-proof. When
 *  absent (legacy boards predating it) we fall back to the STABLE seeded id
 *  (`wont-do`/`blocked`), then a best-effort name regex.
 *  KNOWN LIMITATION (ADR 0103): only a legacy board whose terminal lane was renamed
 *  AND carries no `terminalKind` still relies on the regex; new/default boards are exact. */
export function classifyColumn(board: KanbanBoard, columnId: string): { isTerminal: boolean; isCancelled: boolean; isBlocked: boolean } {
  const col = board.columns.find((c) => c.id === columnId);
  const isTerminal = isTerminalColumn(board, columnId);
  const label = `${columnId} ${col?.name ?? ''}`;
  const isCancelled = isTerminal && (
    col?.terminalKind === 'cancellation' ? true
      : col?.terminalKind === 'completion' ? false
        : (columnId === 'wont-do' || CANCEL_RE.test(label))
  );
  return {
    isTerminal,
    isCancelled,
    isBlocked: columnId === 'blocked' || BLOCKED_RE.test(label),
  };
}

/** Validate an ISO date (`yyyy-mm-dd` or a full ISO timestamp). */
function asIsoDate(value: unknown, field: string): string {
  const s = cleanString(value, 40);
  if (!s || Number.isNaN(Date.parse(s))) {
    throw new OpenwopError('validation_error', `\`${field}\` MUST be an ISO date (e.g. 2026-06-30).`, 400, { field });
  }
  return s;
}

/** Set (or replace) an idea's target date (ADR 0103). `startDate` is optional. */
export async function setIdeaSchedule(
  tenantId: string,
  listId: string,
  cardId: string,
  setBy: string,
  body: Record<string, unknown>,
): Promise<IdeaSchedule> {
  const list = await getList(tenantId, listId);
  if (!list) throw new OpenwopError('not_found', 'Priority list not found.', 404, { listId });
  const card = await getCard(cardId);
  if (!card || card.boardId !== list.boardId) throw new OpenwopError('not_found', 'Idea not found in this list.', 404, { cardId });
  const targetDate = asIsoDate(body.targetDate, 'targetDate');
  const startDate = body.startDate !== undefined && body.startDate !== null && body.startDate !== '' ? asIsoDate(body.startDate, 'startDate') : undefined;
  const row: IdeaSchedule = { listId, cardId, targetDate, ...(startDate ? { startDate } : {}), setBy, updatedAt: nowIso() };
  await schedules.put(row);
  return row;
}

/** Clear an idea's schedule overlay (revert it to `unscheduled`). */
export async function clearIdeaSchedule(tenantId: string, listId: string, cardId: string): Promise<boolean> {
  const list = await getList(tenantId, listId);
  if (!list) throw new OpenwopError('not_found', 'Priority list not found.', 404, { listId });
  if (!(await schedules.get(`${listId}::${cardId}`))) return false;
  await schedules.delete(`${listId}::${cardId}`);
  return true;
}

/** One idea's derived schedule status (ADR 0103) — the card + its column + state. */
export interface IdeaScheduleStatus extends ScheduleStatus {
  cardId: string;
  title: string;
  status: string;
}

/**
 * Derive the schedule status of every idea in a list + a list rollup (ADR 0103).
 * `nowMs` is injected (defaults to the server clock) so the derivation stays pure
 * and testable; this is a LIVE read (never stamped into a replayable run). Cancelled
 * ("Won't Do") ideas are surfaced per-idea but excluded from the rollup counts.
 */
export async function getScheduleStatus(
  tenantId: string,
  listId: string,
  nowMs: number = Date.now(),
): Promise<{ ideas: IdeaScheduleStatus[]; rollup: ScheduleRollup }> {
  const list = await getList(tenantId, listId);
  if (!list) throw new OpenwopError('not_found', 'Priority list not found.', 404, { listId });
  const board = await listBoard(list);
  if (!board) return { ideas: [], rollup: rollupSchedule([]) };
  const cards = await listCards(board.id);
  const scheduleByCard = new Map((await schedules.listByPrefix(`${listId}::`)).map((s) => [s.cardId, s]));

  const ideas: IdeaScheduleStatus[] = [];
  const countedStates: ScheduleState[] = [];
  for (const card of cards) {
    const { isTerminal, isCancelled, isBlocked } = classifyColumn(board, card.columnId);
    const sched = scheduleByCard.get(card.id);
    const status = deriveScheduleStatus({
      ...(sched ? { targetDate: sched.targetDate } : {}),
      ...(card.completedAt ? { completedAt: card.completedAt } : {}),
      isTerminal, isCancelled, isBlocked, nowMs,
    });
    const columnName = board.columns.find((c) => c.id === card.columnId)?.name ?? card.columnId;
    ideas.push({ cardId: card.id, title: card.title, status: columnName, ...status });
    if (!isCancelled) countedStates.push(status.state);
  }
  return { ideas, rollup: rollupSchedule(countedStates) };
}

// ─── planning sessions + agenda ────────────────────────────────────────────────

const AGENDA_SORTS: readonly AgendaSort[] = ['priority', 'created', 'owner', 'status', 'title'];
const AGENDA_DEFAULT_DIR: Record<AgendaSort, 'asc' | 'desc'> = { priority: 'desc', created: 'asc', owner: 'asc', status: 'asc', title: 'asc' };

function parseSelection(body: Record<string, unknown>): SessionSelection {
  const mode = body.mode === 'manual' ? 'manual' : body.mode === 'both' ? 'both' : 'top-n';
  const n = typeof body.n === 'number' && body.n > 0 ? Math.min(Math.round(body.n), 100) : undefined;
  const cardIds = Array.isArray(body.cardIds) ? body.cardIds.filter((c): c is string => typeof c === 'string') : [];
  const sort = AGENDA_SORTS.includes(body.sort as AgendaSort) ? (body.sort as AgendaSort) : undefined;
  const sortDir = body.sortDir === 'asc' ? 'asc' : body.sortDir === 'desc' ? 'desc' : undefined;
  return { mode, ...(n !== undefined ? { n } : {}), cardIds, ...(sort ? { sort } : {}), ...(sortDir ? { sortDir } : {}) };
}

/** The comparable value an idea sorts on for a given agenda order. */
function agendaKey(r: RankedIdea, sort: AgendaSort): string | number {
  switch (sort) {
    case 'priority': return r.computedPriority;
    case 'created': return r.card.createdAt ?? '';
    case 'owner': return r.card.assigneeId ?? r.card.createdBy ?? '';
    case 'status': return r.status.columnName;
    case 'title': return r.card.title.toLowerCase();
  }
}

/** Order the agenda's selected ideas (ADR 0058 — the saved doc honors the chosen
 *  order, not only the live table). Default `priority` (rank order); ties break by
 *  in-list rank so the result is deterministic for replay/audit. */
function orderAgenda(selected: RankedIdea[], sort?: AgendaSort, dir?: 'asc' | 'desc'): RankedIdea[] {
  const s = sort ?? 'priority';
  const factor = (dir ?? AGENDA_DEFAULT_DIR[s]) === 'asc' ? 1 : -1;
  return [...selected].sort((a, b) => {
    const av = agendaKey(a, s); const bv = agendaKey(b, s);
    if (av < bv) return -1 * factor;
    if (av > bv) return 1 * factor;
    return a.rank - b.rank; // stable tiebreak
  });
}

/** Resolve the selection to the ordered ideas it picks (top-N by priority and/or
 *  the manually-chosen cards, de-duplicated, preserving rank order). */
function resolveSelected(ranked: RankedIdea[], selection: SessionSelection): RankedIdea[] {
  const picked = new Set<string>();
  if (selection.mode === 'top-n' || selection.mode === 'both') {
    for (const r of ranked.slice(0, selection.n ?? 5)) picked.add(r.card.id);
  }
  if (selection.mode === 'manual' || selection.mode === 'both') {
    for (const id of selection.cardIds) picked.add(id);
  }
  return ranked.filter((r) => picked.has(r.card.id));
}

/** Build the deterministic agenda markdown from the selected ideas. */
function buildAgendaMarkdown(list: PriorityList, sessionName: string, selected: RankedIdea[]): string {
  const lines: string[] = [];
  lines.push(`# ${sessionName}`);
  lines.push('');
  lines.push(`Planning session for **${list.name}** — ${selected.length} item${selected.length === 1 ? '' : 's'} to address.`);
  lines.push('');
  selected.forEach((r, i) => {
    lines.push(`## ${i + 1}. ${r.card.title}`);
    lines.push(`- **Priority score:** ${r.computedPriority} (rank #${r.rank})`);
    lines.push(`- **Status:** ${r.status.columnName}`);
    if (r.card.createdAt) lines.push(`- **Submitted:** ${r.card.createdAt.slice(0, 10)}`);
    if (r.card.description) lines.push(`- **Context:** ${r.card.description}`);
    const top = list.criteriaSet.criteria
      .map((c) => ({ name: c.name, score: r.scores[c.id] }))
      .filter((x) => typeof x.score === 'number')
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 3)
      .map((x) => `${x.name} ${x.score}/10`);
    if (top.length) lines.push(`- **Top factors:** ${top.join(' · ')}`);
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * Generate a planning session: select ideas, build the agenda, snapshot the
 * criteria. When the `documents` feature is enabled for this tenant, also persist
 * the agenda as a `board-agenda` document (ADR 0053 compose); otherwise the inline
 * `agendaMarkdown` is the artifact (graceful degrade — no hard dependency).
 */
export async function createPlanningSession(
  tenantId: string,
  listId: string,
  createdBy: string,
  body: Record<string, unknown>,
): Promise<PlanningSession> {
  const list = await getList(tenantId, listId);
  if (!list) throw new OpenwopError('not_found', 'Priority list not found.', 404, { listId });
  const name = cleanString(body.name, 160) || `${list.name} planning session`;
  const selection = parseSelection(body);
  const ranked = await listRankedIdeas(tenantId, listId);
  const selected = orderAgenda(resolveSelected(ranked, selection), selection.sort, selection.sortDir);
  if (selected.length === 0) {
    throw new OpenwopError('validation_error', 'The selection resolved to zero ideas — pick a top-N or specific ideas.', 400, {});
  }
  const agendaMarkdown = buildAgendaMarkdown(list, name, selected);

  // Compose Documents (ADR 0053) when enabled; degrade to inline markdown otherwise.
  let agendaDocumentId: string | undefined;
  const docsAssignment = await resolveOne('documents', { tenantId });
  if (docsAssignment?.enabled) {
    let createdDocId: string | undefined;
    try {
      const doc = await createDocument({
        tenantId,
        orgId: list.orgId,
        title: name,
        kind: 'board-agenda',
        format: 'markdown',
        provenance: { producedBy: { kind: 'user', id: createdBy } },
        createdBy,
      });
      createdDocId = doc.documentId;
      await addVersion(tenantId, list.orgId, doc.documentId, {
        content: agendaMarkdown,
        producedBy: { kind: 'user', id: createdBy },
      });
      agendaDocumentId = doc.documentId;
    } catch {
      // Documents compose is best-effort; the inline agenda is the floor. Roll back
      // a doc that was created before the version write failed, so we never leave an
      // orphan empty board-agenda behind.
      if (createdDocId) { try { await deleteDocument(tenantId, list.orgId, createdDocId); } catch { /* best-effort */ } }
      agendaDocumentId = undefined;
    }
  }

  const session: PlanningSession = {
    id: `psession-${randomUUID().slice(0, 12)}`,
    listId,
    tenantId,
    name,
    selection,
    criteriaSnapshot: { ...list.criteriaSet, criteria: list.criteriaSet.criteria.map((c) => ({ ...c })) },
    ...(agendaDocumentId ? { agendaDocumentId } : {}),
    agendaMarkdown,
    createdBy,
    createdAt: nowIso(),
  };
  await sessions.put(session);
  return session;
}

/** Re-order an EXISTING session's agenda in place (ADR 0058 — a reorder must not
 *  spawn a duplicate session). Keeps the immutable `criteriaSnapshot`, `name`, `id`,
 *  and `createdAt`; re-resolves the SAME selection in the new order, rebuilds the
 *  markdown, and appends a doc version when one is bound. */
export async function updatePlanningSession(
  tenantId: string,
  listId: string,
  sessionId: string,
  updatedBy: string,
  body: Record<string, unknown>,
): Promise<PlanningSession> {
  const list = await getList(tenantId, listId);
  if (!list) throw new OpenwopError('not_found', 'Priority list not found.', 404, { listId });
  const existing = await sessions.get(`${tenantId}::${sessionId}`);
  if (!existing || existing.listId !== listId) throw new OpenwopError('not_found', 'Planning session not found.', 404, { sessionId });

  const sort = AGENDA_SORTS.includes(body.sort as AgendaSort) ? (body.sort as AgendaSort) : existing.selection.sort;
  const sortDir = body.sortDir === 'asc' ? 'asc' : body.sortDir === 'desc' ? 'desc' : existing.selection.sortDir;
  const selection: SessionSelection = { ...existing.selection, ...(sort ? { sort } : {}), ...(sortDir ? { sortDir } : {}) };

  const ranked = await listRankedIdeas(tenantId, listId);
  const selected = orderAgenda(resolveSelected(ranked, selection), selection.sort, selection.sortDir);
  if (selected.length === 0) {
    throw new OpenwopError('validation_error', 'The selection resolved to zero ideas.', 400, {});
  }
  const agendaMarkdown = buildAgendaMarkdown(list, existing.name, selected);

  // Keep the bound board-agenda document in sync (best-effort; inline markdown is the floor).
  if (existing.agendaDocumentId) {
    try { await addVersion(tenantId, list.orgId, existing.agendaDocumentId, { content: agendaMarkdown, producedBy: { kind: 'user', id: updatedBy } }); }
    catch { /* best-effort */ }
  }

  const next: PlanningSession = { ...existing, selection, agendaMarkdown };
  await sessions.put(next);
  return next;
}

export async function listSessions(tenantId: string, listId: string): Promise<PlanningSession[]> {
  return (await sessions.listByPrefix(`${tenantId}::`))
    .filter((s) => s.tenantId === tenantId && s.listId === listId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Test-only: drop all priority-matrix stores. */
export async function __resetPriorityMatrixStore(): Promise<void> {
  await lists.__clear();
  await scores.__clear();
  await schedules.__clear();
  await votes.__clear();
  await sessions.__clear();
}
