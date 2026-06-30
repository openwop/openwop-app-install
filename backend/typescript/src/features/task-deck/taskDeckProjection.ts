/**
 * ADR 0133 Phase 2 — the task-deck PROJECTION (a pure read-model over runs +
 * sub-runs). NO new store, no tasks table ([[no-parallel-architecture]]): a "task"
 * is a view of an existing run. Mirrors host/reviewProjection.ts (pure projector;
 * the route owns the fetch/auth) + host/artifactProjection.ts.
 *
 * The route (Phase 3) fetches + scopes the runs (storage.listRuns) and builds the
 * blocked map (storage.listOpenInterrupts), then calls this pure function. Safe to
 * recompute on every poll — idempotent, deterministic, no I/O, no clock.
 *
 * @see docs/adr/0133-run-task-deck.md
 */
import type { RunRecord, RunStatus } from '../../types.js';

export type TaskBucket = 'pending' | 'running' | 'blocked' | 'delegated' | 'completed' | 'failed';
export const TASK_BUCKETS: readonly TaskBucket[] = ['pending', 'running', 'blocked', 'delegated', 'completed', 'failed'];

/** The blocking interrupt for a run, enough to deep-link the resume affordance. */
export interface BlockedInfo {
  interruptId: string;
  nodeId: string;
  kind: string;
}

export interface TaskCard {
  runId: string;
  parentRunId?: string;
  delegatedBy?: string;
  title: string;
  status: TaskBucket;
  /** When blocked — the interrupt kind + the resume target (deep-link). */
  blockedReason?: string;
  resumeRef?: { runId: string; nodeId: string; interruptId: string };
  startedAt: string;
  updatedAt: string;
  /** Delegated sub-runs grouped under this task (when their parent is in scope). */
  children: TaskCard[];
}

export interface TaskDeck {
  buckets: Record<TaskBucket, TaskCard[]>;
}

/** A run is "blocked" when suspended awaiting input/approval/external/pause. The
 *  `satisfies` pin makes a future RunStatus a compile error here, not a silent miss. */
const BLOCKED_STATUSES = new Set<RunStatus>(['paused', 'waiting-approval', 'waiting-input', 'waiting-external']);

/** Map a run (+ whether it is a delegated child) to a deck bucket. Exhaustive over
 *  RunStatus; an unknown future status falls through to `running` (active) rather
 *  than vanishing. */
function bucketOf(status: RunStatus, isChild: boolean): TaskBucket {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (BLOCKED_STATUSES.has(status)) return 'blocked';
  if (status === 'pending') return isChild ? 'delegated' : 'pending';
  // 'running' (or any future active status) — a child is delegated work in progress.
  return isChild ? 'delegated' : 'running';
}

function parentOf(run: RunRecord): string | undefined {
  if (run.parentRunId) return run.parentRunId;
  const m = run.metadata?.['parentRunId'];
  return typeof m === 'string' ? m : undefined;
}

function titleOf(run: RunRecord): string {
  const t = run.metadata?.['title'];
  if (typeof t === 'string' && t.trim()) return t;
  return run.workflowId || run.runId;
}

function emptyBuckets(): Record<TaskBucket, TaskCard[]> {
  return { pending: [], running: [], blocked: [], delegated: [], completed: [], failed: [] };
}

/**
 * Build the task deck from a scoped set of runs + the open-interrupt map.
 * Children (a run whose parent is also in `runs`) nest under their parent's
 * `children[]` and are NOT also placed in a top-level bucket (no double-count); an
 * orphan child (parent out of scope) surfaces as a top-level `delegated` card.
 */
export function taskDeckProjection(
  runs: readonly RunRecord[],
  blockedByRunId: ReadonlyMap<string, BlockedInfo>,
): TaskDeck {
  const cards = new Map<string, TaskCard>();
  for (const run of runs) {
    const pid = parentOf(run);
    const delegatedBy = run.metadata?.['delegatedBy'];
    const blk = blockedByRunId.get(run.runId);
    cards.set(run.runId, {
      runId: run.runId,
      ...(pid ? { parentRunId: pid } : {}),
      ...(typeof delegatedBy === 'string' ? { delegatedBy } : {}),
      title: titleOf(run),
      status: bucketOf(run.status, !!pid),
      ...(blk ? { blockedReason: blk.kind, resumeRef: { runId: run.runId, nodeId: blk.nodeId, interruptId: blk.interruptId } } : {}),
      startedAt: run.createdAt,
      updatedAt: run.updatedAt,
      children: [],
    });
  }

  const topLevel: TaskCard[] = [];
  for (const card of cards.values()) {
    const parent = card.parentRunId ? cards.get(card.parentRunId) : undefined;
    if (parent) parent.children.push(card);
    else topLevel.push(card);
  }

  const newestFirst = (a: TaskCard, b: TaskCard): number => b.updatedAt.localeCompare(a.updatedAt);
  const buckets = emptyBuckets();
  for (const card of topLevel) buckets[card.status].push(card);
  for (const bucket of TASK_BUCKETS) buckets[bucket].sort(newestFirst);
  for (const card of cards.values()) card.children.sort(newestFirst);

  return { buckets };
}
