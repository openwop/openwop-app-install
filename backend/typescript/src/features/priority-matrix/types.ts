/**
 * Priority Matrix (ADR 0058) — host-extension entity types.
 *
 * The feature owns ONLY what is new: named `PriorityList`s, their configurable
 * weighted `CriteriaSet`, the per-idea `IdeaScore` overlay, and `PlanningSession`s.
 * An "idea" is NOT a new entity — it is a `host.kanban` card on the list's board;
 * statuses are the board's free-form columns (terminal lanes = Won't Do / Done).
 * This is the no-parallel-architecture stance (ADR 0058 § Boundaries): reuse the
 * board/card/status primitive, store only the scoring + planning data here.
 *
 * @see docs/adr/0058-priority-matrix.md
 */

import type { KanbanColumn } from '../../host/kanbanService.js';

/** How an idea's per-criterion scores combine into one priority number. */
export type Aggregation = 'weighted-sum' | 'ratio';

/** Whether a higher 1–10 score is better (`benefit`) or worse (`cost`).
 *  Cost/effort/job-size criteria are `cost` — they drag priority DOWN. */
export type CriterionDirection = 'benefit' | 'cost';

/** A named framework a criteria set was seeded from (UX honesty: the slider model
 *  is Weighted Scoring; WSJF/RICE are ratio presets — ADR 0058 § Scoring model). */
export type PresetId = 'weighted' | 'wsjf' | 'rice' | 'ice' | 'value-effort';
export const PRESET_IDS: readonly PresetId[] = ['weighted', 'wsjf', 'rice', 'ice', 'value-effort'];

/** One weighted factor an idea is scored against. */
export interface Criterion {
  id: string;
  name: string;
  description?: string;
  /** The slider — relative importance, 1..10. */
  weight: number;
  direction: CriterionDirection;
  /** Anchor text for the 1..10 score input (reduces score-gaming, ADR 0058 UX). */
  scaleHint?: string;
}

/** The configurable, per-list weighted scoring model. */
export interface CriteriaSet {
  presetId?: PresetId;
  aggregation: Aggregation;
  criteria: Criterion[];
}

/** A named container of ideas. Workspace-scoped by default; a `projectId` scopes
 *  it to a project (the board's `ownerSubject`, ADR 0046). The ideas/statuses live
 *  on `boardId` (a real `host.kanban` board); this record owns the scoring model. */
