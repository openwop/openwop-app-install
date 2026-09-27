/**
 * Reverse-ETL warehouse load (ADR 0292 / CDP-D §6) — the GOVERNED BigQuery
 * `tabledata.insertAll` write behind `ctx.features['destination-sync'].warehouseLoad`.
 *
 * Single owner = destination-sync (ADR 0262 ruling #3 — the one non-ad egress owner). This
 * is NOT a `host/` adapter (that would shadow destination-sync's egress ownership); it is a
 * feature-level surface verb that CALLS the host seams (features → host is the allowed
 * direction): `brokeredEgress` (the sanctioned SSRF-guarded, credential-resolving,
 * host-pinned transport), `governanceService` (the action-policy gate), and `approvalService`
 * (the one approvals inbox). It mirrors `host/adsAdapter.ts`'s governed-write spine.
 *
 * The load-bearing differences from adsAdapter's spend gate:
 *  - **The gate uses `actionPolicyOf('warehouse.load')`, whose UNSET default is
 *    `approval-required`** (governanceService's T6 posture). adsAdapter reads the policy
 *    DIRECTLY to AVOID that default (it would break pre-existing ad flows); a warehouse write
 *    is NEW, so the fail-closed `approval-required` default is CORRECT and there is NO
 *    spend-threshold logic. A policy read that THROWS is treated as gated (fail-closed).
 *  - The transport reuses `brokeredPost` on the `bigquery-write` provider (ruling satisfied —
 *    no bespoke sender). The URL is built from a HARDCODED BigQuery host constant (never
 *    input-derived), exactly as adsAdapter builds its platform hosts.
 *
 * PII posture (ADR 0292): row bodies are subject data — they are NEVER logged and NEVER
 * appear in the LOAD result envelope (only counts + `{index, reason}` per failed row). The
 * BYOK `bigquery-write` credential is resolved host-side by `brokeredPost` and never reaches
 * logs, results, or the approval row.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '../../observability/logger.js';
import type { Storage } from '../../storage/storage.js';
import { brokeredPost, type BrokeredEgressDeps } from '../../host/brokeredEgress.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { actionPolicyOf } from '../../host/governanceService.js';
import { createWarehouseLoadApproval, getApproval } from '../../host/approvalService.js';
import { stampConnectionUse } from '../../host/connectionInjection.js';
import { getDestinationSync, buildWarehouseRows, type WarehouseRow } from './destinationSyncService.js';

const log = createLogger('cdp.warehouse-load');

/** The connector-action-governance kind (ADR 0028) for a reverse-ETL warehouse load.
 *  UNSET ⇒ `approval-required` (governanceService T6 default) — the fail-closed gate. */
export const WAREHOUSE_LOAD_ACTION_KIND = 'warehouse.load';

/** The write-scoped BigQuery provider (ADR 0076 correction / ADR 0266). The broker resolves
 *  the acting human's `bigquery-write` Connection by (tenant, provider, actingUser) — the
 *  config's `connectionId` records the operator's chosen connection but auth resolves here. */
const WAREHOUSE_PROVIDER = 'bigquery-write';

/** BigQuery REST base — a HARDCODED host constant (NEVER input-derived); test override only. */
function bigQueryApiBase(): string {
  return (process.env.OPENWOP_BIGQUERY_API_BASE ?? 'https://bigquery.googleapis.com').replace(/\/+$/, '');
}

// ── storage injection (the host.chat singleton precedent) ────────────────────
// A feature surface is built from a `BundleScope` (tenant/run/actingUser) with NO
// `storage` handle; brokeredEgress's dep bag types a `Storage`, and provenance stamping
// needs one. Inject the app Storage ONCE at boot (index.ts), mirroring `setChatStorage`.
let _storage: Storage | null = null;
export function setWarehouseLoadStorage(storage: Storage): void {
  _storage = storage;
}
function requireStorage(): Storage {
  if (!_storage) throw Object.assign(new Error('warehouse-load storage not initialized'), { code: 'host_capability_missing' });
  return _storage;
}

// ── approval idempotency map (mirrors adsAdapter's spendApprovals) ───────────
interface WarehouseApprovalMapRow { idemKey: string; tenantId: string; approvalId: string; }
const warehouseApprovals = new DurableCollection<WarehouseApprovalMapRow>('cdp:warehouse-load-approval', (r) => r.idemKey);

/** Fork-stable per-BATCH idempotency key (mirrors adsAdapter's spendKey): tenant + sync +
 *  destination + the pre-sync cursor MARKER. NO runId, NO random — an approve-then-rerun of
 *  the same batch reuses the approval and a `:fork` can't re-ask. Components are JSON-encoded
 *  before hashing so a `:` inside an id can't collide two tenants' keys. */
