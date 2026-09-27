/**
 * ADR 0260 — the reference UCP-over-MCP merchant. Validates the ADR 0258 `ucp.<op>` convention
 * END-TO-END against a REAL conformant merchant (not a bespoke test mock): the app's own UCP buyer
 * shops the in-repo reference merchant over the real mcpClient transport + the real dev route,
 * projecting `commerceService`. Also pins the seeder (provider + workspace connection + catalog)
 * and the money-safety invariant (checkout ⇒ a PENDING, unpaid order; the buyer's gates hold).
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { listApprovals, resolveApproval } from '../src/host/approvalService.js';
import { listConnections } from '../src/features/connections/connectionsService.js';
import { getOrder } from '../src/features/commerce/commerceService.js';
import { seedUcpReferenceMerchant, countUcpReferenceMerchant } from '../src/host/ucpReferenceMerchantSeed.js';
import { REF_MERCHANT_TENANT, REF_MERCHANT_ORG, REF_MERCHANT_PROVIDER, handleUcpMerchantRpc } from '../src/features/commerce/ucp/referenceUcpMerchant.js';
import { configureKmsClient, createLocalAesKmsClient } from '../src/byok/kmsEncryption.js';

let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';      // the buyer egresses to the loopback dev route
  process.env.OPENWOP_UCP_REF_MERCHANT_ENABLED = 'true';   // mount the reference-merchant dev route
  process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR = '100000';  // authorize agent buying
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes')); // signed-in secrets need KMS
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'commerce', 'commerce-ucp-buyer', 'connections']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  // Point the seeded merchant provider at THIS app's own dev route (the buyer shops it over loopback).
  process.env.OPENWOP_UCP_REF_MERCHANT_URL = `${BASE}/v1/host/openwop-app/dev/ucp-merchant/mcp`;
});
afterAll(async () => {
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE; delete process.env.OPENWOP_UCP_REF_MERCHANT_ENABLED;
  delete process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR; delete process.env.OPENWOP_UCP_REF_MERCHANT_URL;
  await new Promise<void>((r) => server.close(() => r()));
});

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
async function shopOwner(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `ref-${Date.now()}-${n++}@acme.test` });
  const tenantId: string = r.body.user?.tenantId ?? '';
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Buyer Shop' });
  await seedUcpReferenceMerchant(tenantId); // registers the provider (→ this app's route) + a workspace connection
  return { owner, orgId: org.body.orgId, tenantId };
}
const buyer = (orgId: string, s = ''): string => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/ucp-buyer${s}`;

describe('ADR 0260 — reference UCP-over-MCP merchant', () => {
  it('the buyer validates the full ucp.<op> convention against the reference merchant', async () => {
    const { owner, orgId, tenantId } = await shopOwner();

    // ucp.discover
    const disco = await owner.post(buyer(orgId, '/discover'), { merchantServerId: REF_MERCHANT_PROVIDER });
    expect(disco.status, JSON.stringify(disco.body)).toBe(200);
    expect(disco.body.discovery.ucp).toBe('1.0');
    expect(disco.body.discovery.mode).toBe('demo'); // honestly labelled, never a real payee

    // ucp.search — real projected catalog
    const search = await owner.post(buyer(orgId, '/catalog-search'), { merchantServerId: REF_MERCHANT_PROVIDER, q: 'widget' });
    expect(search.status, JSON.stringify(search.body)).toBe(200);
    const product = search.body.catalog.products.find((p: { name: string }) => /widget/i.test(p.name));
    expect(product, JSON.stringify(search.body)).toBeTruthy();

    // Draft against the reference merchant, using a REAL projected productId + price.
    const draft = await owner.post(buyer(orgId, '/purchases'), {
      merchantServerId: REF_MERCHANT_PROVIDER, intent: 'buy a reference widget', maxAmountMinor: 5000, currency: 'USD',
      lines: [{ externalProductId: product.productId, name: product.name, quantity: 1, unitPriceMinor: Math.round(product.price * 100) }],
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const purchaseId = draft.body.purchaseId;

    // The money gate parks the ALWAYS approval BEFORE the merchant is called.
    const parked = await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`));
    expect(parked.status).toBe(409);
    expect(parked.body.details?.approvalStatus).toBe('pending');

    // Approve → ucp.checkout places a REAL order at the reference merchant.
    const appr = (await listApprovals(tenantId, 'pending')).find((a) => a.spendIdemKey === `ucp-buy:${purchaseId}`);
    expect(appr).toBeDefined();
    await resolveApproval(appr!.approvalId, { status: 'approved' });
    const done = await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe('placed');
    expect(done.body.extOrderId).toBeTruthy();

    // MONEY-SAFETY: the merchant-side order is PENDING and UNPAID (no charge moved).
    const merchantOrder = await getOrder(REF_MERCHANT_TENANT, REF_MERCHANT_ORG, done.body.extOrderId);
    expect(merchantOrder?.status).toBe('pending');

    // ucp.order-status
    const track = await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/track`));
    expect(track.status, JSON.stringify(track.body)).toBe(200);
    expect(track.body.extStatus).toBe('pending');
  });

  it('the seeder registers a workspace connection + the catalog, idempotently', async () => {
    const owner = client();
    const r = await owner.post('/v1/host/openwop-app/test/login', { email: `refseed-${Date.now()}-${n++}@acme.test` });
    const tenantId: string = r.body.user?.tenantId ?? '';
    const first = await seedUcpReferenceMerchant(tenantId);
    expect(first.created).toBe(1);
    const conns = (await listConnections(tenantId)).filter((c) => c.provider === REF_MERCHANT_PROVIDER);
    expect(conns.length).toBe(1);
    expect(conns[0]!.userId).toBeUndefined(); // workspace scope = neither a user nor an org axis
    expect(conns[0]!.orgId).toBeUndefined();
    // Idempotent: a second seed is a no-op.
    expect((await seedUcpReferenceMerchant(tenantId)).created).toBe(0);
    expect(await countUcpReferenceMerchant(tenantId)).toBe(1);
  });

  it('a merchant-side checkout error ⇒ the purchase is DEFINITIVELY "failed" (never the ambiguous "unknown")', async () => {
    // A checkout for a product that does not exist at the merchant: createOrder throws → the
    // merchant returns a JSON-RPC error → the buyer classifies it as mcp_error ⇒ 'failed' (a
    // provably-definitive not-placed outcome — safe to retry, NOT the double-buy-guarding 'unknown').
    const { owner, orgId, tenantId } = await shopOwner();
    const draft = await owner.post(buyer(orgId, '/purchases'), {
      merchantServerId: REF_MERCHANT_PROVIDER, intent: 'buy a phantom', maxAmountMinor: 5000, currency: 'USD',
      lines: [{ externalProductId: 'no-such-product', name: 'Phantom', quantity: 1, unitPriceMinor: 1000 }],
    });
    const purchaseId = draft.body.purchaseId;
    await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`)); // park
    const appr = (await listApprovals(tenantId, 'pending')).find((a) => a.spendIdemKey === `ucp-buy:${purchaseId}`);
    await resolveApproval(appr!.approvalId, { status: 'approved' });
    const failed = await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`));
    expect(failed.status).toBe(502);
    const after = await owner.get(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}`));
    expect(after.body.status).toBe('failed'); // definitive, NOT 'unknown' — the merchant responded without placing
  });

  it('the merchant handler covers its error/edge branches (JSON-RPC contract)', async () => {
    // A non-tools/call method and an unknown tool ⇒ JSON-RPC errors with the id echoed.
    const badMethod = await handleUcpMerchantRpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
    expect(badMethod.error?.code).toBe(-32601);
    expect(badMethod.id).toBe(1);
    const unknownTool = await handleUcpMerchantRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ucp.nope' } });
    expect(unknownTool.error?.code).toBe(-32601);
    // checkout with no usable line ⇒ an invalid-params error (never an empty order).
    const noLines = await handleUcpMerchantRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ucp.checkout', arguments: { lines: [] } } });
    expect(noLines.error?.code).toBe(-32602);
    expect(noLines.result).toBeUndefined();
    // order-status for an unknown order ⇒ a clean { status: 'unknown' } (not an error/throw).
    const missing = await handleUcpMerchantRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ucp.order-status', arguments: { orderId: 'no-such-order' } } });
    expect(missing.result?.status).toBe('unknown');
    // discover is a static, honestly-labelled demo doc.
    const disco = await handleUcpMerchantRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ucp.discover' } });
    expect((disco.result as { ucp: string; mode: string }).ucp).toBe('1.0');
    expect((disco.result as { mode: string }).mode).toBe('demo');
  });
});
