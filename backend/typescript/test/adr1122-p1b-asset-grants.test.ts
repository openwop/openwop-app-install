/**
 * ADR 1122 P1b — commerce, share-link and e-sign grants, read anonymously under
 * `OPENWOP_ASSET_ACCESS=enforce`:
 *  - a listed product's image is served; unlisting or deleting it revokes;
 *  - a live share link of a DRAFT page serves the page's picture; revoking the link
 *    revokes it (a share exposes a page in any status);
 *  - a sign request whose document embeds a picture serves it to the signer before
 *    completion; voiding the request revokes it;
 *  - `assetTokensInValue` finds bare tokens and served URLs, and not ids.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import { assetServeUrl, assetTokensInValue } from '../src/host/assetServePath.js';
import { createOrg } from '../src/host/accessControlService.js';
import { resyncPublicAssetGrantor } from '../src/host/assetGrants.js';
import { createProduct, updateProduct, deleteProduct } from '../src/features/commerce/commerceService.js';
import { createPage } from '../src/features/cms/cmsService.js';
import { createLink, revokeLink } from '../src/features/sharing/sharingService.js';
import { createDocument, addVersion } from '../src/features/documents/documentsService.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let BASE: string;
let server: http.Server;

const anonRead = async (token: string): Promise<number> => (await fetch(`${BASE}/host/openwop-app/assets/${token}`)).status;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 80)); // hooks run on setImmediate
const image = async (tenantId: string): Promise<string> => (await storeMediaAsset(tenantId, { contentBase64: PNG, contentType: 'image/png' })).token;

function client(): { post: (p: string, b?: unknown) => Promise<{ status: number; body: Record<string, unknown> }> } {
  let cookie = '';
  return {
    post: async (path, body) => {
      const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m?.[1]) cookie = m[1]; }
      return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
    },
  };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'documents', 'commerce']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterEach(() => { delete process.env.OPENWOP_ASSET_ACCESS; });
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 1122 P1b — commerce, share links and e-sign grant what they show', () => {
  it('a listed product serves its image; unlisting and deleting revoke it', async () => {
    process.env.OPENWOP_ASSET_ACCESS = 'enforce';
    const T = `org:p1b-shop-${Date.now()}`;
    const tok = await image(T);
    const p = await createProduct({ tenantId: T, orgId: 'org-shop', createdBy: 'u1', type: 'physical', name: 'Mug', price: 1200, currency: 'USD', imageAssetTokens: [tok] });
    await settle();
    expect(await anonRead(tok)).toBe(200);
    await updateProduct(T, 'org-shop', p.productId, { unlisted: true });
    await settle();
    expect(await anonRead(tok)).toBe(404);
    await updateProduct(T, 'org-shop', p.productId, { unlisted: false });
    await settle();
    expect(await anonRead(tok)).toBe(200);
    await deleteProduct(T, 'org-shop', p.productId);
    await settle();
    expect(await anonRead(tok)).toBe(404);
  });

  it('a store the storefront would 404 (commerce off) grants nothing', async () => {
    process.env.OPENWOP_ASSET_ACCESS = 'enforce';
    const T = `org:p1b-off-${Date.now()}`;
    const tok = await image(T);
    const p = await createProduct({ tenantId: T, orgId: 'org-shop', createdBy: 'u1', type: 'physical', name: 'Lamp', price: 900, currency: 'USD', imageAssetTokens: [tok] });
    await settle();
    expect(await anonRead(tok)).toBe(200);
    const d = getToggleDefault('commerce');
    if (d) await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      expect(await resyncPublicAssetGrantor('commerce-product', T, p.productId)).toBe('changed');
      expect(await anonRead(tok)).toBe(404);
    } finally {
      if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });

  it('a live share link of a draft page serves its picture until the link is revoked', async () => {
    process.env.OPENWOP_ASSET_ACCESS = 'enforce';
    const T = `org:p1b-share-${Date.now()}`;
    const org = await createOrg({ tenantId: T, createdBy: 'u1', name: 'Sharer' });
    const tok = await image(T);
    const page = await createPage({ tenantId: T, orgId: org.orgId, title: 'Draft', createdBy: 'u1', sections: [{ type: 'image', data: { token: tok, alt: 'a picture' } }] });
    expect(await anonRead(tok)).toBe(404);
    const link = await createLink(T, org.orgId, 'u1', { resourceType: 'cms_page', resourceId: page.pageId });
    await settle();
    expect(await anonRead(tok)).toBe(200);
    await revokeLink(T, org.orgId, link.token);
    await settle();
    expect(await anonRead(tok)).toBe(404);
  });

  it('a signer reads the document’s picture before completion; voiding revokes it', async () => {
    process.env.OPENWOP_ASSET_ACCESS = 'enforce';
    const owner = client();
    const tenantId = `org:p1b-sign-${Date.now()}`;
    expect((await owner.post('/host/openwop-app/test/login', { email: `p1b-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
    const orgId = String((await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId);
    const tok = await image(tenantId);
    const doc = await createDocument({ tenantId, orgId, title: 'Agreement', kind: 'doc', provenance: { producedBy: { kind: 'user', id: 'u1' } }, createdBy: 'u1' });
    await addVersion(tenantId, orgId, doc.documentId, { content: `# Agreement\n\n![site plan](${assetServeUrl(tok)})\n\nPlease sign.`, producedBy: { kind: 'user', id: 'u1' } });
    const created = await owner.post(`/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/sign-requests`, {
      target: { kind: 'document', id: doc.documentId }, signers: [{ email: 'a@x.test', name: 'Ann', order: 0 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await settle();
    expect(await anonRead(tok)).toBe(200);
    const voided = await owner.post(`/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/sign-requests/${String(created.body.signRequestId)}/void`, {});
    expect(voided.status, JSON.stringify(voided.body)).toBeLessThan(300);
    await settle();
    expect(await anonRead(tok)).toBe(404);
  });

  it('assetTokensInValue finds bare tokens and served URLs, never ids', () => {
    const bare = 'A'.repeat(43);
    const inUrl = 'B'.repeat(43);
    const found = assetTokensInValue({ imageToken: bare, body: `see ${assetServeUrl(inUrl)} here`, id: '123e4567-e89b-12d3-a456-426614174000', nested: [{ n: 5 }] });
    expect(found.sort()).toEqual([bare, inUrl].sort());
  });
});
