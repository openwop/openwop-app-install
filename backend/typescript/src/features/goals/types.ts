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

/** The immutable evidence a judge evaluates (ADR 0412 decided contract): an
 *  OPAQUE snapshot ref + content hash. The consumer (e.g. KickTodo's
 *  `kicktodo.progress-evidence`) owns the snapshot schema; goals stores the
 *  ref+hash on the verdict path for replay and never dereferences it. */
export interface GoalEvidence {
  snapshotRef: string;
  snapshotHash: string;
}

/** The judge's verdict — exactly the wire `completion.lastVerdict` shape. */
export interface GoalVerdict {
  satisfied: boolean;
  confidence: number;
  runId: string;
}

/**
 * Host-private sidecar state on the STORED row (ADR 0412 correction note: the
 * wire `goal.schema.json` is `additionalProperties: false` at every level, so
 * the ADR's "already declares these optional" assumption was wrong — extended
 * state rides here and is STRIPPED by `toWireGoal()` before any wire/tool/
 * surface output).
 */
export interface GoalHostState {
  /** Evidence of the most recent judge evaluation (idempotency + replay key). */
  lastEvidence?: GoalEvidence & { at: string };
  /** RFC 0058 accumulated spend across contributing runs (ADR 0412 P2) —
   *  checked against `bounds.maxCostUsd`. Wire-strict, so sidecar-only. */
  accumulatedCostUsd?: number;
  /** ADR 0412 P4 — the deterministic scheduler job this goal's `schedule`
   *  continuation is armed through (`goal:<tenant>:<goalId>:continuation`).
   *  Pause/resume toggle that job; terminal transitions disable it. */
  armedJobRef?: string;
}

/** The stored row: the wire Goal plus host-private sidecar state. */
export interface GoalRow extends Goal {
  host?: GoalHostState;
}

/** Project a stored row to the exact wire Goal (drops host-private state). */
export function toWireGoal(row: GoalRow): Goal {
  const { host: _host, ...wire } = row;
  return wire;
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
