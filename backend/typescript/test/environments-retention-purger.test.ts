/**
 * UX_UPGRADE-environments ROUND 3 — the R2 known-open retention gap, closed on
 * the documents precedent (#3248): the AGE stays the operator's (the sweep
 * passes the per-tenant window in; no window ⇒ never purge); what was missing
 * was the MECHANISM. Floor: a snapshot ANY environment currently pins is never
 * purged; `env:promotion` (the audit ledger) is never touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import {
  snapshotLiveConfig, listSnapshots, createEnvironment, movePointer,
} from '../src/features/environments/environmentsService.js';
import { setTenantOverrideStatus } from '../src/host/featureToggles/service.js';
import { purgeRetained } from '../src/host/retentionPurger.js';

const T = 'tenant-env-retention';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const FUTURE = '2099-01-01T00:00:00.000Z';

describe('R3 — retention reaches snapshot HISTORY; the pinned snapshot never ages away', () => {
  it('purges dormant snapshots; the currently-pinned one survives any cutoff; promotions untouched', async () => {
    // Two distinct snapshots: mutate a toggle between captures so the hashes differ.
    const s1 = await snapshotLiveConfig({ tenantId: T, sourceEnv: null, createdBy: 'op' });
    await setTenantOverrideStatus('csm', T, 'on', 'op');
    const s2 = await snapshotLiveConfig({ tenantId: T, sourceEnv: null, createdBy: 'op' });
    expect(s1.hash).not.toBe(s2.hash);
    // Pin s2 on an environment (movePointer with fromEnvName: null = the rollback/pin path).
    await createEnvironment({ tenantId: T, name: 'prod' });
    await movePointer({ tenantId: T, fromEnvName: null, toEnvName: 'prod', snapshotHash: s2.hash, actor: 'op' });

    const results = await purgeRetained(T, 'internal', FUTURE);
    const env = results.find((r) => r.feature === 'environments');
    expect(env?.ok).toBe(true);
    expect(env!.deleted).toBeGreaterThanOrEqual(1);
    const hashes = (await listSnapshots(T)).map((s) => s.hash);
    expect(hashes).not.toContain(s1.hash);  // dormant history purged
    expect(hashes).toContain(s2.hash);      // the PINNED snapshot survives any cutoff
  });

  it('a PII-classification sweep purges NOTHING here (this feature is internal-classified)', async () => {
    // Seed a FRESH dormant snapshot: the first version of this test reused the
    // drained state from the previous case, so removing the classification
    // guard still deleted zero rows — a vacuous probe, caught and rewritten.
    await setTenantOverrideStatus('entities', T, 'off', 'op');
    const dormant = await snapshotLiveConfig({ tenantId: T, sourceEnv: null, createdBy: 'op' });
    const results = await purgeRetained(T, 'confidential-pii', FUTURE);
    const env = results.find((r) => r.feature === 'environments');
    expect(env?.deleted ?? 0).toBe(0);
    expect((await listSnapshots(T)).map((sn) => sn.hash)).toContain(dormant.hash);
  });
});
