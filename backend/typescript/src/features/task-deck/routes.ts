/**
 * ADR 0133 Phase 3 — task-deck read route (authed, host-extension).
 *
 *   GET /v1/host/openwop-app/tasks?conversationRunId=<optional>
 *
 * A read-only projection over the caller's runs + their delegated sub-runs. RBAC is
 * the run-resource model (ownership IS the authz; no org scope): the `task-deck`
 * toggle gate + an ownership filter — the caller sees only runs they own
 * (`metadata.actingUserId`) plus the direct children of those runs (delegated
 * sub-runs run under the internal service principal, so they are reached via the
 * ADR 0133 Phase-1 `parentRunId` linkage, never by actingUserId). Tenant-scoped via
 * `listRuns({tenantId})`; an unauthenticated caller gets an empty deck.
 *
 * @see docs/adr/0133-run-task-deck.md
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import type { Storage } from '../../storage/storage.js';
import type { RunRecord } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { tenantOf } from '../featureRoute.js';
import { taskDeckProjection, type BlockedInfo, type TaskDeck } from './taskDeckProjection.js';

const RUN_SCAN_LIMIT = 500; // bound the per-request fetch; truncation is logged, never silent
const BLOCKED_STATUSES = new Set(['paused', 'waiting-approval', 'waiting-input', 'waiting-external']);
const log = createLogger('feature.task-deck');

function actingUserOf(req: Request): string | undefined {
  return req.userId ?? req.principal?.principalId;
}

function parentOf(run: RunRecord): string | undefined {
  if (run.parentRunId) return run.parentRunId;
  const m = run.metadata?.['parentRunId'];
  return typeof m === 'string' ? m : undefined;
}

/** Build the blocked-interrupt map for the runs that are in a blocked status. */
async function blockedMap(storage: Storage, runs: readonly RunRecord[]): Promise<Map<string, BlockedInfo>> {
  const out = new Map<string, BlockedInfo>();
  await Promise.all(runs
    .filter((r) => BLOCKED_STATUSES.has(r.status))
    .map(async (r) => {
      const open = await storage.listOpenInterrupts(r.runId);
      const first = open[0];
      if (first) out.set(r.runId, { interruptId: first.interruptId, nodeId: first.nodeId, kind: first.kind });
    }));
  return out;
}

export function registerTaskDeckRoutes(deps: RouteDeps): void {
  const { app, storage } = deps;

  app.get('/v1/host/openwop-app/tasks', async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const userId = actingUserOf(req);
      const emptyDeck: TaskDeck = { buckets: { pending: [], running: [], blocked: [], delegated: [], completed: [], failed: [] } };
      if (!userId) { res.json({ deck: emptyDeck }); return; } // anon → nothing owned

      // Fetch (bounded), newest-first BEFORE the cap so truncation drops the oldest,
      // not arbitrary rows. Log a truncation so a bounded view is never silent.
      const all = [...await storage.listRuns({ tenantId, limit: RUN_SCAN_LIMIT * 2 })]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const runs = all.slice(0, RUN_SCAN_LIMIT);
      if (all.length > RUN_SCAN_LIMIT) {
        log.info('task_deck_runs_truncated', { tenantId, total: all.length, shown: RUN_SCAN_LIMIT });
      }

      // Ownership filter (IDOR): the caller's own runs + the direct children of those.
      const ownedRunIds = new Set(runs.filter((r) => r.metadata?.['actingUserId'] === userId).map((r) => r.runId));
      let inScope = runs.filter((r) => ownedRunIds.has(r.runId) || (parentOf(r) !== undefined && ownedRunIds.has(parentOf(r)!)));

      // Optional narrowing to one conversation/parent run + its children. Only takes
      // effect within the already-owned set, so it cannot widen access.
      const conversationRunId = typeof req.query.conversationRunId === 'string' ? req.query.conversationRunId : undefined;
      if (conversationRunId) {
        inScope = inScope.filter((r) => r.runId === conversationRunId || parentOf(r) === conversationRunId);
      }

      const deck = taskDeckProjection(inScope, await blockedMap(storage, inScope));
      res.json({ deck });
    } catch (err) { next(err); }
  });
}
