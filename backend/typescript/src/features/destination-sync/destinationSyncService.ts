/**
 * Destination-sync hub (ADR 0266 / CDP-D) — the single non-ad egress owner
 * (campaign-connectors stays the ad specialist, ADR 0262 ruling #3). This phase
 * ships the config catalog + the two genuinely-missing primitives: a CDC
 * WATERMARK cursor (changed-records-only) and trait→destination-field mapping.
 * Egress itself rides the existing SSRF-guarded http/connector nodes (deeper phase).
 */
import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { normalizeLabel, isNoOnwardUse, reEmitLabel } from '../cdp/purposeLabels.js';

export type SyncMode = 'batch' | 'event' | 'cdc';
export const SYNC_MODES: readonly SyncMode[] = ['batch', 'event', 'cdc'];

export interface FieldMapping {
  /** source field on the record (e.g. a contact trait). */
  from: string;
  /** destination field name. */
  to: string;
}

export interface DestinationSync {
  syncId: string;
  tenantId: string;
  name: string;
  /** where it sends — 'webhook' | 'crm' | 'esp' | 'warehouse' | 'openwop-host' | … (non-ad). */
  destinationKind: string;
  /** the source object synced — e.g. 'contact'. */
  sourceObject: string;
  fieldMap: FieldMapping[];
  syncMode: SyncMode;
  /** the record field the CDC watermark tracks (e.g. 'updatedAt'). */
  cursorField: string;
  /** last high-watermark synced (ISO or lexicographically-comparable). */
  cursor?: string;
  /** ADR 0289 — for `destinationKind: 'openwop-host'`: the Connection (ADR 0024) whose
   *  BYOK credential authenticates the onward POST to the peer. */
  connectionId?: string;
  /** ADR 0289 — for `destinationKind: 'openwop-host'`: the peer host's trigger-bridge
   *  ingest URL the OpenWOP envelopes are POSTed to (SSRF-guarded at send). */
  peerIngestUrl?: string;
  /** ADR 0289 / RFC 0128 §3 — an OPTIONAL onward narrowing of the re-emitted
   *  `permittedPurposes` (MUST be ⊆ the received label; `reEmitLabel` enforces it). */
  narrowTo?: string[];
  /** ADR 0292 / CDP-D §6 — for `destinationKind: 'warehouse'` (reverse-ETL BigQuery
   *  load): the destination coordinates. `connectionId` (above) points at the operator's
   *  chosen `bigquery-write` Connection (the broker still resolves auth by provider +
   *  acting user); `project`/`dataset`/`table` address the `tabledata.insertAll` target.
   *  `warehouseKeyField` is the SOURCE record field whose value seeds the per-row,
   *  fork-stable `insertId` (default `id`) so a replay/`:fork` dedups at BigQuery. */
  project?: string;
  dataset?: string;
  table?: string;
  warehouseKeyField?: string;
  createdAt: string;
  updatedAt: string;
}

/** ADR 0292 — one BigQuery `tabledata.insertAll` row: a deterministic `insertId`
 *  (dedup key) + the field-mapped `json` body. NEVER logged (subject data). */
export interface WarehouseRow {
  insertId: string;
  json: Record<string, unknown>;
}

/** ADR 0292 — the fork-stable, per-row `insertId`: a hash of (syncId, the row's key-field
 *  value, the batch/cursor marker). Deterministic (NEVER `randomUUID`) so a replay or
 *  `:fork` re-issues the SAME `insertId` and BigQuery `insertAll` dedups it. A later batch
 *  (advanced cursor marker) with the same key mints a NEW id → the updated row re-inserts. */
export function warehouseInsertId(syncId: string, keyValue: unknown, marker: string): string {
  const key = typeof keyValue === 'string' ? keyValue : JSON.stringify(keyValue ?? null);
  return createHash('sha256').update(JSON.stringify([syncId, key, marker])).digest('hex').slice(0, 32);
}

