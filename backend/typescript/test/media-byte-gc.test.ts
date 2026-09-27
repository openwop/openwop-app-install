/**
 * ADR 0579 — media byte-retention lifecycle.
 *
 * Reference-absence — never age of live bytes, never subject identity — is the
 * deletion trigger. The sweep reclaims refs no asset row references, after a
 * 7-day grace; live bytes survive any sweep; the operator's retention window
 * gates WHEN it runs at all (the purger is `internal`-classified).
 *
 * Design correction under test: the ADR's proposed refindex is UNNECESSARY —
 * refs are 1:1 with rows by construction (dedup runs BEFORE `put`; a
 * cross-collection copy re-stores its own bytes), so orphanhood is a set
 * difference. The live-bytes-survive case is what pins that reasoning.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createAsset, getAsset } from '../src/features/media/mediaService.js';
import * as mediaStorage from '../src/features/media/mediaStorage.js';
import { sweepOrphanedMediaBytes } from '../src/features/media/erasure.js';
import { purgeRetained } from '../src/host/retentionPurger.js';

const T = 'tenant-media-gc';
let ORG = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  const org = await createOrg({ tenantId: T, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  ORG = org.orgId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

async function storedWithRow(name: string): Promise<{ storageRef: string; assetId: string }> {
  const stored = await mediaStorage.put(T, { contentBase64: PNG + Buffer.from(name).toString('base64'), contentType: 'image/png' });
  const asset = await createAsset({
    tenantId: T, orgId: ORG, name, contentType: 'image/png',
    sizeBytes: stored.sizeBytes, storageRef: stored.storageRef, serveToken: stored.serveToken, uploadedBy: 'u-1',
  });
  return { storageRef: stored.storageRef, assetId: asset.assetId };
}

describe('ADR 0579 — the orphan sweep', () => {
  it('reclaims an ORPHAN past grace; live bytes and fresh orphans survive', async () => {
    const live = await storedWithRow('live.png');
    const freshOrphan = await mediaStorage.put(T, { contentBase64: PNG + 'ZnJlc2g=', contentType: 'image/png' });
    const oldOrphan = await mediaStorage.put(T, { contentBase64: PNG + 'b2xk', contentType: 'image/png' });

    // Sweep "now": the old orphan is only reclaimable once past grace — simulate
    // by sweeping at now + 8 days (the seam takes `now`; no clock mocking).
    const removedNow = await sweepOrphanedMediaBytes(T);
    expect(removedNow).toBe(0); // both orphans are inside grace TODAY

    const removedLater = await sweepOrphanedMediaBytes(T, Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(removedLater).toBe(2); // both orphans pass grace at +8d; the LIVE ref survives

    const refs = (await mediaStorage.listRefs(T)).map((r) => r.storageRef);
    expect(refs).toContain(live.storageRef);          // referenced bytes untouched
    expect(refs).not.toContain(freshOrphan.storageRef);
    expect(refs).not.toContain(oldOrphan.storageRef);
    expect(await getAsset(T, ORG, live.assetId)).not.toBeNull(); // the row too
  });

  it('rides the retention daemon as `internal` and never fires on the PII classification', async () => {
    // Grace = 0 for this case (the operator knob ADR 0579's open question
    // asked for) so the ONLY thing separating the two sweeps below is the
    // classification guard — the first version of this test left the orphan
    // inside grace and probed GREEN against a dropped guard (vacuous; the
    // environments-purger lesson repeating).
    process.env.OPENWOP_MEDIA_ORPHAN_GRACE_MS = '0';
    try {
      const orphan = await mediaStorage.put(T, { contentBase64: PNG + 'cGlp', contentType: 'image/png' });
      const pii = await purgeRetained(T, 'confidential-pii', '2099-01-01T00:00:00.000Z');
      expect(pii.find((r) => r.feature === 'media')?.deleted ?? 0).toBe(0);
      expect((await mediaStorage.listRefs(T)).map((r) => r.storageRef)).toContain(orphan.storageRef); // survived the WRONG classification
      const internal = await purgeRetained(T, 'internal', '2099-01-01T00:00:00.000Z');
      expect(internal.find((r) => r.feature === 'media')?.deleted ?? 0).toBeGreaterThanOrEqual(1);
      expect((await mediaStorage.listRefs(T)).map((r) => r.storageRef)).not.toContain(orphan.storageRef); // reclaimed by the RIGHT one
    } finally { delete process.env.OPENWOP_MEDIA_ORPHAN_GRACE_MS; }
  });
});
