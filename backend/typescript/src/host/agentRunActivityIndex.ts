/**
 * Writer for the append-only agent-attributed-run index (RFC 0086).
 *
 * Called once, right after a run carrying agent attribution is inserted (the
 * shared run-starter for schedule/heartbeat/approval, plus the Kanban card→run
 * path). Extracts the single attribution block from the run's metadata and
 * records (runId → rosterId/agentId/source). The index is immutable — live run
 * status is joined from the runs table at query time — so there is nothing to
 * update when the run later completes/fails.
 *
 * Best-effort: a write failure is logged but never propagated, so the index can
 * never break run dispatch. A run that misses the index simply won't appear in
 * indexed activity queries (degraded visibility, not a broken run).
 *
 * @see src/storage/storage.ts — recordAgentRunAttribution / listAgentRunActivity
 * @see src/host/agentActivity.ts — the projection these runs feed
 */

import type { Storage, AgentRunAttributionRow } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('agentRunActivityIndex');

const ATTRIBUTION_KEYS = ['heartbeat', 'schedule', 'kanban', 'approval'] as const;

interface AttributedRun {
  runId: string;
  tenantId: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

/** The agent a run is attributed to. `rosterId` is always present; `agentId`
 *  (the manifest/profile id) is present for most but not all sources. */
export interface RunAttribution {
  source: (typeof ATTRIBUTION_KEYS)[number];
  rosterId: string;
  agentId?: string;
}

/**
 * Find a run's agent-attribution block + its ids, if any. THE single source of
 * the heartbeat/schedule/kanban/approval attribution-block convention — reused
 * by the activity index AND by ADR 0099's run-insert seam (per-agent compaction)
 * so the convention can't drift between two readers. Returns undefined for runs
 * with no attribution (or a block missing `rosterId`).
 */
export function extractRunAttribution(
  metadata: Record<string, unknown> | null | undefined,
): RunAttribution | undefined {
  const md = (metadata ?? {}) as Record<string, unknown>;
  for (const source of ATTRIBUTION_KEYS) {
    const block = md[source];
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (typeof b.rosterId !== 'string') return undefined; // attributed block but no member
    return { source, rosterId: b.rosterId, ...(typeof b.agentId === 'string' ? { agentId: b.agentId } : {}) };
  }
  return undefined;
}

/** Record a run's agent attribution in the index, if it carries one. No-op for
 *  runs with no heartbeat/schedule/kanban/approval block. */
export async function recordRunAttribution(storage: Storage, run: AttributedRun): Promise<void> {
  const attribution = extractRunAttribution(run.metadata);
  if (!attribution) return;
  const row: AgentRunAttributionRow = {
    runId: run.runId,
    tenantId: run.tenantId,
    rosterId: attribution.rosterId,
    source: attribution.source,
    createdAt: run.createdAt,
    ...(attribution.agentId ? { agentId: attribution.agentId } : {}),
  };
  try {
    await storage.recordAgentRunAttribution(row);
  } catch (err) {
    log.warn('agent run attribution index write failed', {
      runId: run.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
