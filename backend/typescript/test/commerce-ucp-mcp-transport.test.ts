/**
 * ADR 0258 — UCP buyer MCP transport. The buyer reaches an MCP-native merchant (a
 * reach:'mcp' Connection) via the RUNLESS host/mcpClient, invoking `ucp.<op>` tools:
 *  - discover + search over MCP;
 *  - checkout preserves the money gate (cap + ALWAYS approval + CAS) transport-agnostically;
 *    approve → placed over MCP;
 *  - an MCP timeout maps to status 'unknown' (never a blind-retryable 'failed');
 *  - REST path parity is covered by commerce-phase-d.
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
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import { createSecretConnection } from '../src/features/connections/connectionsService.js';
import { checkoutPurchase } from '../src/features/commerce/ucpBuyer/ucpBuyerService.js';
import { configureKmsClient, createLocalAesKmsClient } from '../src/byok/kmsEncryption.js';

let BASE: string; let server: http.Server; let n = 0;
let mcp: http.Server; let MCP_URL = ''; let checkoutMode: 'ok' | 'timeout' | 'badbody' = 'ok';
let rest: http.Server; let REST_URL = ''; let restCheckout: 'httperr' | 'badbody' = 'httperr';
const placed = new Map<string, { status: string }>();

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true'; // loopback mock MCP server
  process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR = '100000'; // $1000 cap — authorize agent buying
  // A REALISTIC budget for the happy paths. This was 300ms — a value that exists purely
  // so the one deliberate-timeout test below finishes fast — applied to every call in the
  // file. An in-process loopback round-trip beats 300ms easily on an idle machine and
  // misses it just as easily when the suite's other ~540 files are competing for the
  // event loop, so `discover` and `search` failed under load with a merchant-timeout 502.
  // The short budget now lives on the ONE test that wants it (`withFetchTimeout`).
  process.env.OPENWOP_UCP_BUYER_FETCH_TIMEOUT_MS = '15000';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes')); // signed-in secrets need KMS
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'commerce-ucp-buyer', 'connections']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }

  // Mock UCP-over-MCP merchant: a JSON-RPC server whose tools/call dispatches on the tool
  // name and returns STRUCTURED JSON as the tool result (the ADR 0258 convention — mcpClient
  // passes a result with no `content` wrapper straight through).
  mcp = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const rpc = JSON.parse(raw) as { id: number; method: string; params: { name?: string; arguments?: Record<string, unknown> } };
      const tool = rpc.params?.name;
      if (rpc.method === 'tools/call' && tool === 'ucp.checkout' && checkoutMode === 'timeout') { return; /* never respond → client times out */ }
      if (rpc.method === 'tools/call' && tool === 'ucp.checkout' && checkoutMode === 'badbody') {
        // Responds (NOT a timeout) but the body is unparseable → mcpClient throws mcp_bad_response.
        // The merchant MAY have placed before the reply garbled, so this must be AMBIGUOUS.
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end('}{ not json at all');
      }
      let result: unknown = {};
      if (rpc.method === 'tools/call') {
        if (tool === 'ucp.discover') result = { ucp: '1.0', vertical: 'shopping' };
        else if (tool === 'ucp.search') result = { products: [{ productId: 'mcp-1', name: 'MCP Widget', price: 12, currency: 'USD' }] };
        else if (tool === 'ucp.checkout') { const id = `mcp-ord-${placed.size + 1}`; placed.set(id, { status: 'pending' }); result = { orderId: id }; }
        else if (tool === 'ucp.order-status') result = { status: placed.get(String(rpc.params?.arguments?.orderId))?.status ?? 'pending' };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
  });
  await new Promise<void>((r) => { mcp.listen(0, '127.0.0.1', () => { MCP_URL = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`; r(); }); });

  // Mock REST merchant — used ONLY to exercise the REST-side money-classification (the MCP
  // tests above cover the MCP side). `restCheckout` toggles the failure mode at /checkout.
  rest = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'POST' && path === '/checkout') {
      if (restCheckout === 'httperr') { res.writeHead(402, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'payment_declined' })); }
      // A 200 with a body that fails JSON parse → merchantFetch throws 'invalid response' (no
      // status) → AMBIGUOUS: the merchant answered 200 and may have placed before the body broke.
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end('}{ not json');
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => { rest.listen(0, '127.0.0.1', () => { REST_URL = `http://127.0.0.1:${(rest.address() as AddressInfo).port}`; r(); }); });
  // Register the merchant as a reach:'mcp' provider + a WORKSPACE credential (resolves for
  // any acting user — the runless/agent posture).
  registerProvider({ id: 'mcpmerchant', label: 'MCP Merchant', kind: 'bearer', authFlow: 'none', reach: 'mcp', scopes: { read: [] }, refreshable: false, defaultScopes: [], consumerNodes: ['core.openwop.mcp'], mcpServer: { url: MCP_URL, transport: 'http' } });
  // A SECOND merchant used only to prove the D2 confused-deputy posture: an autonomous agent
  // must NOT be able to spend through an ORG-scoped credential (a human's authority).
  registerProvider({ id: 'mcpmerchant-orgonly', label: 'Org-only MCP Merchant', kind: 'bearer', authFlow: 'none', reach: 'mcp', scopes: { read: [] }, refreshable: false, defaultScopes: [], consumerNodes: ['core.openwop.mcp'], mcpServer: { url: MCP_URL, transport: 'http' } });
});
afterAll(async () => {
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE; delete process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR; delete process.env.OPENWOP_UCP_BUYER_FETCH_TIMEOUT_MS;
  await new Promise<void>((r) => mcp.close(() => r()));
  await new Promise<void>((r) => rest.close(() => r()));
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
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `mcp-${Date.now()}-${n++}@acme.test` });
  const tenantId: string = r.body.user?.tenantId ?? '';
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Shop' });
  // A workspace-scoped merchant credential for THIS tenant (resolves for any actor).
  await createSecretConnection({ tenantId, provider: 'mcpmerchant', kind: 'bearer', secret: 'mcp-token', scope: 'workspace' });
  return { owner, orgId: org.body.orgId, tenantId };
}
const buyer = (orgId: string, s = ''): string => `/v1/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/ucp-buyer${s}`;

describe('ADR 0258 — UCP buyer over MCP', () => {
  it('discovers + searches an MCP merchant, then places a purchase through the money gate', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    checkoutMode = 'ok';
    // Discover + search over MCP (no merchantUrl — a serverId).
    const disco = await owner.post(buyer(orgId, '/discover'), { merchantServerId: 'mcpmerchant' });
    expect(disco.status, JSON.stringify(disco.body)).toBe(200);
    expect(disco.body.discovery.ucp).toBe('1.0');
    const search = await owner.post(buyer(orgId, '/catalog-search'), { merchantServerId: 'mcpmerchant', q: 'widget' });
    expect(search.body.catalog.products[0].productId).toBe('mcp-1');

    // Draft a purchase against the MCP merchant.
    const draft = await owner.post(buyer(orgId, '/purchases'), { merchantServerId: 'mcpmerchant', intent: 'buy a widget', maxAmountMinor: 5000, currency: 'USD', lines: [{ externalProductId: 'mcp-1', name: 'MCP Widget', quantity: 1, unitPriceMinor: 1200 }] });
    expect(draft.status).toBe(201);
    expect(draft.body.merchantServerId).toBe('mcpmerchant');
    const purchaseId = draft.body.purchaseId;

    // Checkout FIRST parks the ALWAYS approval (money gate is transport-agnostic).
    const parked = await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`));
    expect(parked.status).toBe(409);
    expect(parked.body.details?.approvalStatus).toBe('pending');
    expect(placed.size).toBe(0); // NOT placed — gate held it

    // Approve → checkout places over MCP.
    const appr = (await listApprovals(tenantId, 'pending')).find((a) => a.spendIdemKey === `ucp-buy:${purchaseId}`);
    expect(appr).toBeDefined();
    await resolveApproval(appr!.approvalId, { status: 'approved' });
    const done = await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe('placed');
    expect(done.body.extOrderId).toMatch(/^mcp-ord-/);
    expect(placed.size).toBe(1);

    // Track over MCP.
    const track = await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/track`));
    expect(track.body.extStatus).toBe('pending');
  });

  it('an MCP timeout at checkout ⇒ status "unknown" (never a blind-retryable "failed")', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    const draft = await owner.post(buyer(orgId, '/purchases'), { merchantServerId: 'mcpmerchant', intent: 'buy', maxAmountMinor: 5000, currency: 'USD', lines: [{ externalProductId: 'mcp-1', name: 'W', quantity: 1, unitPriceMinor: 1000 }] });
    const purchaseId = draft.body.purchaseId;
    await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`)); // park
    const appr = (await listApprovals(tenantId, 'pending')).find((a) => a.spendIdemKey === `ucp-buy:${purchaseId}`);
    await resolveApproval(appr!.approvalId, { status: 'approved' });
    // try/finally: this test deliberately induces a hang, and both knobs are FILE-scoped.
    // Without the finally an assertion failure here leaves `checkoutMode = 'timeout'` and
    // a 300ms budget set for every later test in the file — one real failure would cascade
    // into several unrelated ones, and the loudest red would not be the actual defect.
    const priorTimeout = process.env.OPENWOP_UCP_BUYER_FETCH_TIMEOUT_MS;
    checkoutMode = 'timeout';
    process.env.OPENWOP_UCP_BUYER_FETCH_TIMEOUT_MS = '300'; // only this test wants a short one
    try {
      const timedOut = await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`));
      expect(timedOut.status).toBe(502);
      const after = await owner.get(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}`));
      expect(after.body.status).toBe('unknown'); // NOT 'failed' — a timeout is ambiguous
    } finally {
      checkoutMode = 'ok';
      if (priorTimeout === undefined) delete process.env.OPENWOP_UCP_BUYER_FETCH_TIMEOUT_MS;
      else process.env.OPENWOP_UCP_BUYER_FETCH_TIMEOUT_MS = priorTimeout;
    }
  });

  it('an MCP post-send read failure (bad/garbled response) ⇒ "unknown", NOT "failed" (default-ambiguous)', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    const draft = await owner.post(buyer(orgId, '/purchases'), { merchantServerId: 'mcpmerchant', intent: 'buy', maxAmountMinor: 5000, currency: 'USD', lines: [{ externalProductId: 'mcp-1', name: 'W', quantity: 1, unitPriceMinor: 1000 }] });
    const purchaseId = draft.body.purchaseId;
    await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`)); // park
    const appr = (await listApprovals(tenantId, 'pending')).find((a) => a.spendIdemKey === `ucp-buy:${purchaseId}`);
    await resolveApproval(appr!.approvalId, { status: 'approved' });
    checkoutMode = 'badbody';
    const failed = await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`));
    expect(failed.status).toBe(502);
    const after = await owner.get(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}`));
    // A garbled reply is post-send: the merchant may already have placed → must block a blind retry.
    expect(after.body.status).toBe('unknown');
    checkoutMode = 'ok';
  });

  it('REST money-classification: a definitive HTTP status ⇒ "failed"; a garbled 200 body ⇒ "unknown"', async () => {
    // Parity with the MCP cases, over REST. Proves the STRUCTURED classifier (err.details.status):
    // an HTTP status = the merchant responded without placing ⇒ safe to retry; a 200 with a broken
    // body = it answered and MAY have placed ⇒ ambiguous.
    const place = async (): Promise<string> => {
      const { owner, orgId, tenantId } = await shopOwner();
      const draft = await owner.post(buyer(orgId, '/purchases'), { merchantUrl: REST_URL, intent: 'buy', maxAmountMinor: 5000, currency: 'USD', lines: [{ externalProductId: 'r-1', name: 'W', quantity: 1, unitPriceMinor: 1000 }] });
      const purchaseId = draft.body.purchaseId;
      await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`)); // park
      const appr = (await listApprovals(tenantId, 'pending')).find((a) => a.spendIdemKey === `ucp-buy:${purchaseId}`);
      await resolveApproval(appr!.approvalId, { status: 'approved' });
      const done = await owner.post(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}/checkout`));
      expect(done.status).toBe(502);
      return (await owner.get(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}`))).body.status as string;
    };
    restCheckout = 'httperr';
    expect(await place()).toBe('failed'); // merchant returned 402 — definitive, safe to retry
    restCheckout = 'badbody';
    expect(await place()).toBe('unknown'); // 200 + garbled body — post-send, may have placed
    restCheckout = 'httperr';
  });

  // ── D2 confused-deputy on the money path (ADR 0258 §Identity) ─────────────────────────
  // Drive the PURE AGENT path (the node-surface identity): `checkoutPurchase(..., {actor:'agent'})`
  // — no acting user — exactly as `surface.ts` ucpCheckout calls it. `actingUserOf` strips the
  // 'agent' sentinel so no `actingUserId` reaches the credential resolver.
  async function agentPlace(owner: ReturnType<typeof client>, tenantId: string, orgId: string, serverId: string): Promise<{ threw: boolean; status: string }> {
    const draft = await owner.post(buyer(orgId, '/purchases'), { merchantServerId: serverId, intent: 'buy', maxAmountMinor: 5000, currency: 'USD', lines: [{ externalProductId: 'x', name: 'W', quantity: 1, unitPriceMinor: 1000 }] });
    const purchaseId = draft.body.purchaseId as string;
    await checkoutPurchase(tenantId, orgId, purchaseId, { actor: 'agent' }).catch(() => undefined); // parks the ALWAYS approval
    const appr = (await listApprovals(tenantId, 'pending')).find((a) => a.spendIdemKey === `ucp-buy:${purchaseId}`);
    await resolveApproval(appr!.approvalId, { status: 'approved' });
    let threw = false;
    await checkoutPurchase(tenantId, orgId, purchaseId, { actor: 'agent' }).catch(() => { threw = true; });
    const after = await owner.get(buyer(orgId, `/purchases/${encodeURIComponent(purchaseId)}`));
    return { threw, status: after.body.status as string };
  }

  it('an autonomous AGENT cannot spend through an ORG-scoped merchant credential (confused-deputy denied, fail-closed)', async () => {
    const { owner, orgId, tenantId } = await shopOwner();
    // The ONLY credential for this merchant is ORG-scoped (a human's authority — needs
    // connections:use, which an agent has no way to hold). No workspace credential exists.
    await createSecretConnection({ tenantId, provider: 'mcpmerchant-orgonly', kind: 'bearer', secret: 'org-token', scope: 'org', orgId });
    const before = placed.size;
    checkoutMode = 'ok'; // the merchant WOULD place — but the agent never gets a credential to reach it
    const { threw, status } = await agentPlace(owner, tenantId, orgId, 'mcpmerchant-orgonly');
    expect(threw).toBe(true);
    // Withheld credential = the request never egressed = DEFINITIVE ⇒ 'failed' (safe), NOT 'unknown'.
    expect(status).toBe('failed');
    expect(placed.size).toBe(before); // nothing was ordered at the merchant
  });

  it('an autonomous AGENT CAN spend through a WORKSPACE-scoped merchant credential (the intended service identity)', async () => {
    const { owner, orgId, tenantId } = await shopOwner(); // shopOwner registers a WORKSPACE cred for 'mcpmerchant'
    checkoutMode = 'ok';
    const { threw, status } = await agentPlace(owner, tenantId, orgId, 'mcpmerchant');
    expect(threw).toBe(false);
    expect(status).toBe('placed'); // the agent resolves the workspace credential and places
  });

  it('rejects a draft that sets BOTH merchantUrl and merchantServerId', async () => {
    const { owner, orgId } = await shopOwner();
    const bad = await owner.post(buyer(orgId, '/discover'), { merchantUrl: 'https://m.test', merchantServerId: 'mcpmerchant' });
    expect(bad.status).toBe(400);
  });
});
