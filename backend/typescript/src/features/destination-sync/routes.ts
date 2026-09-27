/**
 * Destination-sync routes (ADR 0266 / CDP-D) under /v1/host/openwop-app/destination-sync.
 * Toggle-gated (backend authority) via the SHARED `requireFeatureEnabled` choke.
 * Config catalog + a dry-run that previews the field-mapped payload without sending.
 *
 * § ADR 0419 §Correction (2026-07-19) — this package used to roll its OWN
 * `resolveOne`-based gate, bypassing the ADR 0419 central entitlement choke. Since
 * `destination-sync` is in the SELLABLE `customer-data-platform` bundle, that made
 * the bundle a dishonest paywall the moment an operator priced it. The local gate
 * duplicated the shared helper exactly (same subject shape, same 404 body), so it
 * is deleted rather than patched.
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireString, requireFeatureEnabled } from '../featureRoute.js';
import {
  applyFieldMap,
  createDestinationSync,
  deleteDestinationSync,
  getDestinationSync,
  listDestinationSyncs,
  prepareSyncBatch,
  advanceCursor,
  updateDestinationSync,
} from './destinationSyncService.js';

const TOGGLE_ID = 'destination-sync';
const tenantOf = (req: Request): string => req.tenantId ?? 'default';
/** Shared toggle choke + the ADR 0419 entitlement gate. `'Destination Sync'` as
 *  the label keeps the 404 body byte-identical to the former local gate. */
async function requireEnabled(req: Request): Promise<void> {
  await requireFeatureEnabled(req, TOGGLE_ID, 'Destination Sync');
}

export function registerDestinationSyncRoutes({ app }: RouteDeps): void {
  const base = '/v1/host/openwop-app/destination-sync/syncs';

  app.get(base, async (req, res, next) => {
    try { await requireEnabled(req); res.json({ syncs: await listDestinationSyncs(tenantOf(req)) }); } catch (err) { next(err); }
  });

  app.post(base, async (req, res, next) => {
    try {
      await requireEnabled(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const sync = await createDestinationSync({
        tenantId: tenantOf(req),
        name: requireString(b.name, 'name'),
        destinationKind: typeof b.destinationKind === 'string' ? b.destinationKind : 'webhook',
        sourceObject: typeof b.sourceObject === 'string' ? b.sourceObject : 'contact',
        fieldMap: b.fieldMap ?? [],
        syncMode: b.syncMode,
        ...(typeof b.cursorField === 'string' ? { cursorField: b.cursorField } : {}),
        // ADR 0289 openwop-host + ADR 0292 warehouse coordinates (validated in the service).
        ...(typeof b.connectionId === 'string' ? { connectionId: b.connectionId } : {}),
        ...(typeof b.peerIngestUrl === 'string' ? { peerIngestUrl: b.peerIngestUrl } : {}),
        ...(b.narrowTo !== undefined ? { narrowTo: b.narrowTo } : {}),
        ...(typeof b.project === 'string' ? { project: b.project } : {}),
        ...(typeof b.dataset === 'string' ? { dataset: b.dataset } : {}),
        ...(typeof b.table === 'string' ? { table: b.table } : {}),
        ...(typeof b.warehouseKeyField === 'string' ? { warehouseKeyField: b.warehouseKeyField } : {}),
      });
      res.status(201).json(sync);
    } catch (err) { next(err); }
  });

  app.get(`${base}/:id`, async (req, res, next) => {
    try {
      await requireEnabled(req);
      const sync = await getDestinationSync(tenantOf(req), req.params.id);
      if (!sync) throw new OpenwopError('not_found', 'Sync not found.', 404, { syncId: req.params.id });
      res.json(sync);
    } catch (err) { next(err); }
  });

  app.patch(`${base}/:id`, async (req, res, next) => {
    try {
      await requireEnabled(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const patch: { name?: string; fieldMap?: unknown; syncMode?: unknown; cursorField?: string } = {};
      if (typeof b.name === 'string') patch.name = b.name;
      if (b.fieldMap !== undefined) patch.fieldMap = b.fieldMap;
      if (b.syncMode !== undefined) patch.syncMode = b.syncMode;
      if (typeof b.cursorField === 'string') patch.cursorField = b.cursorField;
      const updated = await updateDestinationSync(tenantOf(req), req.params.id, patch);
      if (!updated) throw new OpenwopError('not_found', 'Sync not found.', 404, { syncId: req.params.id });
      res.json(updated);
    } catch (err) { next(err); }
  });

  app.delete(`${base}/:id`, async (req, res, next) => {
    try {
      await requireEnabled(req);
      if (!(await deleteDestinationSync(tenantOf(req), req.params.id))) {
        throw new OpenwopError('not_found', 'Sync not found.', 404, { syncId: req.params.id });
      }
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // Dry-run: preview the field-mapped payload for a sample record (no send).
  app.post(`${base}/:id/dry-run`, async (req, res, next) => {
    try {
      await requireEnabled(req);
      const sync = await getDestinationSync(tenantOf(req), req.params.id);
      if (!sync) throw new OpenwopError('not_found', 'Sync not found.', 404, { syncId: req.params.id });
      const sample = ((req.body ?? {}) as { sample?: unknown }).sample;
      if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
        throw new OpenwopError('validation_error', '`sample` must be an object record.', 400, {});
      }
      res.json({ mapped: applyFieldMap(sample as Record<string, unknown>, sync.fieldMap) });
    } catch (err) { next(err); }
  });

  // Prepare a sync batch from supplied records (CDC-filtered + field-mapped, no send).
  // Does NOT advance the watermark — advancing before egress would DROP records on an
  // egress failure (code-review HIGH). The caller egresses `payloads`, then commits the
  // watermark via POST /advance with the returned `nextCursor` (at-least-once).
  app.post(`${base}/:id/prepare`, async (req, res, next) => {
    try {
      await requireEnabled(req);
      const sync = await getDestinationSync(tenantOf(req), req.params.id);
      if (!sync) throw new OpenwopError('not_found', 'Sync not found.', 404, { syncId: req.params.id });
      const records = ((req.body ?? {}) as { records?: unknown }).records;
      if (!Array.isArray(records)) throw new OpenwopError('validation_error', '`records` must be an array of objects.', 400, {});
      res.json(prepareSyncBatch(sync, records as Record<string, unknown>[]));
    } catch (err) { next(err); }
  });

  // Commit the CDC watermark AFTER a successful egress (forward-only). Separated from
  // prepare so a failed send never advances past un-delivered records.
  app.post(`${base}/:id/advance`, async (req, res, next) => {
    try {
      await requireEnabled(req);
      const cursor = requireString((req.body as { cursor?: unknown })?.cursor, 'cursor');
      const updated = await advanceCursor(tenantOf(req), req.params.id, cursor);
      if (!updated) throw new OpenwopError('not_found', 'Sync not found.', 404, { syncId: req.params.id });
      res.json({ cursor: updated.cursor });
    } catch (err) { next(err); }
  });
}
