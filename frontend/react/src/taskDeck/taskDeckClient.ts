/**
 * ADR 0133 Phase 4 + ADR 0902 — client for the read-only task deck
 * (GET /host/openwop-app/tasks). Backend is authority: `runs:read`, the
 * canonical run owner and the host-written delegation tree are decided there.
 * The feature is always-on (ADR 0134), so any non-2xx is a real failure.
 */
import { authedHeaders, config, fetchOpts } from '../client/config.js';

export type TaskBucket = 'pending' | 'running' | 'blocked' | 'delegated' | 'completed' | 'failed';
export const TASK_BUCKETS: readonly TaskBucket[] = ['pending', 'running', 'blocked', 'delegated', 'completed', 'failed'];

export interface TaskCard {
  runId: string;
  parentRunId?: string;
  delegatedBy?: string;
  title: string;
  status: TaskBucket;
  blockedReason?: string;
  resumeRef?: { runId: string; nodeId: string; interruptId: string };
  startedAt: string;
  updatedAt: string;
  /** A `failed`-bucket card whose run was cancelled (TD2UX-9). */
  cancelled?: true;
  /** The chat session this run belongs to (opens via `/chat?conversation=`). */
  conversationId?: string;
  children: TaskCard[];
}

export interface TaskDeck {
  buckets: Record<TaskBucket, TaskCard[]>;
  /** Top-level cards per bucket before the server's per-bucket card cap.
   *  Optional: a backend older than ADR 0902 omits it (deploy skew). */
  counts?: Record<TaskBucket, number>;
  /** The server's scan stopped before the tenant's oldest run (ADR 0902 D6). */
  truncated?: boolean;
}

/** A bucket's true size — the server count when present, else the listed cards. */
export function bucketCount(deck: TaskDeck, bucket: TaskBucket): number {
  return deck.counts?.[bucket] ?? deck.buckets[bucket]?.length ?? 0;
}

/** Whether the deck still has work that changes on its own (worth re-polling).
 *  Not `blocked` (TD2CD-3): a run paused for weeks would keep every open deck
 *  polling forever; a blocker moves when a person acts, and Refresh is there. */
export function hasActiveWork(deck: TaskDeck): boolean {
  return (['pending', 'running', 'delegated'] as const).some((b) => bucketCount(deck, b) > 0);
}

export async function getTaskDeck(conversationRunId?: string): Promise<TaskDeck> {
  const qs = conversationRunId ? `?conversationRunId=${encodeURIComponent(conversationRunId)}` : '';
  const res = await fetch(`${config.baseUrl}/host/openwop-app/tasks${qs}`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `getTaskDeck returned ${res.status}`);
  }
  return (await res.json() as { deck: TaskDeck }).deck;
}
