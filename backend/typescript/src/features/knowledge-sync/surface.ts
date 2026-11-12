/**
 * Knowledge-sync workflow surface (WF-KB-3 / KSWF-1) — `ctx.features.knowledgeSync`.
 *
 * The ONE verb the `knowledge-sync.run` node calls. It wraps `syncNow` — the whole
 * ADR 0605-hardened orchestration (pre-run lease, per-source claim, destructive-diff
 * refusal, Tier-2 erasure, subject-scoped prune) — behind the WF-KB-4 spend gate, so
 * the recurring sync becomes a real registered/owned/replayable workflow run
 * dispatched by the ONE host scheduler instead of a bespoke daemon.
 *
 * The feature-surface seam (`host/featureSurfaces.ts`) already throws
 * `host_capability_disabled` for a toggled-OFF tenant on every method (the node
 * converts that into a clean skip), and records this `role:"action"` node's output
 * so replay/`:fork` never re-issues the egress. This verb adds the entitlement half
 * of the WF-KB-4 gate + the backoff suppression the deleted daemon's `isSyncDue`
 * used to do before dispatch — all as TYPED SKIPS, never egress on a skip.
 */

import type { FeatureSurface } from '../../host/featureSurfaces.js';
import { surfaceStr } from '../../host/featureSurfaces.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { syncNow } from './knowledgeSyncRunner.js';
import { getSyncSource, pruneStaleKnowledgeSyncClaims, knowledgeSyncWorkflowId } from './knowledgeSyncService.js';
import { syncEnabledFor } from './knowledgeSyncGate.js';

const log = createLogger('knowledge-sync.surface');

/** The `syncNow` refusals that are a benign no-op for a scheduled fire (ADR 1101
 *  D1) — matched on `details.reason`, never on the status code alone: the broker's
 *  `credential_required` is ALSO a 409, and it is a real failure. */
const BENIGN_SKIPS: Readonly<Record<string, string>> = {
  in_flight: 'in-flight',
  paused_revoked: 'status-paused',
  removing: 'status-paused',
  creator_no_access: 'creator-no-access',
  creator_erased: 'creator-erased',
};

export function buildKnowledgeSyncSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /**
     * Run one scheduled sync pass for `sourceId`. Fail-CLOSED gated on the tenant's
     * entitlement (the toggle half is enforced by the surface seam); backoff-aware;
     * the lease/claim + the pass itself live in `syncNow`. Returns a TYPED result —
     * a `skipped` never touches third-party egress or embedding.
     */
    runOnce: async (args) => {
      const sourceId = surfaceStr(args.sourceId);
      if (!sourceId) throw new OpenwopError('validation_error', 'sourceId is required.', 400, { field: 'sourceId' });
      const actingAt = surfaceStr(args.actingAt) || new Date().toISOString();

      // ADR 1101 D3 (`KS2WF-4`) — STRUCTURAL GATE, the `kb.reindex` shape
      // (`features/kb/surface.ts` `assertReindexWorkflow`). This verb runs a real pass
      // — egress, embedding spend, DELETIONS — on a source of ANY org in the tenant,
      // and it takes a row id, so the ADR 0832 seam floor cannot see the org. It is
      // therefore callable only (a) from the host-minted workflow for THIS source and
      // (b) by a run with no acting user: the scheduler. A builder run, a `/`-picker
      // run, a gallery copy or a re-executing `:fork` carries a person or the wrong id
      // and is refused; "Sync now" (`workspace:write` on the source's org) is the one
      // person lane. The refusal names neither the expected id nor the source. The
      // scheduler's own "Run now" fires actorless — its door is narrowed by
      // `knowledgeSyncJobReadable` instead.
      // `orgScopeSubject` too (grade-code #5): an actorless run a PERSON caused (a
      // channel post, a kanban dispatch) is not the scheduler either.
      if (scope.workflowId !== knowledgeSyncWorkflowId(sourceId) || scope.actingUserId || scope.orgScopeSubject) {
        return {
          status: 'failure',
          error: { code: 'forbidden', message: 'This verb runs only inside the scheduled workflow a knowledge-sync source registers. Use "Sync now" on the collection to run a pass.' },
        };
      }

      // WF-KB-4 spend gate, at the spend site (defence-in-depth beyond the seam's
      // toggle gate — this half also covers plan entitlement). Fail-CLOSED skip.
      if (!(await syncEnabledFor(tenantId))) return { status: 'skipped', reason: 'feature-disabled' };

      // Claim-table hygiene (the belt the retired daemon ran per tick; the pre-run
      // lease is the load-bearing recovery). Best-effort — never blocks the run.
      // ADR 1101 D9 (`KS2CD-5`) — behind the spend gate: a disabled tenant writes nothing.
      await pruneStaleKnowledgeSyncClaims({ storage: hostExtStorage() });

      const source = await getSyncSource(tenantId, sourceId);
      if (!source) return { status: 'skipped', reason: 'not-found' };
      if (source.status !== 'active') return { status: 'skipped', reason: `status-${source.status}` };

      // Backoff (ADR 0605 Tier 5 / KSWF-2) — a failed source stays `active` but is
      // not due yet. The cron fires on cadence; a run must still honour the retry
      // delay the daemon's `isSyncDue` enforced before dispatch, or a broken source
      // is hammered every tick. An unparseable stamp is ignored (never a wedge).
      const now = Date.parse(actingAt) || Date.now();
      if (source.nextAttemptAt) {
        const next = Date.parse(source.nextAttemptAt);
        if (Number.isFinite(next) && now < next) return { status: 'skipped', reason: 'backoff' };
      }

      try {
        const result = await syncNow({ storage: hostExtStorage() }, tenantId, sourceId, actingAt, scope.runId ? { runId: scope.runId } : {});
        return {
          status: 'success',
          ingested: result.ingested,
          pruned: result.pruned,
          unchanged: result.unchanged,
          failed: result.failed,
          ...(result.listingIncomplete ? { listingIncomplete: result.listingIncomplete } : {}),
        };
      } catch (err) {
        // `syncNow` throws a NAMED 409 when another lane holds the lease, the source
        // is revoked-paused or being removed, or the pass was refused and the source
        // paused (D3) — a benign no-op for a scheduled fire, not a run failure.
        // Everything else is a real failure `syncNow` already recorded on the source
        // (status/lastError/lastErrorCode); surface it as a typed failure.
        const reason = err instanceof OpenwopError && err.httpStatus === 409 && typeof err.details?.reason === 'string'
          ? BENIGN_SKIPS[err.details.reason] : undefined;
        if (reason) return { status: 'skipped', reason };
        const message = err instanceof Error ? err.message : String(err);
        // A bookkeeping write that lost every swap is NOT a failed sync (grade-code #7):
        // say what it was, so the run history does not report a pass that ran as failed.
        const code = err instanceof OpenwopError && err.details?.reason === 'write_contention' ? 'write_contention' : 'sync_failed';
        log.warn('knowledge_sync_run_failed', { tenantId, sourceId, error: message, code });
        return { status: 'failure', error: { code, message } };
      }
    },
  };
}
