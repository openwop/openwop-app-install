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
  /** TD2UX-9 — a `failed`-bucket card whose run was CANCELLED, not failed. */
  cancelled?: true;
  /** When blocked — the interrupt kind + the resume target (deep-link). */
  blockedReason?: string;
  resumeRef?: { runId: string; nodeId: string; interruptId: string };
  startedAt: string;
  updatedAt: string;
  /** ADR 0902 D7 — the chat session this run belongs to (`metadata.chatSessionId`,
   *  the id `/chat?conversation=` opens), when it is a chat run. */
  conversationId?: string;
  /** Delegated sub-runs grouped under this task (when their parent is in scope). */
  children: TaskCard[];
}

/** ADR 0902 D6 — each bucket lists at most this many top-level cards, newest first. */
export const BUCKET_CARD_CAP = 50;

export interface TaskDeck {
  buckets: Record<TaskBucket, TaskCard[]>;
  /** Top-level cards per bucket BEFORE the card cap (D6). */
  counts: Record<TaskBucket, number>;
  /** The scan stopped before the tenant's oldest run, so older owned runs may
   *  be missing (D6). Set by the route; the pure projection never knows. */
  truncated: boolean;
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

/**
 * ADR 0902 D2/D3 — the parent this run was DELEGATED from, or none. The
 * `parent_run_id` column counts only when the run is not a fork (`:fork` sets the
 * column too, with `forkMode`: a fork is its owner's own task, never delegated
 * work). Else the dispatcher's `metadata.parentRunId`, which `POST /runs` admits
 * only from the wildcard service principal.
 */
export function linkedParentOf(run: RunRecord): string | undefined {
  if (run.forkMode !== undefined && run.forkMode !== null) return undefined;
  if (run.parentRunId) return run.parentRunId;
  const m = run.metadata?.['parentRunId'];
  return typeof m === 'string' && m.length > 0 ? m : undefined;
}

function titleOf(run: RunRecord, workflowNames: ReadonlyMap<string, string>): string {
  const t = run.metadata?.['title'];
  if (typeof t === 'string' && t.trim()) return t;
  // TD2UX-3 — the workflow's display name (`definition.metadata.name`), resolved
  // by the route for the cards it shows; the raw id only when there is none.
  return workflowNames.get(run.workflowId) || run.workflowId || run.runId;
}

export function emptyBuckets(): Record<TaskBucket, TaskCard[]> {
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
  workflowNames: ReadonlyMap<string, string> = new Map(),
): TaskDeck {
  const cards = new Map<string, TaskCard>();
  for (const run of runs) {
    const pid = linkedParentOf(run);
    const delegatedBy = run.metadata?.['delegatedBy'];
    const chatSessionId = run.metadata?.['chatSessionId'];
    const blk = blockedByRunId.get(run.runId);
    cards.set(run.runId, {
      runId: run.runId,
      ...(pid ? { parentRunId: pid } : {}),
      ...(typeof delegatedBy === 'string' ? { delegatedBy } : {}),
      title: titleOf(run, workflowNames),
      status: bucketOf(run.status, !!pid),
      ...(run.status === 'cancelled' ? { cancelled: true as const } : {}),
      ...(blk ? { blockedReason: blk.kind, resumeRef: { runId: run.runId, nodeId: blk.nodeId, interruptId: blk.interruptId } } : {}),
      startedAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(typeof chatSessionId === 'string' && chatSessionId.length > 0 ? { conversationId: chatSessionId } : {}),
      children: [],
    });
  }

  // TD2CD-4 — nest a card only when its parent chain reaches a root: a linkage
  // cycle (no host path writes one, but metadata is data) would otherwise make
  // the cards contain each other and the response unserialisable. A card on a
  // cycle is shown top-level instead.
  const reachesRoot = (card: TaskCard): boolean => {
    const seen = new Set<string>([card.runId]);
    for (let p = card.parentRunId ? cards.get(card.parentRunId) : undefined; p; p = p.parentRunId ? cards.get(p.parentRunId) : undefined) {
      if (seen.has(p.runId)) return false;
      seen.add(p.runId);
    }
    return true;
  };
  const topLevel: TaskCard[] = [];
  for (const card of cards.values()) {
    const parent = card.parentRunId ? cards.get(card.parentRunId) : undefined;
    if (parent && reachesRoot(card)) parent.children.push(card);
    else topLevel.push(card);
  }

  const newestFirst = (a: TaskCard, b: TaskCard): number => b.updatedAt.localeCompare(a.updatedAt);
  const buckets = emptyBuckets();
  for (const card of topLevel) buckets[card.status].push(card);
  const counts = {} as Record<TaskBucket, number>;
  for (const bucket of TASK_BUCKETS) {
    buckets[bucket].sort(newestFirst);
    counts[bucket] = buckets[bucket].length;
    buckets[bucket] = buckets[bucket].slice(0, BUCKET_CARD_CAP);
  }
  for (const card of cards.values()) card.children.sort(newestFirst);

  return { buckets, counts, truncated: false };
}