function warehouseBatchKey(tenantId: string, syncId: string, dataset: string, table: string, marker: string): string {
  return `whload:${createHash('sha256').update(JSON.stringify([tenantId, syncId, dataset, table, marker])).digest('hex')}`;
}

type WarehouseGateVerdict =
  | { verdict: 'allow' }
  | { verdict: 'draft-only' }
  | { verdict: 'disabled' }
  | { verdict: 'requires-approval'; approvalId: string; approvalStatus: 'pending' | 'rejected' };

async function evaluateWarehouseGate(
  deps: BrokeredEgressDeps,
  idemKey: string,
  describe: { syncId: string; dataset: string; table: string; rowCount: number },
): Promise<WarehouseGateVerdict> {
  // The action policy — UNSET defaults to `approval-required` (the CORRECT fail-closed posture
  // for a NEW write). A read that THROWS is treated as gated (fail-closed, mirrors adsAdapter).
  let policy: 'disabled' | 'draft-only' | 'approval-required';
  try {
    policy = await actionPolicyOf(deps.tenantId, WAREHOUSE_LOAD_ACTION_KIND);
  } catch (e) {
    log.warn('warehouse-load policy read failed — treating as gated (fail-closed)', { error: e instanceof Error ? e.message : String(e) });
    policy = 'approval-required';
  }
  if (policy === 'disabled') return { verdict: 'disabled' };
  if (policy === 'draft-only') return { verdict: 'draft-only' };

  // approval-required (or unset) — mint-or-consult the batch's warehouse-load approval.
  const mapped = await warehouseApprovals.get(idemKey).catch(() => undefined);
  if (mapped && mapped.tenantId === deps.tenantId) {
    const approval = await getApproval(mapped.approvalId);
    if (approval && approval.tenantId === deps.tenantId) {
      if (approval.status === 'approved') return { verdict: 'allow' };
      return { verdict: 'requires-approval', approvalId: approval.approvalId, approvalStatus: approval.status === 'rejected' ? 'rejected' : 'pending' };
    }
  }
  const approval = await createWarehouseLoadApproval({
    tenantId: deps.tenantId,
    syncId: describe.syncId,
    dataset: describe.dataset,
    table: describe.table,
    rowCount: describe.rowCount,
    idemKey,
    proposal: `Load ${describe.rowCount} row(s) into BigQuery ${describe.dataset}.${describe.table} (reverse-ETL warehouse write)`,
  });
  await warehouseApprovals.put({ idemKey, tenantId: deps.tenantId, approvalId: approval.approvalId }).catch((e) =>
    log.warn('warehouse-load approval map write failed', { error: e instanceof Error ? e.message : String(e) }));
  return { verdict: 'requires-approval', approvalId: approval.approvalId, approvalStatus: 'pending' };
}

/** One `tabledata.insertAll` POST. NON-atomic — BigQuery returns per-row `insertErrors`, so a
 *  partial batch is surfaced honestly ({loaded, failed, errors}) rather than claiming
 *  all-or-nothing. Row bodies never leave this function (never logged, never in the result). */
async function insertRows(
  deps: BrokeredEgressDeps,
  target: { project: string; dataset: string; table: string },
  rows: WarehouseRow[],
): Promise<
  | { outcome: 'no_connection' }
  | { outcome: 'failed'; error: string }
  | { outcome: 'loaded'; loaded: number; failed: number; errors: Array<{ index: number; reason: string }> }
> {
  const url = `${bigQueryApiBase()}/bigquery/v2/projects/${encodeURIComponent(target.project)}/datasets/${encodeURIComponent(target.dataset)}/tables/${encodeURIComponent(target.table)}/insertAll`;
  const body = JSON.stringify({ rows: rows.map((r) => ({ insertId: r.insertId, json: r.json })) });
  const r = await brokeredPost(deps, { provider: WAREHOUSE_PROVIDER, url, body });
  if (r.outcome === 'no_connection') return { outcome: 'no_connection' };
  if (r.outcome === 'insecure_base') return { outcome: 'failed', error: 'insecure_base' };
  if (r.outcome === 'request_failed') return { outcome: 'failed', error: r.timedOut ? 'timeout' : 'request_failed' };
  let json: { insertErrors?: Array<{ index?: number; errors?: Array<{ reason?: string; message?: string }> }>; error?: { message?: string } };
  try { json = (await r.res.json()) as typeof json; } catch { return { outcome: 'failed', error: 'bad_response' }; }
  if (!r.res.ok || json.error) return { outcome: 'failed', error: json.error?.message ?? `http_${r.res.status}` };
  // Provenance (RFC 0079) — connection metadata only, never a token or a row body.
  if (deps.runId) {
    await stampConnectionUse(deps.storage, deps.runId, r.provenance).catch((e) =>
      log.warn('warehouse-load connectionUse stamp failed', { error: e instanceof Error ? e.message : String(e) }));
  }
  const insertErrors = Array.isArray(json.insertErrors) ? json.insertErrors : [];
  const errors = insertErrors.map((e) => ({
    index: typeof e.index === 'number' ? e.index : -1,
    // reason ONLY — never the offending row body (subject data).
    reason: e.errors?.[0]?.reason ?? e.errors?.[0]?.message ?? 'unknown',
  }));
  return { outcome: 'loaded', loaded: rows.length - errors.length, failed: errors.length, errors };
}