/**
 * ADR 0289 — the OpenWOP-envelope an `openwop-host` sync emits to a peer host's
 * trigger-bridge ingest: a webhook-source ingress carrying the field-mapped record as the
 * body PLUS a top-level `permittedPurposes` (RFC 0128 §1 trigger/sync carrier). The label
 * is the re-emitted (⊆ received, non-widening) onward grant; omitted when the record is
 * unlabelled (asserts no constraint). A `[]`-labelled record never produces an envelope
 * (dropped upstream, RFC 0128 §3 fail-closed).
 */
export interface OnwardTriggerEnvelope {
  source: 'webhook';
  permittedPurposes?: string[];
  webhook: { method: 'POST'; body: Record<string, unknown> };
  dedupKey?: string;
}

const store = new DurableCollection<DestinationSync>('cdp:destination-sync', (s) => s.syncId, undefined, (s) => s.tenantId);
const MAX = { name: 160, mappings: 200, perTenant: 200 } as const;

// ── pure primitives (the testable CDP-D core) ───────────────────────────────

/** Map a source record's fields to destination field names. Only mapped, present
 *  fields are emitted (a mapping whose `from` is absent is skipped). */
export function applyFieldMap(record: Record<string, unknown>, fieldMap: readonly FieldMapping[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of fieldMap) {
    if (Object.prototype.hasOwnProperty.call(record, m.from)) out[m.to] = record[m.from];
  }
  return out;
}

/**
 * CDC: from a record set, return ONLY those whose `cursorField` value is strictly
 * greater than the last watermark (`sinceCursor`), plus the new high-watermark. A
 * real changed-records-only delta (not a cooldown timer). Records missing/blank the
 * cursor field are skipped (can't be ordered). `sinceCursor === undefined` (first
 * sync) returns everything and seeds the watermark to the max.
 */
export function selectChangedRecords<T extends Record<string, unknown>>(
  records: readonly T[],
  sinceCursor: string | undefined,
  cursorField: string,
): { changed: T[]; nextCursor: string | undefined } {
  let next = sinceCursor;
  const changed: T[] = [];
  for (const r of records) {
    const v = r[cursorField];
    if (typeof v !== 'string' || v === '') continue;
    if (sinceCursor === undefined || v > sinceCursor) {
      changed.push(r);
      if (next === undefined || v > next) next = v;
    }
  }
  return { changed, nextCursor: next };
}

/** RFC 0128 flag gate — the purpose-propagation host impl (label carry + `[]`-fail-closed
 *  egress) stays OFF (advert never flips) until RFC 0128 is Accepted (CDP-1d guardrail). */
export function purposePropagationEnabled(): boolean {
  return process.env.OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED === 'true';
}

/**
 * The CDC-select + `[]`-fail-closed drop shared by `prepareSyncBatch` (non-OpenWOP field-map
 * egress) and `buildOnwardEnvelopes` (ADR 0289 OpenWOP-host egress) — one owner for the
 * eligibility rule so the two egress shapes cannot drift on which records ship.
 */
function selectEligible(
  sync: Pick<DestinationSync, 'syncMode' | 'cursor' | 'cursorField'>,
  records: readonly Record<string, unknown>[],
  opts?: { dropNoOnwardUse?: boolean },
): { eligible: Record<string, unknown>[]; nextCursor: string | undefined; dropped: number } {
  const { changed, nextCursor } = sync.syncMode === 'cdc'
    ? selectChangedRecords(records, sync.cursor, sync.cursorField)
    : { changed: [...records], nextCursor: sync.cursor };
  let dropped = 0;
  const eligible = opts?.dropNoOnwardUse
    ? changed.filter((r) => {
        const suppressed = isNoOnwardUse(normalizeLabel((r as { permittedPurposes?: unknown }).permittedPurposes));
        if (suppressed) dropped++;
        return !suppressed;
      })
    : changed;
  return { eligible, nextCursor, dropped };
}

