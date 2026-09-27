/**
 * feature.destination-sync.nodes (ADR 0266 / CDP-D + ADR 0289 / RFC 0128 G4 + ADR 0292 /
 * CDP-D §6) — the `prepare`, `prepare-onward`, and `warehouse-load` verbs over
 * ctx.features['destination-sync'].
 *
 * - `prepare` (ADR 0266) produces CDC-filtered, field-mapped destination payloads so a
 *   downstream `core.openwop.http.fetch` (fanned out per payload) does the actual
 *   SSRF-guarded egress — no bespoke sender (ADR 0262 ruling #3).
 * - `prepare-onward` (ADR 0289) produces the OpenWOP envelopes an `openwop-host` sync
 *   forwards to a peer host's trigger-bridge ingest, each carrying the re-emitted
 *   `permittedPurposes` label (⊆ received, never-widen, `[]`-drop; RFC 0128). It also
 *   flattens the FIRST envelope onto `onwardBody` (+ `peerIngestUrl`) so a single
 *   downstream `core.openwop.http.fetch` can POST it — the W1.1 reference vehicle.
 * - `warehouse-load` (ADR 0292) runs the GOVERNED reverse-ETL BigQuery `insertAll` through
 *   the surface (approval-gated, deterministic insertId, partial-batch, PII-safe) and
 *   surfaces the gate verdict as the node status. This one does NOT ride http.fetch — the
 *   governed write cannot live in a raw egress node.
 *
 * Pure-JS, Node-20 stdlib only.
 */

function ensureDest(ctx) {
  const ds = ctx.features && ctx.features['destination-sync'];
  if (!ds || typeof ds.prepare !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['destination-sync'] — enable Destination Sync (ADR 0266)"),
      { code: 'host_capability_missing', capability: 'host.sample.destination-sync' },
    );
  }
  return ds;
}

function ensureOnward(ctx) {
  const ds = ctx.features && ctx.features['destination-sync'];
  if (!ds || typeof ds.prepareOnward !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['destination-sync'].prepareOnward — enable Destination Sync + purpose propagation (ADR 0289 / RFC 0128)"),
      { code: 'host_capability_missing', capability: 'host.sample.destination-sync' },
    );
  }
  return ds;
}

function ensureWarehouse(ctx) {
  const ds = ctx.features && ctx.features['destination-sync'];
  if (!ds || typeof ds.warehouseLoad !== 'function') {
    throw Object.assign(
      new Error("host does not expose ctx.features['destination-sync'].warehouseLoad — enable Destination Sync (ADR 0292 / CDP-D §6)"),
      { code: 'host_capability_missing', capability: 'host.sample.destination-sync' },
    );
  }
  return ds;
}

/** prepare: { syncId, records } → { payloads, count, nextCursor? }. The payloads
 *  feed a core.openwop.http.fetch (per-payload fan-out) for egress. */
export async function prepare(ctx) {
  const ds = ensureDest(ctx);
  const i = ctx.inputs ?? {};
  const syncId = typeof i.syncId === 'string' ? i.syncId : '';
  const records = Array.isArray(i.records) ? i.records : [];
  if (!syncId) return { status: 'failed', error: { code: 'validation_error', message: 'syncId is required.' } };
  const r = await ds.prepare({ syncId, records });
  if (r && r.error) return { status: 'failed', error: { code: 'not_found', message: 'destination sync not found.' } };
  return { status: 'success', outputs: r };
}

/** prepare-onward (ADR 0289 / RFC 0128 G4): { syncId, records } → { envelopes,
 *  onwardBody, peerIngestUrl, count, dropped, nextCursor?, connectionId? }. Mirrors
 *  `prepare` but drives the `openwop-host` egress path: the surface builds the onward
 *  OpenWOP envelopes (each carrying the re-emitted `permittedPurposes`), and the node
 *  flattens `envelopes[0]` onto `onwardBody` so a single downstream
 *  `core.openwop.http.fetch` POSTs it to `peerIngestUrl`. Flag-gated in the surface —
 *  when purpose-propagation is off it returns `{ error:'purpose_propagation_disabled' }`,
 *  which this node surfaces as a failed outcome (honest-off). */
