/**
 * The `strategy` feature-toggle id, EXPORTED (ADR 0676 D3).
 *
 * It was module-local in `routes.ts`, which is why the cadence lane could not gate its
 * scheduled jobs on it. It matters that this is the exported one: the only other exported
 * toggle constant in this feature is `STRATEGY_GATE_TOGGLE_ID = 'strategy-approval-gate'`
 * (`activationApproval.ts`), whose default is `status:'off'` — passing THAT as a job's
 * `featureId` would make `resolveOne` answer disabled for every tenant and silently stop
 * every strategy cadence job, with one `log.info` at `scheduleDaemon.ts:120`. Leg (b) of
 * `strategy-cadence-feature-gate.test.ts` exists to catch exactly that substitution.
 */
export const STRATEGY_TOGGLE_ID = 'strategy';

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
  /** ADR 0231 — typed measurement (progress derives from confirmed check-ins). */
  measure?: KrMeasure;
  /** ADR 0231 — contribution weight in the objective rollup (1–10, default 1). */
  weight?: number;
}

/** ADR 0231 §C3 — a standing, human-configured metric source. Setting it on a
 *  KR is the authorization that lets the sync chain write CONFIRMED check-ins
 *  for that KR; values are read via EXISTING surfaces only. */
export type MetricSourceKind = 'crm-deal-total' | 'analytics-conversions' | 'commerce-revenue' | 'bigquery';
export const METRIC_SOURCE_KINDS: readonly MetricSourceKind[] = ['crm-deal-total', 'analytics-conversions', 'commerce-revenue', 'bigquery'];
export interface MetricSource {
  kind: MetricSourceKind;
  /** The org whose data feeds this KR (the RBAC anchor for the read). */
  orgId: string;
  /** Source-specific selector (e.g. a BigQuery SQL string, an analytics event name). */
  query?: string;
}

export type KrMeasureKind = 'numeric' | 'percent' | 'currency' | 'boolean';
export const KR_MEASURE_KINDS: readonly KrMeasureKind[] = ['numeric', 'percent', 'currency', 'boolean'];
export type KrDirection = 'increase' | 'decrease';
export const KR_DIRECTIONS: readonly KrDirection[] = ['increase', 'decrease'];

/** ADR 0231 §C1 — typed measurement, ADDITIVE beside the legacy free-text
 *  `target`/`current` (no migration; unmeasured KRs stay valid). */
export interface KrMeasure {
  kind: KrMeasureKind;
  baseline?: number;
  target?: number;
  /** Which way is good. Default 'increase'. */
  direction?: KrDirection;
  unit?: string;
  source?: MetricSource;
}

export interface StrategyObjective {
  id: string;
  title: string;
  keyResults: StrategyKeyResult[];
  /** ADR 0231 — contribution weight in the strategy rollup (1–10, default 1). */
  weight?: number;
}

export interface StrategyInitiative {
  id: string;
  title: string;
  ownerUserId?: string;
  status?: StrategyStatus;
  linkedProjectIds?: string[];
  /** ADR 0234 §C6 — timeline plotting (strict YYYY-MM-DD). */
  startDate?: string;
  endDate?: string;
  /** Same-strategy initiative ids this one depends on (validated at write). */
  dependsOn?: string[];
  /** ADR 0235 §D2 — the investment/capacity FLOOR (plan-vs-actual sums roll
   *  into health signals at read; no cost plans / rate cards / FX — non-goals). */
  plan?: InitiativePlan;
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

/** ADR 0235 §D2 — a deliberately-modest plan block. Mixed-currency portfolios
 *  sum numerically with the first currency labeled (a floor, documented). */
export interface InitiativePlan {
  budgetAmount?: number;
  budgetCurrency?: string;
  capacityPoints?: number;
  actualAmount?: number;
  actualPoints?: number;
}

export interface StrategyPeriod {
  label: string;
  startDate?: string;
  endDate?: string;
}

/** The executive planning record (DurableCollection, keyed `${tenantId}::${id}`).
 *  ADR 0235 §D3 — `parentStrategyId` is a ONE-level grouping lens (a parent may
 *  not itself have a parent; same-org; validated at write; read-time grouping
 *  drops silently to ungrouped when the parent is archived/unreadable). */
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
  /** ADR 0235 §D3 — the one-level grouping lens. */
  parentStrategyId?: string;
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
  /** ADR 0231 — 0..1 weighted KR progress from confirmed check-ins; absent when unmeasured. */
  progress?: number;
  /** ADR 0231 — measured KRs with no confirmed check-in inside the staleness window. */
  staleKrCount?: number;
  measuredKrCount?: number;
  /** ADR 0231 — agent-proposed check-ins awaiting a human decision. */
  proposedCheckInCount?: number;
  /** ADR 0235 §D2 — read-time plan-vs-actual sums over initiatives with a plan
   *  block (absent when none carry one). */
  budgetPlanned?: number;
  budgetActual?: number;
  budgetCurrency?: string;
  /**
   * R2 STR2-M1 — the initiatives carrying a plan disagree on currency, so `budgetPlanned`
   * / `budgetActual` / `budgetCurrency` are WITHHELD: money in different currencies is
   * not additive, and the old first-wins label made the sum indistinguishable from a real
   * single-currency total on a row that reaches both the console and the analyst agent.
   * `budgetCurrencies` names which ones, so the reader knows what to ask.
   */
  budgetMixedCurrency?: boolean;
  budgetCurrencies?: string[];
  capacityPlanned?: number;
  capacityActual?: number;
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
  /** ADR 0235 §D3 — carried verbatim for FE grouping (ungrouped when the
   *  parent is archived/unreadable — the caller's concern, not stored). */
  parentStrategyId?: string;
}


/** A compact strategy reference projected into a consumer surface (chips). */
export interface StrategyRef {
  id: string;
  title: string;
  scope: StrategyScope;
  status: StrategyStatus;
  horizon: PlanningHorizon;
}