/**
 * Prepare a sync batch (ADR 0266 / CDP-D) — the deterministic orchestration BELOW the egress:
 * select eligible records (CDC watermark + `[]`-fail-closed drop, {@link selectEligible}), then
 * field-map each into destination payloads. Pure — the actual send (rides existing
 * http/connector nodes) then persists the cursor via `advanceCursor`.
 *
 * RFC 0128 §3 `[]`-fail-closed (CDP-1d, opt-in via `opts.dropNoOnwardUse`): a record whose
 * `permittedPurposes` is `[]` asserts "no onward use" and is dropped before field-mapping.
 * Carrying a surviving label into the destination schema is the operator's field-map (the ESP
 * SHOULD leg — a non-OpenWOP sink is untestable, so not forced here). `dropped` counts the
 * suppressed. For the OpenWOP-envelope hop that DOES re-emit the label, see
 * `buildOnwardEnvelopes`.
 */
export function prepareSyncBatch(
  sync: Pick<DestinationSync, 'syncMode' | 'cursor' | 'cursorField' | 'fieldMap'>,
  records: readonly Record<string, unknown>[],
  opts?: { dropNoOnwardUse?: boolean },
): { payloads: Record<string, unknown>[]; nextCursor: string | undefined; count: number; dropped: number } {
  const { eligible, nextCursor, dropped } = selectEligible(sync, records, opts);
  const payloads = eligible.map((r) => applyFieldMap(r, sync.fieldMap));
  return { payloads, nextCursor, count: payloads.length, dropped };
}

/**
 * ADR 0289 / RFC 0128 §3 — build the OpenWOP envelopes an `openwop-host` sync emits to a
 * peer host's trigger-bridge ingest. Same eligibility as `prepareSyncBatch` (CDC-select +
 * `[]`-drop), then each surviving record becomes an {@link OnwardTriggerEnvelope} whose
 * top-level `permittedPurposes` is the **re-emitted** label — `reEmitLabel(received,
 * narrowTo)`, guaranteed ⊆ the received grant (never-widening). Unlabelled records carry no
 * `permittedPurposes` (assert no constraint); `[]` records are already dropped. Pure — the
 * actual SSRF-guarded POST lives in `openwopHostEgress.ts`.
 *
 * `dedupField`, when set, seeds a stable per-record `dedupKey` from that record field so a
 * re-sync is effectively-once at the peer (RFC 0083 §C dedup).
 */
export function buildOnwardEnvelopes(
  sync: Pick<DestinationSync, 'syncMode' | 'cursor' | 'cursorField' | 'fieldMap' | 'narrowTo'>,
  records: readonly Record<string, unknown>[],
  opts?: { dedupField?: string },
): { envelopes: OnwardTriggerEnvelope[]; nextCursor: string | undefined; count: number; dropped: number } {
  // OpenWOP-host egress ALWAYS fail-closes on `[]` (the onward hop is a real OpenWOP
  // envelope — the RFC 0128 §3 MUST, not the untestable ESP SHOULD), so dropNoOnwardUse is
  // forced on regardless of caller opts.
  const { eligible, nextCursor, dropped } = selectEligible(sync, records, { dropNoOnwardUse: true });
  const envelopes = eligible.map((r) => {
    const received = normalizeLabel((r as { permittedPurposes?: unknown }).permittedPurposes);
    const onward = reEmitLabel(received, sync.narrowTo);
    const dedupSeed = opts?.dedupField ? (r as Record<string, unknown>)[opts.dedupField] : undefined;
    const env: OnwardTriggerEnvelope = {
      source: 'webhook',
      webhook: { method: 'POST', body: applyFieldMap(r, sync.fieldMap) },
    };
    if (onward !== undefined) env.permittedPurposes = onward;
    if (typeof dedupSeed === 'string' && dedupSeed !== '') env.dedupKey = dedupSeed;
    return env;
  });
  return { envelopes, nextCursor, count: envelopes.length, dropped };
}

