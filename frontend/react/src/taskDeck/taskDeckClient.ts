/**
 * ADR 0133 Phase 4 — client for the read-only task deck
 * (GET /v1/host/openwop-app/tasks). Backend is authority (toggle + ownership
 * filter there); a 404 means the task-deck feature is off.
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
  children: TaskCard[];
}

export interface TaskDeck {
  buckets: Record<TaskBucket, TaskCard[]>;
}

export async function getTaskDeck(conversationRunId?: string): Promise<TaskDeck> {
  const qs = conversationRunId ? `?conversationRunId=${encodeURIComponent(conversationRunId)}` : '';
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/tasks${qs}`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `getTaskDeck returned ${res.status}`);
  }
  return (await res.json() as { deck: TaskDeck }).deck;
}
