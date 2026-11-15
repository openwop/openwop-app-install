/**
 * ADR 1122 P1a — public-asset grants follow what a published CMS page shows.
 *
 * Under `OPENWOP_ASSET_ACCESS=enforce`, an anonymous read of a page's picture:
 *  - is refused while the page is a draft, served once it is published, and refused
 *    again after it is unpublished (the hooks, after commit);
 *  - follows an unhooked change through the reconcile: a page published while the
 *    switch was off gets its grant from the backfill, and one unpublished while off
 *    loses its grant on the row revisit;
 *  - a provider that throws KEEPS the grantor's existing grants (14's condition 2);
 *  - the hub's centre picture is collected (the walker fix).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import { collectMediaTokens, createPage, transitionPage, type Section } from '../src/features/cms/cmsService.js';
import { reconcilePublicAssetGrantsOnce, registerPublicAssetRefProvider, resyncPublicAssetGrantor, __grantorTokensForTest } from '../src/host/assetGrants.js';
import { grantPublicAsset as grantPublicAssetDirect, purgeLegacyGrantRows } from '../src/host/assetAccess.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const T = `org:p1a-${Date.now()}`;
const ORG = 'org-p1a';
let BASE: string;
let server: http.Server;

const anonRead = async (token: string): Promise<number> => (await fetch(`${BASE}/host/openwop-app/assets/${token}`)).status;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60)); // the hooks run on setImmediate
const image = async (): Promise<string> => (await storeMediaAsset(T, { contentBase64: PNG, contentType: 'image/png' })).token;
const pageWith = async (token: string, title: string): Promise<string> =>
  (await createPage({ tenantId: T, orgId: ORG, title, createdBy: 'u1', sections: [{ type: 'image', data: { token, alt: 'a picture' } }] })).pageId;
/** Run the reconcile until both cursors wrap (a few slices at most in a test store). */
const reconcileCycle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await reconcilePublicAssetGrantsOnce(); };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterEach(() => { delete process.env.OPENWOP_ASSET_ACCESS; });
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 1122 P1a — a published page grants its pictures', () => {
  it('draft: refused; published: served; unpublished: refused again', async () => {
    process.env.OPENWOP_ASSET_ACCESS = 'enforce';
    const tok = await image();
    const pageId = await pageWith(tok, 'Grants');
    expect(await anonRead(tok)).toBe(404);
    await transitionPage(T, ORG, pageId, 'publish', 'u1');
    await settle();
    expect(await anonRead(tok)).toBe(200);
    await transitionPage(T, ORG, pageId, 'unpublish', 'u1');
    await settle();
    expect(await anonRead(tok)).toBe(404);
  });

  it('the reconcile backfills a page published while the switch was off, and revokes one unpublished while off', async () => {
    const tok = await image();
    const pageId = await pageWith(tok, 'Backfill');
    process.env.OPENWOP_ASSET_ACCESS = 'off';
    await transitionPage(T, ORG, pageId, 'publish', 'u1'); // no hook runs while off
    await settle();
    process.env.OPENWOP_ASSET_ACCESS = 'enforce';
    expect(await anonRead(tok)).toBe(404);
    await reconcileCycle();
    expect(await anonRead(tok)).toBe(200);

    process.env.OPENWOP_ASSET_ACCESS = 'off';
    await transitionPage(T, ORG, pageId, 'unpublish', 'u1');
    await settle();
    process.env.OPENWOP_ASSET_ACCESS = 'enforce';
    expect(await anonRead(tok)).toBe(200); // the stale grant is still there…
    await reconcileCycle();
    expect(await anonRead(tok)).toBe(404); // …until the row revisit revokes it
  });

  it('a provider that throws keeps the grantor’s existing grants', async () => {
    process.env.OPENWOP_ASSET_ACCESS = 'enforce';
    const tok = await image();
    let fail = false;
    registerPublicAssetRefProvider({
      surface: 'test-flaky',
      tokensFor: async () => { if (fail) throw new Error('store unavailable'); return [tok]; },
      backfillStep: async () => ({ items: [] }),
    });
    expect(await resyncPublicAssetGrantor('test-flaky', T, 'one')).toBe('changed');
    expect(await anonRead(tok)).toBe(200);
    fail = true;
    expect(await resyncPublicAssetGrantor('test-flaky', T, 'one')).toBe('kept');
    expect(await __grantorTokensForTest('test-flaky', 'one')).toEqual([tok]);
    expect(await anonRead(tok)).toBe(200);
  });

  it('finds, reports and deletes P0 token-only grant rows, and leaves P1a rows alone', async () => {
    const storage = hostExtStorage();
    await storage.kvSet('hostext:asset:grant:legacy-token-1', JSON.stringify({ token: 'legacy-token-1', tenantId: T, grantors: ['cms-page:x'] }));
    await grantPublicAssetDirect(T, 'kept-token', 'cms-page:y');
    expect(await purgeLegacyGrantRows(storage)).toBe(1);
    expect(await storage.kvGet('hostext:asset:grant:legacy-token-1')).toBeNull();
    expect(await storage.kvGet(`hostext:asset:grant:${T}|kept-token`)).not.toBeNull();
    expect(await purgeLegacyGrantRows(storage)).toBe(0);
  });

  it('collects the hub’s centre picture', () => {
    const hub: Section = { sectionId: 'sec:h', type: 'hero', data: { hub: { center: { label: 'Core', imageToken: 'tok-hub', alt: 'core' }, spokes: [] } } };
    expect(collectMediaTokens([hub])).toContain('tok-hub');
  });
});