/**
 * ADR 0292 / CDP-D §6 — build the BigQuery `insertAll` rows a `warehouse` sync loads: the SAME
 * eligibility as `prepareSyncBatch` (CDC-select + `[]`-drop), then each surviving record becomes a
 * {@link WarehouseRow} — the field-mapped `json` body plus a deterministic {@link warehouseInsertId}
 * seeded from the record's `warehouseKeyField` (default `id`) and the pre-sync cursor MARKER, so a
 * replay/`:fork` re-issues identical insertIds (BigQuery dedups) while a later batch (advanced
 * cursor) re-inserts the updated row. Pure — the governed insert lives in `warehouseLoadService.ts`.
 */
export function buildWarehouseRows(
  sync: Pick<DestinationSync, 'syncId' | 'syncMode' | 'cursor' | 'cursorField' | 'fieldMap' | 'warehouseKeyField'>,
  records: readonly Record<string, unknown>[],
): { rows: WarehouseRow[]; nextCursor: string | undefined; count: number } {
  const { eligible, nextCursor } = selectEligible(sync, records);
  const keyField = sync.warehouseKeyField || 'id';
  const marker = sync.cursor ?? '';
  const rows = eligible.map((r) => ({
    insertId: warehouseInsertId(sync.syncId, r[keyField], marker),
    json: applyFieldMap(r, sync.fieldMap),
  }));
  return { rows, nextCursor, count: rows.length };
}

/** Validate + normalize a field map: bounded size, non-empty from/to, no dup `to`. */
export function validateFieldMap(raw: unknown): FieldMapping[] {
  if (!Array.isArray(raw)) throw new OpenwopError('validation_error', 'fieldMap must be an array.', 400, {});
  if (raw.length > MAX.mappings) throw new OpenwopError('validation_error', `fieldMap supports at most ${MAX.mappings} mappings.`, 400, {});
  const seen = new Set<string>();
  return raw.map((m) => {
    const o = (m ?? {}) as { from?: unknown; to?: unknown };
    if (typeof o.from !== 'string' || !o.from || typeof o.to !== 'string' || !o.to) {
      throw new OpenwopError('validation_error', 'each mapping needs a non-empty `from` and `to`.', 400, {});
    }
    if (seen.has(o.to)) throw new OpenwopError('validation_error', `duplicate destination field \`${o.to}\`.`, 400, {});
    seen.add(o.to);
    return { from: o.from, to: o.to };
  });
}

// ── config CRUD ──────────────────────────────────────────────────────────────

