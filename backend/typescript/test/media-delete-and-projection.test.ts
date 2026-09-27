/**
 * UX_UPGRADE-media ROUND 2 — MED2-B1 / MED2-B2.
 *
 * R1's tracker names three frontend files and ZERO backend ones, and awarded
 * `/grade-code A` over a backend it never opened. Both defects here are in that
 * gap, in modules created 2026-06-08 — nearly two months before R1 merged.
 *
 *  - MED2-B1: `deleteAsset` promised "Delete an asset AND free its bytes (no
 *    orphaned storage)" while `mediaStorage.remove` DISCARDED the boolean
 *    saying whether the bytes went. It then deleted the metadata row — the only
 *    handle the app has to those bytes — so a failed byte-delete produced a 204,
 *    an asset gone from the library, and bytes still fetchable through a
 *    ~100-year capability token on a globally auth-exempt route, with nothing
 *    left able to find or delete them.
 *  - MED2-B2: `ctx.features.media.select` spread the whole row into a
 *    `role:'action'` node's outputs, which are RECORDED in the run event log.
 *    Run reads gate only on tenant, so `serveToken` — a bearer credential to
 *    the bytes — reached every viewer in the tenant, including members of
 *    orgs whose media routes 403 them. Media's own agent tool refuses exactly
 *    this ("internal storage credentials — they NEVER appear in tool output").
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createAsset, getAsset, deleteAsset } from '../src/features/media/mediaService.js';
import * as mediaStorage from '../src/features/media/mediaStorage.js';

const TENANT = 'org:media-r2';
const ORG = 'org-1';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  const d = getToggleDefault('media');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
).toString('base64');

async function anAsset(name: string) {
  const stored = await mediaStorage.put(TENANT, { contentBase64: png, contentType: 'image/png' });
  return createAsset({
    tenantId: TENANT, orgId: ORG, name, contentType: 'image/png',
    sizeBytes: Buffer.from(png, 'base64').byteLength,
    storageRef: stored.storageRef, serveToken: stored.serveToken, uploadedBy: 'u-1',
  } as never);
}

describe('MED2-B1 — a delete that cannot free the bytes does not destroy the record', () => {
  it('refuses and keeps the row when the bytes belong to ANOTHER tenant', async () => {
    // The dangerous case: the bytes stay reachable and THIS tenant cannot free
    // them, so destroying the row would leave them with no handle at all.
    // Built directly — a row in our tenant pointing at another tenant's bytes,
    // which is what a mis-keyed fold or the legacy byte-store split produces.
    const foreign = await mediaStorage.put('org:other-tenant', { contentBase64: png, contentType: 'image/png' });
    const a = await createAsset({
      tenantId: TENANT, orgId: ORG, name: 'foreign-bytes.png', contentType: 'image/png',
      sizeBytes: foreign.sizeBytes, storageRef: foreign.storageRef, serveToken: foreign.serveToken,
      uploadedBy: 'u-1',
    } as never);

    await expect(deleteAsset(TENANT, ORG, a.assetId), 'a delete that cannot free foreign bytes must not report success')
      .rejects.toMatchObject({ details: { reason: 'bytes_not_removed' } });
    expect(await getAsset(TENANT, ORG, a.assetId), 'the row is the only handle to the bytes').toBeTruthy();
  });

  it('DELETES when the bytes are already gone — the row must never become stuck', async () => {
    // MED2-R3. The first cut threw on any falsy result, conflating "already
    // gone" with "someone else's". A row that survived a partial delete was
    // then PERMANENTLY undeletable: every retry threw, and nothing else removes
    // a metadata row. Strictly worse, and unrecoverable, versus the orphan it
    // was preventing — `absent` means there is nothing left to leak.
    const a = await anAsset('half-deleted.png');
    expect(await mediaStorage.remove(TENANT, a.storageRef)).toBe('removed');
    expect(await deleteAsset(TENANT, ORG, a.assetId), 'the retry cleans it up').toBe(true);
    expect(await getAsset(TENANT, ORG, a.assetId)).toBeNull();
  });

  it('still deletes cleanly on the happy path (the negative control)', async () => {
    // Without this, "delete fails" would be satisfied by a delete that never works.
    const a = await anAsset('ordinary.png');
    expect(await deleteAsset(TENANT, ORG, a.assetId)).toBe(true);
    expect(await getAsset(TENANT, ORG, a.assetId)).toBeNull();
  });
});

describe('MED2-B2 — the select node never emits a credential to the bytes', () => {
  it('projects the selection instead of spreading the row', async () => {
    await anAsset('selectable.png');
    const media = buildHostSurfaceBundle({ tenantId: TENANT, runId: 'run-1' })
      .features.media as Record<string, (a: Record<string, unknown>) => Promise<Record<string, unknown>>>;
    const out = await media.select!({ orgId: ORG, limit: 5 });
    const assets = out.assets as Array<Record<string, unknown>>;
    expect(assets.length, 'the node still returns a usable selection').toBeGreaterThan(0);

    for (const sel of assets) {
      // The credential fields, and the internals media's own agent tool names.
      for (const banned of ['serveToken', 'serveUrl', 'storageRef', 'tenantId', 'uploadedBy', 'contentHash']) {
        expect(sel[banned], `\`${banned}\` must not reach a recorded node output`).toBeUndefined();
        expect((sel.asset as Record<string, unknown> | undefined)?.[banned]).toBeUndefined();
      }
      // …and what a consumer legitimately needs is still there.
      expect(sel.assetId, 'the selection is still identifiable').toBeTruthy();
      expect(sel.name).toBeTruthy();
      expect(typeof sel.score).toBe('number');
    }
  });
});
