/**
 * CDP-D §6 / ADR 0292 — the GOVERNED reverse-ETL warehouse write
 * (`ctx.features['destination-sync'].warehouseLoad` → BigQuery `tabledata.insertAll`).
 *
 * Proves the governed-write spine mirrored from `host/adsAdapter.ts`, with the KEY difference:
 * the gate is `actionPolicyOf('warehouse.load')` whose UNSET default is `approval-required`
 * (fail-closed) — a NEW write, so the restrictive default is correct.
 *
 *  - unset policy → a `warehouse-load` PendingApproval is minted, NOTHING is inserted;
 *  - approve then re-run (same fork-stable batch key) → the insert proceeds, host-pinned to
 *    the insertAll path with the `{ rows:[{ insertId, json }] }` shape + the BYOK token;
 *  - `disabled` → refuse (no insert); `draft-only` → dry-run (wouldLoad=N, loaded=0, no call);
 *  - the per-row `insertId` is deterministic across two runs (dedup on replay/:fork);
 *  - BigQuery per-row `insertErrors` are surfaced as a partial `{ loaded, failed, errors }`;
 *  - a row body NEVER appears in the load result envelope;
 *  - a `warehouse` sync requires connectionId + project + dataset + table.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { warehouseLoad, setWarehouseLoadStorage } from '../src/features/destination-sync/warehouseLoadService.js';
import { buildWarehouseRows, createDestinationSync } from '../src/features/destination-sync/destinationSyncService.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { setGovernancePolicy, __resetGovernanceStore } from '../src/host/governanceService.js';
import { resolveApproval, listApprovals } from '../src/host/approvalService.js';
import type { BrokeredEgressDeps } from '../src/host/brokeredEgress.js';

interface Hit { method: string; path: string; auth?: string; body: Record<string, unknown> }

describe('CDP-D §6 warehouse load (ADR 0292)', () => {
  let bq: http.Server;
  let storage: Storage;
  let hits: Hit[] = [];
  let insertErrorsOnce: Array<{ index: number; errors: Array<{ reason: string }> }> | null = null;
  const TENANT = 'org:wh';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    setWarehouseLoadStorage(storage); // createApp already wires it; explicit for isolation
    await __resetConnectionsStore();
    await __resetGovernanceStore();

    bq = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        hits.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} });
        res.writeHead(200, { 'content-type': 'application/json' });
        const insertErrors = insertErrorsOnce;
        insertErrorsOnce = null;
        res.end(JSON.stringify({ kind: 'bigquery#tableDataInsertAllResponse', ...(insertErrors ? { insertErrors } : {}) }));
      });
    });
    await new Promise<void>((r) => bq.listen(0, '127.0.0.1', r));
    process.env.OPENWOP_BIGQUERY_API_BASE = `http://127.0.0.1:${(bq.address() as AddressInfo).port}`;

    await createSecretConnection({ tenantId: TENANT, provider: 'bigquery-write', kind: 'bearer', secret: 'BQ_TOKEN', scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'wrun-1', workflowId: 'w', tenantId: TENANT, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
    await storage.insertRun({ runId: 'wrun-2', workflowId: 'w', tenantId: TENANT, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    delete process.env.OPENWOP_BIGQUERY_API_BASE;
    await new Promise<void>((r) => bq.close(() => r()));
  });

  beforeEach(() => { hits = []; insertErrorsOnce = null; });

  const deps = (runId = 'wrun-1', actingUserId = 'u1'): BrokeredEgressDeps => ({
    storage, tenantId: TENANT, runId, ...(actingUserId ? { actingUserId } : {}), orgId: TENANT,
  });

  async function makeWarehouseSync(name: string): Promise<string> {
    const sync = await createDestinationSync({
      tenantId: TENANT, name, destinationKind: 'warehouse', sourceObject: 'contact',
      fieldMap: [{ from: 'email', to: 'EMAIL' }, { from: 'stage', to: 'lifecycle' }],
      syncMode: 'batch', connectionId: 'conn:bq', project: 'proj-1', dataset: 'ds1', table: 'contacts', warehouseKeyField: 'id',
    });
    return sync.syncId;
  }

  const records = [
    { id: 'c1', email: 'a@x.test', stage: 'lead', updatedAt: '2026-01-01' },
    { id: 'c2', email: 'b@x.test', stage: 'customer', updatedAt: '2026-02-01' },
  ];

  it('validation: a warehouse sync requires connectionId + project + dataset + table', async () => {
    await expect(createDestinationSync({
      tenantId: TENANT, name: 'bad', destinationKind: 'warehouse', sourceObject: 'contact', fieldMap: [{ from: 'email', to: 'EMAIL' }],
    })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(createDestinationSync({
      tenantId: TENANT, name: 'bad2', destinationKind: 'warehouse', sourceObject: 'contact', fieldMap: [{ from: 'email', to: 'EMAIL' }],
      connectionId: 'conn:bq', dataset: 'ds1', table: 'contacts', // no project
    })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('unset policy (default approval-required) → mints a warehouse-load approval, inserts NOTHING', async () => {
    const syncId = await makeWarehouseSync('gate-default');
    const out = await warehouseLoad(deps(), { syncId, records });
    expect(out.status).toBe('requires_approval');
    if (out.status !== 'requires_approval') return;
    expect(out.approvalStatus).toBe('pending');
    // A warehouse-load approval sits in the ONE inbox — ids + row COUNT only, no row bodies.
    const pending = await listApprovals(TENANT, 'pending');
    const appr = pending.find((a) => a.approvalId === out.approvalId);
    expect(appr?.kind).toBe('warehouse-load');
    expect(appr?.rowCount).toBe(2);
    expect(appr?.table).toBe('contacts');
    expect(JSON.stringify(appr)).not.toContain('a@x.test'); // NEVER a row body in the approval
    // The platform was NOT called.
    expect(hits).toHaveLength(0);
  });

  it('approve then re-run (same batch key) → the insert proceeds, host-pinned with the token', async () => {
    const syncId = await makeWarehouseSync('gate-approve');
    const first = await warehouseLoad(deps('wrun-1'), { syncId, records });
    expect(first.status).toBe('requires_approval');
    if (first.status !== 'requires_approval') return;
    const resolved = await resolveApproval(first.approvalId, { status: 'approved' });
    expect(resolved?.changed).toBe(true);

    // Re-run — a NEW runId (simulating a :fork), identical business inputs → same batch key → approved.
    hits = [];
    const out = await warehouseLoad(deps('wrun-2'), { syncId, records });
    expect(out.status, JSON.stringify(out)).toBe('loaded');
    if (out.status !== 'loaded') return;
    expect(out.loaded).toBe(2);
    expect(out.failed).toBe(0);

    // Exactly one insertAll POST to the host-pinned path with the token + the { rows:[{insertId,json}] } shape.
    expect(hits).toHaveLength(1);
    expect(hits[0].method).toBe('POST');
    expect(hits[0].path).toBe('/bigquery/v2/projects/proj-1/datasets/ds1/tables/contacts/insertAll');
    expect(hits[0].auth).toBe('Bearer BQ_TOKEN');
    const rows = hits[0].body.rows as Array<{ insertId: string; json: Record<string, unknown> }>;
    expect(rows).toHaveLength(2);
    expect(typeof rows[0].insertId).toBe('string');
    expect(rows[0].json).toEqual({ EMAIL: 'a@x.test', lifecycle: 'lead' });
    // No token in the returned result.
    expect(JSON.stringify(out)).not.toContain('BQ_TOKEN');
    // RFC 0079 provenance stamped for the bigquery-write connection.
    const meta = (await storage.getRun('wrun-2'))?.metadata as Record<string, unknown> | undefined;
    expect((meta?.connectionUse as Array<{ provider?: string }> | undefined)?.some((u) => u.provider === 'bigquery-write')).toBe(true);
  });

  it("policy 'disabled' → refuses, no insert", async () => {
    await setGovernancePolicy(TENANT, { actionPolicy: { 'warehouse.load': 'disabled' } }, 'admin');
    const syncId = await makeWarehouseSync('gate-disabled');
    const out = await warehouseLoad(deps(), { syncId, records });
    expect(out.status).toBe('disabled');
    expect(hits).toHaveLength(0);
    await __resetGovernanceStore();
  });

  it("policy 'draft-only' → dry-runs (wouldLoad=N, loaded=0), no insert", async () => {
    await setGovernancePolicy(TENANT, { actionPolicy: { 'warehouse.load': 'draft-only' } }, 'admin');
    const syncId = await makeWarehouseSync('gate-draft');
    const out = await warehouseLoad(deps(), { syncId, records });
    expect(out.status).toBe('dry_run');
    if (out.status !== 'dry_run') return;
    expect(out.wouldLoad).toBe(2);
    expect(out.loaded).toBe(0);
    expect(out.rows).toHaveLength(2);
    expect(hits).toHaveLength(0); // NO brokeredPost in a dry-run
    await __resetGovernanceStore();
  });

  it('insertId is deterministic across two builds (dedup on replay/:fork)', () => {
    const sync = { syncId: 'dsync:fixed', syncMode: 'batch' as const, cursor: undefined, cursorField: 'updatedAt', fieldMap: [{ from: 'email', to: 'EMAIL' }], warehouseKeyField: 'id' };
    const a = buildWarehouseRows(sync, records);
    const b = buildWarehouseRows(sync, records);
    expect(a.rows.map((r) => r.insertId)).toEqual(b.rows.map((r) => r.insertId));
    // Distinct rows get distinct insertIds.
    expect(a.rows[0].insertId).not.toBe(a.rows[1].insertId);
  });

  it("partial-batch: BigQuery per-row insertErrors surface as { loaded, failed, errors } — never row bodies", async () => {
    await setGovernancePolicy(TENANT, { actionPolicy: { 'warehouse.load': 'approval-required' } }, 'admin');
    const syncId = await makeWarehouseSync('gate-partial');
    const first = await warehouseLoad(deps(), { syncId, records });
    if (first.status !== 'requires_approval') throw new Error('expected requires_approval');
    await resolveApproval(first.approvalId, { status: 'approved' });

    insertErrorsOnce = [{ index: 1, errors: [{ reason: 'invalid' }] }];
    hits = [];
    const out = await warehouseLoad(deps(), { syncId, records });
    expect(out.status).toBe('loaded');
    if (out.status !== 'loaded') return;
    expect(out.loaded).toBe(1);
    expect(out.failed).toBe(1);
    expect(out.errors).toEqual([{ index: 1, reason: 'invalid' }]);
    expect(JSON.stringify(out)).not.toContain('b@x.test'); // no offending row body in the envelope
    await __resetGovernanceStore();
  });
});
