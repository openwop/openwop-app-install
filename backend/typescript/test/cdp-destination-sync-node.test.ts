/**
 * CDP-D — destination-sync `prepare` node + surface (ADR 0266). The node passes the
 * CDC+field-mapped batch through for a downstream http.fetch to egress; the surface
 * composes the store + prepareSyncBatch + cursor advance.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
// @ts-ignore — pack .mjs node imported to assert its contract.
import { prepare as prepareNode } from '../../../packs/feature.destination-sync.nodes/index.mjs';
import { buildDestinationSyncSurface } from '../src/features/destination-sync/surface.js';
import { createDestinationSync } from '../src/features/destination-sync/destinationSyncService.js';

describe('CDP-D prepare node contract', () => {
  const ctxWith = (inputs: any, withCap = true) => ({
    inputs,
    features: { 'destination-sync': withCap ? { prepare: async ({ syncId, records }: any) => ({ payloads: records.map((r: any) => ({ E: r.email })), count: records.length, forwarded: syncId }) } : {} },
  });

  it('passes the prepared batch through', async () => {
    const out: any = await prepareNode(ctxWith({ syncId: 'dsync:1', records: [{ email: 'a@x' }] }));
    expect(out.status).toBe('success');
    expect(out.outputs.count).toBe(1);
    expect(out.outputs.payloads).toEqual([{ E: 'a@x' }]);
  });
  it('fails closed without a syncId', async () => {
    const out: any = await prepareNode(ctxWith({ records: [] }));
    expect(out.status).toBe('failed');
    expect(out.error.code).toBe('validation_error');
  });
  it('fails closed when the host capability is missing', async () => {
    await expect(prepareNode(ctxWith({ syncId: 'x' }, false))).rejects.toMatchObject({ code: 'host_capability_missing' });
  });
});

describe('CDP-D destination-sync surface', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  });

  it('prepare composes the store + CDC + field map + cursor advance', async () => {
    const tenantId = `org:dsn-${Date.now()}`;
    const sync = await createDestinationSync({ tenantId, name: 's', destinationKind: 'webhook', sourceObject: 'contact', syncMode: 'cdc', fieldMap: [{ from: 'email', to: 'EMAIL' }] });
    const surface = buildDestinationSyncSurface({ tenantId } as any);
    const recs = [{ email: 'a@x', updatedAt: '2026-01-01' }, { email: 'b@x', updatedAt: '2026-02-01' }];
    const first: any = await surface.prepare({ syncId: sync.syncId, records: recs });
    expect(first.count).toBe(2);
    expect(first.payloads[0]).toEqual({ EMAIL: 'a@x' });
    // prepare does NOT advance — a re-prepare still returns them (no drop on egress fail)
    expect((await surface.prepare({ syncId: sync.syncId, records: recs })).count).toBe(2);
    // advance (post-egress) → re-prepare now sends nothing
    const adv: any = await surface.advance({ syncId: sync.syncId, cursor: first.nextCursor });
    expect(adv.advanced).toBe(true);
    expect((await surface.prepare({ syncId: sync.syncId, records: recs })).count).toBe(0);
    // unknown sync → error marker (not a throw)
    const missing: any = await surface.prepare({ syncId: 'dsync:none', records: recs });
    expect(missing.error).toBe('sync_not_found');
  });
});
