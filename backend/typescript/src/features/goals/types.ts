/**
 * Standing goals (RFC 0097) — host-sample types.
 *
 * Wire shape mirrors `spec/v1/goal.schema.json` (Active since PR #698). A goal is
 * a standing objective whose completion is the JUDGE's verdict, never a client
 * write (`goal-completion-judge-only`), and whose continuation is bounded
 * (RFC 0058 `bounds`, `goal-continuation-bounded`).
 */

/** RFC 0097 §B — lifecycle states. `satisfied`/`escalated`/`bound-exceeded` are
 *  terminal verdicts owned by the judge / bounds enforcer, never the client. */
export type GoalState = 'active' | 'satisfied' | 'escalated' | 'abandoned' | 'bound-exceeded';

/** Completion judge. This host advertises + honors `verifier`. */
export type GoalJudge = 'verifier' | 'host';

/** Continuation modes this host honors (heartbeat omitted — no goal-retrigger beat). */
export type ContinuationMode = 'schedule' | 'commitment' | 'heartbeat' | 'manual';

export interface GoalCompletion {
  check: GoalJudge;
  verifierRef?: string;
  lastVerdict?: { satisfied: boolean; confidence: number; runId: string };
}

export interface GoalContinuation {
  mode: ContinuationMode;
  armRef?: string;
}

/** RFC 0058 execution bounds (inlined per the floor). At least one MUST be set. */
export interface GoalBounds {
  maxLoopIterations?: number;
  runTimeoutMs?: number;
  maxCostUsd?: number;
}

export interface GoalOwner {
  tenant: string;
  workspace?: string;
  principal?: string;
}

export interface Goal {
  id: string;
  objective: string;
  state: GoalState;
  completion: GoalCompletion;
  continuation: GoalContinuation;
  bounds: GoalBounds;
  progress?: { iterations: number; contributingRunIds: string[] };
  owner: GoalOwner;
  createdAt: string;
  updatedAt?: string;
}

/** A non-empty bounds object — at least one RFC 0058 dimension present. */
export function hasBounds(b: unknown): b is GoalBounds {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.maxLoopIterations === 'number' ||
    typeof o.runTimeoutMs === 'number' ||
    typeof o.maxCostUsd === 'number'
  );
}
