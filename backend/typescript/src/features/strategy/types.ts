/**
 * Strategy types (ADR 0079). An executive **strategy portfolio**: a declarative
 * planning record (narrative rationale + OKR-compatible objectives/key-results +
 * initiatives + horizon + governance fields) that LINKS existing host entities
 * (projects, priority lists/ideas, advisory boards, documents) — it never
 * duplicates their data.
 *
 * Not the `goals` feature: `goals` (RFC 0097) is judge-owned, execution-bounded
 * runtime work; Strategy is user-authored, never judge-verified, no run loop.
 *
 * Scope is a VISIBILITY MODIFIER over a MANDATORY `orgId` (ADR 0079 §Correction):
 * every strategy carries its owning org (the RBAC + IDOR anchor, exactly like
 * `PriorityList`/`Project`); `scope` narrows or widens read visibility on top.
 *
 * @see docs/adr/0079-strategic-planning.md
 */

/** The visibility modifier layered on org-keyed RBAC (ADR 0079 §Correction). */
export type StrategyScope = 'user' | 'workspace' | 'org';
export const STRATEGY_SCOPES: readonly StrategyScope[] = ['user', 'workspace', 'org'];

export type PlanningHorizon = 'quarter' | 'half-year' | 'annual' | 'multi-year' | 'custom';
export const PLANNING_HORIZONS: readonly PlanningHorizon[] = ['quarter', 'half-year', 'annual', 'multi-year', 'custom'];

export type StrategyStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';
export const STRATEGY_STATUSES: readonly StrategyStatus[] = ['draft', 'active', 'paused', 'completed', 'archived'];

export type StrategyConfidence = 'high' | 'medium' | 'low';
export const STRATEGY_CONFIDENCES: readonly StrategyConfidence[] = ['high', 'medium', 'low'];

export type StrategyRisk = 'low' | 'medium' | 'high';
export const STRATEGY_RISKS: readonly StrategyRisk[] = ['low', 'medium', 'high'];

export interface StrategyKeyResult {
  id: string;
  title: string;
  target?: string;
  current?: string;
  unit?: string;
  status?: StrategyStatus;
}

export interface StrategyObjective {
  id: string;
  title: string;
  keyResults: StrategyKeyResult[];
}

export interface StrategyInitiative {
  id: string;
  title: string;
  ownerUserId?: string;
  status?: StrategyStatus;
  linkedProjectIds?: string[];
}

/**
 * A canonical alignment edge. Edges point OUT at existing entities by id; they
 * never copy the target's data. Readability of the target is enforced at link
 * write-time (403 on an unreadable target) and again at context-projection time
 * (unreadable targets are silently omitted) — ADR 0079 RBAC §.
 */
export type StrategyLink =
  | { kind: 'project'; projectId: string }
  | { kind: 'priority-list'; listId: string }
  | { kind: 'priority-idea'; listId: string; cardId: string }
  | { kind: 'advisory-board'; boardId: string }
  | { kind: 'document'; documentId: string };

export const STRATEGY_LINK_KINDS = ['project', 'priority-list', 'priority-idea', 'advisory-board', 'document'] as const;
export type StrategyLinkKind = (typeof STRATEGY_LINK_KINDS)[number];

export interface StrategyPeriod {
  label: string;
  startDate?: string;
  endDate?: string;
}

/** The executive planning record (DurableCollection, keyed `${tenantId}::${id}`). */
export interface Strategy {
  id: string;
  tenantId: string;
  /** Owning org — ALWAYS present; the RBAC + IDOR anchor (ADR 0079 §Correction). */
  orgId: string;
  /** Visibility modifier over the org-keyed RBAC. */
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
  /** Manual health override (ADR 0080). When set it wins over the computed
   *  rollup; cleared (undefined) ⇒ the verdict reverts to "Auto" (derived). */
  healthOverride?: StrategyHealthState;
  objectives: StrategyObjective[];
  initiatives: StrategyInitiative[];
  links: StrategyLink[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ── Bounded-input caps (ADR 0079 — data-integrity; payloads can't grow unbounded) ──
export const STRATEGY_LIMITS = {
  title: 200,
  summary: 2000,
  rationale: 8000,
  label: 120,
  shortField: 200,
  ownerField: 200,
  maxObjectives: 50,
  maxKeyResults: 30,
  maxInitiatives: 50,
  maxLinks: 200,
  maxLinkedProjectIds: 50,
} as const;

// ── Health rollup (ADR 0080 Phase A) — a COMPUTED projection (with an optional
//    manual override stored on the strategy as `healthOverride`) ──
export type StrategyHealthState = 'on-track' | 'at-risk' | 'off-track';
export const STRATEGY_HEALTH_STATES: readonly StrategyHealthState[] = ['on-track', 'at-risk', 'off-track'];

/**
 * The component signals behind a health verdict — surfaced verbatim so the FE +
 * the Strategy Analyst show WHY (no invented precision; ADR 0080 Open Q1). Each
 * field reflects the strategy's RESOLVED, readable linked entities only.
 */
export interface StrategyHealthSignals {
  linkedProjectCount: number;
  projectsOnTrack: number;
  projectsAtRisk: number;
  projectsOffTrack: number;
  milestonesDone: number;
  milestonesTotal: number;
  linkedPriorityCount: number;
  objectiveCount: number;
  /** Objectives are declared but nothing executable is linked (no projects/priorities). */
  hasExecution: boolean;
}

export interface StrategyHealth {
  health: StrategyHealthState;
  signals: StrategyHealthSignals;
  /** True when `health` came from a manual override, not the computed verdict. */
  overridden?: boolean;
}

/** A compact, RBAC-bounded projection assembled at read/convene time — NEVER stored. */
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
  linkedProjects: Array<{ id: string; name: string; status?: string; health?: string; milestonesDone?: number; milestonesTotal?: number }>;
  linkedPriorities: Array<{ listId: string; cardId?: string; title: string; computedPriority?: number; rank?: number }>;
  /** Live-computed health rollup over the resolved linked entities (ADR 0080). */
  health?: StrategyHealth;
}

/** A per-strategy health row for the portfolio (`GET /strategy/health`). */
export interface StrategyHealthRow {
  id: string;
  title: string;
  health: StrategyHealthState;
  signals?: StrategyHealthSignals;
}

export interface StrategyContextPacket {
  strategies: StrategyContextEntry[];
}

/** A compact strategy reference projected into a consumer surface (chips). */
export interface StrategyRef {
  id: string;
  title: string;
  scope: StrategyScope;
  status: StrategyStatus;
  horizon: PlanningHorizon;
}