export interface PriorityList {
  id: string;
  tenantId: string;
  orgId: string;
  /** Present ⇒ project-scoped (board ownerSubject = {kind:'project', id}). */
  projectId?: string;
  /** Creator-named — "Strategic Initiatives", "Priority Guidance", … */
  name: string;
  /** The provisioned `host.kanban` board (statuses = its columns). */
  boardId: string;
  criteriaSet: CriteriaSet;
  /** How ideas are scored (ADR 0059). `single` (default) = one shared `IdeaScore`
   *  per idea; `multi-voter` = one `IdeaVote` per member, aggregated for ranking. */
  votingMode: VotingMode;
  /** How per-criterion votes combine in `multi-voter` mode (ADR 0059). */
  voteAggregation: VoteAggregation;
  /** Optional per-voter weights for `multi-voter` aggregation (ADR 0059 weighted
   *  voters / Limited Weighted Votes): voterId → weight (1..10; default/absent = 1).
   *  Config-authority-set; an empty/uniform map means equal-weight (unchanged). */
  voterWeights?: Record<string, number>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Scoring mode for a list (ADR 0059). */
export type VotingMode = 'single' | 'multi-voter';
/** How per-criterion votes combine in multi-voter mode (ADR 0059). */
export type VoteAggregation = 'mean' | 'median';

/** The scoring overlay on one idea (= one kanban card) in `single` mode. Keyed by
 *  (list, card). */
export interface IdeaScore {
  listId: string;
  /** The kanban card id — the idea itself. */
  cardId: string;
  /** criterionId → 1..10. Missing criteria score as unset (treated as 0). */
  scores: Record<string, number>;
  /** Derived + cached weighted priority (recomputed on score/weight change). */
  computedPriority: number;
  updatedBy: string;
  updatedAt: string;
}

/** Optional schedule overlay on one idea (= one kanban card) — ADR 0103. Keyed by
 *  (list, card), exactly like `IdeaScore`; cascades on card/list delete. Absence ⇒
 *  the idea is `unscheduled`. Scoring and scheduling are deliberately ORTHOGONAL
 *  (a separate overlay): you can date an unscored idea and score an undated one. */
export interface IdeaSchedule {
  listId: string;
  /** The kanban card id — the idea itself. */
  cardId: string;
  /** ISO date the idea is meant to be done by (the date "behind schedule" is relative to). */
  targetDate: string;
  /** Optional ISO start date — context only (elapsed / % of window), not used for the state. */
  startDate?: string;
  setBy: string;
  updatedAt: string;
}

/** One member's vote on one idea (ADR 0059, `multi-voter` mode). Keyed by
 *  (list, card, voter). Aggregated across voters at rank time. */
export interface IdeaVote {
  listId: string;
  cardId: string;
  /** The voting member (userId), or `workflow` for a run-cast vote. */
  voterId: string;
  /** criterionId → 1..10 for THIS voter. */
  scores: Record<string, number>;
  updatedAt: string;
}

/** How a meeting agenda is ordered (ADR 0058 — the saved doc, not just the live
 *  table). `priority` (default) = rank order; the rest let a session group the
 *  agenda by date / submitter / status / title. */
export type AgendaSort = 'priority' | 'created' | 'owner' | 'status' | 'title';

/** How a planning session picks the ideas it turns into an agenda. */
export interface SessionSelection {
  mode: 'top-n' | 'manual' | 'both';
  n?: number;
  cardIds: string[];
  /** Order of the generated agenda (default `priority`). */
  sort?: AgendaSort;
  /** Sort direction; omitted ⇒ a sensible per-field default. */
  sortDir?: 'asc' | 'desc';
}

/** A planning session: a selection + the generated meeting agenda. The criteria
 *  are SNAPSHOT at generation so a later weight change never rewrites a session. */
export interface PlanningSession {
  id: string;
  listId: string;
  tenantId: string;
  name: string;
  selection: SessionSelection;
  /** Immutable snapshot of the scoring model at generation (replay/audit). */
  criteriaSnapshot: CriteriaSet;
  /** Set when the `documents` feature is enabled (ADR 0053 board-agenda doc). */
  agendaDocumentId?: string;
  /** Fallback agenda body when `documents` is OFF (no hard dependency). */
  agendaMarkdown: string;
  createdBy: string;
  createdAt: string;
}

/**
 * The default status set, mapped to `host.kanban` columns. Free-form + renameable
 * (kanban supports custom columns); Won't Do / Done are terminal lanes (ADR 0049).
 * Statuses are pure WORKFLOW-STATE (where in the pipeline); importance/urgency is a
 * SCORING criterion that drives computed priority, not a status — so `Urgent` is
 * deliberately NOT a status column (ADR 0058 open question, resolved 2026-06-16).
 * Existing boards keep whatever columns they were created with (this is the seed
 * for new lists only).
 */
export const DEFAULT_STATUS_COLUMNS: readonly KanbanColumn[] = [
  { id: 'new', name: 'New' },
  { id: 'under-review', name: 'Under Review' },
  { id: 'in-process', name: 'In Process' },
  { id: 'blocked', name: 'Blocked' },
  { id: 'deferred', name: 'Deferred' },
  { id: 'wont-do', name: "Won't Do", terminal: true, terminalKind: 'cancellation' },
  { id: 'done', name: 'Done', terminal: true, terminalKind: 'completion' },
];

/** Built-in criteria-set presets (framework-anchored defaults — ADR 0058). A
 *  preset seeds the criteria + sensible weights; an authorized user then tunes. */
export const CRITERIA_PRESETS: Record<PresetId, CriteriaSet> = {
  weighted: {
    presetId: 'weighted',
    aggregation: 'weighted-sum',
    criteria: [
      { id: 'strategic-alignment', name: 'Strategic alignment', weight: 8, direction: 'benefit', scaleHint: '1 = off-strategy · 10 = core to strategy' },
      { id: 'roi', name: 'Return on investment', weight: 7, direction: 'benefit', scaleHint: '1 = negligible · 10 = transformational return' },
      { id: 'urgency', name: 'Urgency', weight: 6, direction: 'benefit', scaleHint: '1 = no time pressure · 10 = must act now' },
      { id: 'compliance-risk', name: 'Compliance / legislative risk', weight: 7, direction: 'benefit', scaleHint: '1 = no exposure · 10 = mandated by law/policy' },
      { id: 'cost', name: 'Cost', weight: 5, direction: 'cost', scaleHint: '1 = cheap · 10 = very expensive (lowers priority)' },
    ],
  },
  wsjf: {
    presetId: 'wsjf',
    aggregation: 'ratio',
    criteria: [
      { id: 'user-business-value', name: 'User / business value', weight: 1, direction: 'benefit' },
      { id: 'time-criticality', name: 'Time criticality', weight: 1, direction: 'benefit' },
      { id: 'risk-reduction', name: 'Risk reduction / opportunity enablement', weight: 1, direction: 'benefit' },
      { id: 'job-size', name: 'Job size', weight: 1, direction: 'cost', scaleHint: 'Cost of Delay ÷ Job Size — bigger jobs score lower' },
    ],
  },
  rice: {
    presetId: 'rice',
    aggregation: 'ratio',
    criteria: [
      { id: 'reach', name: 'Reach', weight: 1, direction: 'benefit' },
      { id: 'impact', name: 'Impact', weight: 1, direction: 'benefit' },
      { id: 'confidence', name: 'Confidence', weight: 1, direction: 'benefit' },
      { id: 'effort', name: 'Effort', weight: 1, direction: 'cost', scaleHint: '(Reach × Impact × Confidence) ÷ Effort' },
    ],
  },
  ice: {
    presetId: 'ice',
    aggregation: 'weighted-sum',
    criteria: [
      { id: 'impact', name: 'Impact', weight: 1, direction: 'benefit' },
      { id: 'confidence', name: 'Confidence', weight: 1, direction: 'benefit' },
      { id: 'ease', name: 'Ease', weight: 1, direction: 'benefit' },
    ],
  },
  'value-effort': {
    presetId: 'value-effort',
    aggregation: 'ratio',
    criteria: [
      { id: 'value', name: 'Value', weight: 1, direction: 'benefit' },
      { id: 'effort', name: 'Effort', weight: 1, direction: 'cost', scaleHint: 'Value ÷ Effort (the 2×2 quadrant)' },
    ],
  },
};