export async function prepareOnward(ctx) {
  const ds = ensureOnward(ctx);
  const i = ctx.inputs ?? {};
  const syncId = typeof i.syncId === 'string' ? i.syncId : '';
  const records = Array.isArray(i.records) ? i.records : [];
  if (!syncId) return { status: 'failed', error: { code: 'validation_error', message: 'syncId is required.' } };
  const r = await ds.prepareOnward({ syncId, records });
  if (r && r.error) {
    const messages = {
      purpose_propagation_disabled: 'Purpose propagation is disabled — the RFC 0128 flag is off (honest-off until witnessed).',
      sync_not_found: 'destination sync not found.',
      not_openwop_host: "destination sync is not an 'openwop-host' sync (needs destinationKind='openwop-host' + peerIngestUrl).",
    };
    return { status: 'failed', error: { code: r.error, message: messages[r.error] ?? 'onward preparation failed.' } };
  }
  const envelopes = Array.isArray(r.envelopes) ? r.envelopes : [];
  return {
    status: 'success',
    outputs: {
      envelopes,
      onwardBody: envelopes.length > 0 ? envelopes[0] : null,
      peerIngestUrl: r.peerIngestUrl,
      count: r.count,
      dropped: r.dropped,
      ...(r.nextCursor !== undefined ? { nextCursor: r.nextCursor } : {}),
      ...(r.connectionId ? { connectionId: r.connectionId } : {}),
    },
  };
}

/** warehouse-load (ADR 0292 / CDP-D §6): { syncId, records } → the GOVERNED reverse-ETL
 *  BigQuery insertAll over ctx.features['destination-sync'].warehouseLoad. Surfaces the gate
 *  verdict as the node status so a workflow can branch: `loaded` (with { loaded, failed,
 *  errors, nextCursor? }), `requires_approval` (a warehouse-load approval is pending —
 *  approve then re-run), `draft_run` (draft-only preview — the rows that WOULD load, loaded:0),
 *  or a `failed` outcome (disabled policy / no connection / insert error). NEVER surfaces row
 *  bodies beyond the draft-only preview, and never a credential. */
export async function warehouseLoad(ctx) {
  const ds = ensureWarehouse(ctx);
  const i = ctx.inputs ?? {};
  const syncId = typeof i.syncId === 'string' ? i.syncId : '';
  const records = Array.isArray(i.records) ? i.records : [];
  if (!syncId) return { status: 'failed', error: { code: 'validation_error', message: 'syncId is required.' } };
  const r = await ds.warehouseLoad({ syncId, records });
  switch (r && r.status) {
    case 'loaded':
      return { status: 'success', outputs: { status: 'loaded', loaded: r.loaded, failed: r.failed, errors: r.errors, ...(r.nextCursor !== undefined ? { nextCursor: r.nextCursor } : {}) } };
    case 'requires_approval':
      // A gated batch is NOT a run failure — surface the verdict so the workflow can wait
      // for the human sign-off and re-run (the same fork-stable batch key proceeds).
      return { status: 'success', outputs: { status: 'requires_approval', approvalId: r.approvalId, approvalStatus: r.approvalStatus } };
    case 'dry_run':
      return { status: 'success', outputs: { status: 'draft_run', wouldLoad: r.wouldLoad, loaded: 0, rows: r.rows, ...(r.nextCursor !== undefined ? { nextCursor: r.nextCursor } : {}) } };
    case 'disabled':
      return { status: 'failed', error: { code: 'policy_disabled', message: 'The warehouse.load action policy is disabled for this tenant.' } };
    case 'no_connection':
      return { status: 'failed', error: { code: 'no_connection', message: 'No bigquery-write connection for the acting user.' } };
    case 'sync_not_found':
      return { status: 'failed', error: { code: 'not_found', message: 'destination sync not found.' } };
    case 'not_configured':
      return { status: 'failed', error: { code: 'not_configured', message: "sync is not a fully-configured 'warehouse' sync (needs destinationKind='warehouse' + connectionId + project + dataset + table)." } };
    default:
      return { status: 'failed', error: { code: (r && r.error) || 'failed', message: 'warehouse load failed.' } };
  }
}

export const nodes = {
  'feature.destination-sync.nodes.prepare': prepare,
  'feature.destination-sync.nodes.prepare-onward': prepareOnward,
  'feature.destination-sync.nodes.warehouse-load': warehouseLoad,
};
