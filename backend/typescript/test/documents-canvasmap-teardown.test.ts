/**
 * PROBE-DOC-6 (falsifies WF-DOC-7) — `documents:canvasmap` rows must be
 * reachable by tenant teardown.
 *
 * The row's tenant used to live ONLY inside the composite key
 * (`${tenantId}:${orgId}:${canvasId}` — unparseable, tenant ids contain ':'),
 * with no `tenantId` field and no `tenantOf` on the collection, so both
 * teardown probes missed it and mappings survived tenant deletion permanently.
 * Born-red witnessed: with the field write reverted, the purge leaves the row.
 *
 * The row is written by the REAL producer (`materializeCanvasToDocument`),
 * never hand-shaped by this test — a hand-written fixture would test the
 * test's own shape, not the service's.
 */
import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { __putCanvasForTest } from '../src/host/canvasSurface.js';
import { materializeCanvasToDocument } from '../src/features/documents/documentsService.js';
import { purgeTenantHostExt, hostExtStorage } from '../src/host/hostExtPersistence.js';

const TENANT = 'org:doc-canvasmap-a';
const OTHER_TENANT = 'org:doc-canvasmap-b';
let ORG = '';
let OTHER_ORG = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  ORG = (await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'A', ownerSubject: 'u-1' })).orgId;
  OTHER_ORG = (await createOrg({ tenantId: OTHER_TENANT, createdBy: 'u-2', name: 'B', ownerSubject: 'u-2' })).orgId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const canvasmapRows = async (): Promise<ReadonlyArray<{ key: string; value: string }>> =>
  hostExtStorage().kvList('hostext:documents:canvasmap:');

describe('PROBE-DOC-6 — canvasmap rows die with their tenant', () => {
  it('teardown purges THIS tenant\'s mapping and leaves the OTHER tenant\'s (wrong-tenant control)', async () => {
    await __putCanvasForTest({ canvasId: 'cv_map_a', tenantId: TENANT, canvasTypeId: 'canvas.brief', name: 'A brief', state: { content: '# A' }, version: 1 });
    await __putCanvasForTest({ canvasId: 'cv_map_b', tenantId: OTHER_TENANT, canvasTypeId: 'canvas.brief', name: 'B brief', state: { content: '# B' }, version: 1 });
    await materializeCanvasToDocument(TENANT, ORG, 'cv_map_a', 'u-1');
    await materializeCanvasToDocument(OTHER_TENANT, OTHER_ORG, 'cv_map_b', 'u-2');

    const before = await canvasmapRows();
    expect(before.some((r) => r.key.includes('cv_map_a')), 'precondition: the mapping row exists').toBe(true);
    expect(before.some((r) => r.key.includes('cv_map_b'))).toBe(true);

    await purgeTenantHostExt(TENANT);

    const after = await canvasmapRows();
    expect(after.some((r) => r.key.includes('cv_map_a')), 'the purged tenant\'s mapping must be GONE — it used to survive permanently').toBe(false);
    expect(after.some((r) => r.key.includes('cv_map_b')), 'the other tenant\'s mapping must SURVIVE').toBe(true);
  });
});