export type WarehouseLoadResult =
  | { status: 'sync_not_found' }
  | { status: 'not_configured'; error: string }
  | { status: 'disabled' }
  | { status: 'no_connection' }
  | { status: 'failed'; error: string }
  // draft-only preview: the rows that WOULD load — nothing inserted (loaded:0). The
  // preview's whole purpose is human review, so it DOES carry the row bodies (as the node
  // output, like adsAdapter's dry-run plan); the LOAD result never does.
  | { status: 'dry_run'; wouldLoad: number; loaded: 0; rows: WarehouseRow[]; nextCursor?: string }
  // gated: a warehouse-load approval is pending/rejected — nothing inserted.
  | { status: 'requires_approval'; approvalId: string; approvalStatus: 'pending' | 'rejected' }
  // the governed insert ran — counts + per-row failure reasons only (NO row bodies).
  | { status: 'loaded'; loaded: number; failed: number; errors: Array<{ index: number; reason: string }>; nextCursor?: string };

/**
 * The governed warehouse load. Resolves the `warehouse` sync, CDC-selects + field-maps the
 * records into deterministic-insertId rows, runs the `actionPolicyOf('warehouse.load')` gate
 * (default `approval-required`), and only when the batch is `approved`/`allow` performs the
 * `insertAll`. Returns the gate verdict otherwise. Never advances the cursor — the workflow
 * commits the watermark via the existing `advance` verb AFTER a successful load.
 */
export async function warehouseLoad(
  deps: BrokeredEgressDeps,
  args: { syncId: string; records: readonly Record<string, unknown>[] },
): Promise<WarehouseLoadResult> {
  const sync = await getDestinationSync(deps.tenantId, args.syncId);
  if (!sync) return { status: 'sync_not_found' };
  if (sync.destinationKind !== 'warehouse') return { status: 'not_configured', error: 'not_a_warehouse_sync' };
  if (!sync.project || !sync.dataset || !sync.table) return { status: 'not_configured', error: 'missing_warehouse_target' };

  const built = buildWarehouseRows(sync, args.records);
  const nextCursor = built.nextCursor;
  // Nothing to load (empty batch / all filtered by the CDC watermark) — a no-op success, no
  // gate, no insert. Advancing the (unchanged) cursor is harmless and the workflow's job.
  if (built.rows.length === 0) {
    return { status: 'loaded', loaded: 0, failed: 0, errors: [], ...(nextCursor !== undefined ? { nextCursor } : {}) };
  }

  const idemKey = warehouseBatchKey(deps.tenantId, sync.syncId, sync.dataset, sync.table, sync.cursor ?? '');
  const gate = await evaluateWarehouseGate(deps, idemKey, { syncId: sync.syncId, dataset: sync.dataset, table: sync.table, rowCount: built.rows.length });
  if (gate.verdict === 'disabled') return { status: 'disabled' };
  if (gate.verdict === 'draft-only') {
    return { status: 'dry_run', wouldLoad: built.rows.length, loaded: 0, rows: built.rows, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  }
  if (gate.verdict === 'requires-approval') {
    return { status: 'requires_approval', approvalId: gate.approvalId, approvalStatus: gate.approvalStatus };
  }

  // verdict === 'allow' — perform the governed insert.
  const res = await insertRows(deps, { project: sync.project, dataset: sync.dataset, table: sync.table }, built.rows);
  if (res.outcome === 'no_connection') return { status: 'no_connection' };
  if (res.outcome === 'failed') return { status: 'failed', error: res.error };
  return { status: 'loaded', loaded: res.loaded, failed: res.failed, errors: res.errors, ...(nextCursor !== undefined ? { nextCursor } : {}) };
}

/** Build the brokered-egress dep bag for a surface call from a run scope + the injected
 *  Storage. `orgId` mirrors adsAdapter's `orgId: run.tenantId`. */
export function warehouseLoadDeps(scope: { tenantId: string; runId?: string; actingUserId?: string }): BrokeredEgressDeps {
  return {
    storage: requireStorage(),
    tenantId: scope.tenantId,
    runId: scope.runId ?? '',
    ...(scope.actingUserId ? { actingUserId: scope.actingUserId } : {}),
    orgId: scope.tenantId,
  };
}
