/**
 * Destination-sync workflow surface (ADR 0266 / CDP-D) — `ctx.features['destination-sync']`.
 * Exposes the pure CDC+field-map `prepare` verb so a workflow can produce the
 * destination payloads and then EGRESS them through the existing SSRF-guarded
 * `core.openwop.http.fetch` node (ADR 0262 ruling #3 — no bespoke egress). Advances
 * the watermark as a side effect so a re-run sends only changed records.
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import type { FeatureSurface } from '../../host/featureSurfaces.js';
import { getDestinationSync, prepareSyncBatch, advanceCursor, buildOnwardEnvelopes, purposePropagationEnabled } from './destinationSyncService.js';
import { warehouseLoad, warehouseLoadDeps } from './warehouseLoadService.js';

export function buildDestinationSyncSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const runScope = {
    tenantId,
    ...(scope.runId ? { runId: scope.runId } : {}),
    ...(scope.actingUserId ? { actingUserId: scope.actingUserId } : {}),
  };
  return {
    /** prepare({ syncId, records }) → { payloads, nextCursor, count }. Does NOT advance
     *  the cursor — the workflow egresses `payloads`, then calls `advance` with
     *  `nextCursor` (advancing before egress would drop records on failure). */
    prepare: async (args) => {
      const syncId = typeof args.syncId === 'string' ? args.syncId : '';
      const records = Array.isArray(args.records) ? (args.records as Record<string, unknown>[]) : [];
      const sync = await getDestinationSync(tenantId, syncId);
      if (!sync) return { error: 'sync_not_found', payloads: [], count: 0 };
      const batch = prepareSyncBatch(sync, records);
      return { payloads: batch.payloads, count: batch.count, ...(batch.nextCursor !== undefined ? { nextCursor: batch.nextCursor } : {}) };
    },
    /**
     * ADR 0289 / RFC 0128 §3 — prepare the OpenWOP envelopes an `openwop-host` sync forwards
     * to a peer host's trigger-bridge ingest, each carrying the re-emitted `permittedPurposes`
     * (⊆ received, never-widening; `[]` fail-closed dropped). The workflow then egresses each
     * envelope through the sanctioned `core.openwop.http.fetch` node to `peerIngestUrl`
     * (auth via `connectionId`) — no bespoke egress (ADR 0262 ruling #3) — then calls `advance`.
     * Flag-gated: honest-off until RFC 0128 is witnessed (the advert/onward promise stays dark).
     */
    prepareOnward: async (args) => {
      if (!purposePropagationEnabled()) return { error: 'purpose_propagation_disabled', envelopes: [], count: 0 };
      const syncId = typeof args.syncId === 'string' ? args.syncId : '';
      const records = Array.isArray(args.records) ? (args.records as Record<string, unknown>[]) : [];
      const dedupField = typeof args.dedupField === 'string' ? args.dedupField : undefined;
      const sync = await getDestinationSync(tenantId, syncId);
      if (!sync) return { error: 'sync_not_found', envelopes: [], count: 0 };
      if (sync.destinationKind !== 'openwop-host' || !sync.peerIngestUrl) {
        return { error: 'not_openwop_host', envelopes: [], count: 0 };
      }
      const batch = buildOnwardEnvelopes(sync, records, dedupField ? { dedupField } : undefined);
      return {
        envelopes: batch.envelopes,
        peerIngestUrl: sync.peerIngestUrl,
        count: batch.count,
        dropped: batch.dropped,
        ...(sync.connectionId ? { connectionId: sync.connectionId } : {}),
        ...(batch.nextCursor !== undefined ? { nextCursor: batch.nextCursor } : {}),
      };
    },
    /**
     * ADR 0292 / CDP-D §6 — warehouseLoad({ syncId, records }) → the GOVERNED reverse-ETL
     * BigQuery `insertAll`. The gate is `actionPolicyOf('warehouse.load')` (default
     * `approval-required`, fail-closed): `disabled`→refuse; `draft-only`→dry-run the rows
     * that WOULD load (loaded:0); `approval-required`/unset→mint-or-consult a `warehouse-load`
     * approval and insert ONLY when it is `approved`. The result carries counts + per-row
     * failure reasons — NEVER row bodies (subject data) or the credential. Does NOT advance
     * the watermark — the workflow calls `advance` with `nextCursor` after a successful load.
     */
    warehouseLoad: async (args) => {
      const syncId = typeof args.syncId === 'string' ? args.syncId : '';
      const records = Array.isArray(args.records) ? (args.records as Record<string, unknown>[]) : [];
      return warehouseLoad(warehouseLoadDeps(runScope), { syncId, records });
    },
    /** advance({ syncId, cursor }) — commit the watermark AFTER a successful egress. */
    advance: async (args) => {
      const syncId = typeof args.syncId === 'string' ? args.syncId : '';
      const cursor = typeof args.cursor === 'string' ? args.cursor : '';
      const updated = cursor ? await advanceCursor(tenantId, syncId, cursor) : null;
      return { advanced: updated !== null, ...(updated?.cursor !== undefined ? { cursor: updated.cursor } : {}) };
    },
  };
}