export async function listDestinationSyncs(tenantId: string): Promise<DestinationSync[]> {
  return (await store.listForTenantIndexed(tenantId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getDestinationSync(tenantId: string, syncId: string): Promise<DestinationSync | null> {
  const s = await store.get(syncId);
  return s && s.tenantId === tenantId ? s : null;
}

/** Validate an optional `narrowTo` onward-purpose list — a bounded string[] of non-empty
 *  codes (ADR 0289). `reEmitLabel` still enforces ⊆-received at egress; this only shape-checks. */
function validateNarrowTo(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX.mappings) {
    throw new OpenwopError('validation_error', 'narrowTo must be an array of purpose codes.', 400, {});
  }
  return raw.map((p) => {
    if (typeof p !== 'string' || !p) throw new OpenwopError('validation_error', 'each narrowTo purpose must be a non-empty string.', 400, {});
    return p;
  });
}

export async function createDestinationSync(input: {
  tenantId: string; name: string; destinationKind: string; sourceObject: string; fieldMap: unknown; syncMode?: unknown; cursorField?: string; connectionId?: string; peerIngestUrl?: string; narrowTo?: unknown; project?: string; dataset?: string; table?: string; warehouseKeyField?: string;
}): Promise<DestinationSync> {
  if ((await listDestinationSyncs(input.tenantId)).length >= MAX.perTenant) {
    throw new OpenwopError('validation_error', `at most ${MAX.perTenant} destination syncs per tenant.`, 400, {});
  }
  const mode = SYNC_MODES.includes(input.syncMode as SyncMode) ? (input.syncMode as SyncMode) : 'batch';
  const kind = input.destinationKind || 'webhook';
  if (kind === 'openwop-host') {
    if (!input.connectionId) throw new OpenwopError('validation_error', 'an `openwop-host` sync requires a `connectionId` (the peer host credential).', 400, {});
    if (!input.peerIngestUrl || !/^https?:\/\//.test(input.peerIngestUrl)) {
      throw new OpenwopError('validation_error', 'an `openwop-host` sync requires an http(s) `peerIngestUrl` (the peer trigger-bridge ingest).', 400, {});
    }
  }
  // ADR 0292 / CDP-D §6 — a `warehouse` (reverse-ETL BigQuery) sync needs the write-scoped
  // Connection + the fully-qualified insertAll target before it can load anything.
  if (kind === 'warehouse') {
    if (!input.connectionId) throw new OpenwopError('validation_error', 'a `warehouse` sync requires a `connectionId` (the bigquery-write Connection).', 400, {});
    if (!input.project || !input.dataset || !input.table) {
      throw new OpenwopError('validation_error', 'a `warehouse` sync requires `project`, `dataset`, and `table`.', 400, {});
    }
  }
  const narrowTo = validateNarrowTo(input.narrowTo);
  const now = new Date().toISOString();
  const sync: DestinationSync = {
    syncId: `dsync:${randomUUID()}`,
    tenantId: input.tenantId,
    name: (input.name || 'Untitled sync').slice(0, MAX.name),
    destinationKind: kind,
    sourceObject: input.sourceObject || 'contact',
    fieldMap: validateFieldMap(input.fieldMap),
    syncMode: mode,
    cursorField: input.cursorField || 'updatedAt',
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.peerIngestUrl ? { peerIngestUrl: input.peerIngestUrl } : {}),
    ...(narrowTo ? { narrowTo } : {}),
    ...(input.project ? { project: input.project } : {}),
    ...(input.dataset ? { dataset: input.dataset } : {}),
    ...(input.table ? { table: input.table } : {}),
    ...(input.warehouseKeyField ? { warehouseKeyField: input.warehouseKeyField } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await store.put(sync);
  return sync;
}

export async function updateDestinationSync(
  tenantId: string, syncId: string, patch: { name?: string; fieldMap?: unknown; syncMode?: unknown; cursorField?: string },
): Promise<DestinationSync | null> {
  const s = await getDestinationSync(tenantId, syncId);
  if (!s) return null;
  const next: DestinationSync = { ...s, updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) next.name = patch.name.slice(0, MAX.name);
  if (patch.fieldMap !== undefined) next.fieldMap = validateFieldMap(patch.fieldMap);
  if (patch.syncMode !== undefined && SYNC_MODES.includes(patch.syncMode as SyncMode)) next.syncMode = patch.syncMode as SyncMode;
  if (patch.cursorField !== undefined) next.cursorField = patch.cursorField;
  await store.put(next);
  return next;
}

/** Advance the CDC watermark after a successful sync run (idempotent — only moves forward). */
export async function advanceCursor(tenantId: string, syncId: string, newCursor: string): Promise<DestinationSync | null> {
  const s = await getDestinationSync(tenantId, syncId);
  if (!s) return null;
  if (s.cursor !== undefined && newCursor <= s.cursor) return s; // never regress
  const next: DestinationSync = { ...s, cursor: newCursor, updatedAt: new Date().toISOString() };
  await store.put(next);
  return next;
}

export async function deleteDestinationSync(tenantId: string, syncId: string): Promise<boolean> {
  const s = await getDestinationSync(tenantId, syncId);
  if (!s) return false;
  return store.delete(syncId);
}
