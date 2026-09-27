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
import { getSyncSource, pruneStaleKnowledgeSyncClaims } from './knowledgeSyncService.js';
import { syncEnabledFor } from './knowledgeSyncGate.js';

const log = createLogger('knowledge-sync.surface');

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

      // Claim-table hygiene (the belt the retired daemon ran per tick; the pre-run
      // lease is the load-bearing recovery). Best-effort — never blocks the run.
      await pruneStaleKnowledgeSyncClaims({ storage: hostExtStorage() });

      // WF-KB-4 spend gate, at the spend site (defence-in-depth beyond the seam's
      // toggle gate — this half also covers plan entitlement). Fail-CLOSED skip.
      if (!(await syncEnabledFor(tenantId))) return { status: 'skipped', reason: 'feature-disabled' };

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
        const result = await syncNow({ storage: hostExtStorage() }, tenantId, sourceId, actingAt);
        return {
          status: 'success',
          ingested: result.ingested,
          pruned: result.pruned,
          unchanged: result.unchanged,
          failed: result.failed,
          ...(result.listingIncomplete ? { listingIncomplete: result.listingIncomplete } : {}),
        };
      } catch (err) {
        // `syncNow` throws 409 when another lane holds the lease (multi-instance) or
        // the source is revoked-paused — a benign no-op for a scheduled fire, not a
        // run failure. Everything else is a real failure `syncNow` already recorded
        // on the source (status/lastError); surface it as a typed failure.
        if (err instanceof OpenwopError && err.httpStatus === 409) {
          return { status: 'skipped', reason: 'in-flight-or-paused' };
        }
        const message = err instanceof Error ? err.message : String(err);
        log.warn('knowledge_sync_run_failed', { tenantId, sourceId, error: message });
        return { status: 'failure', error: { code: 'sync_failed', message } };
      }
    },
  };
}
