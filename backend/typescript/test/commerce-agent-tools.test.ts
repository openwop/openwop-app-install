/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT #1) — the commerce chat surfaces are now REAL.
 *
 * Before this port both `vendor.openwop-app.commerce.agents.store-assistant` and
 * `vendor.openwop-app.commerce.buyer.agents.procurement-concierge` allowlisted node typeIds
 * that nothing projected into the tool loop, so each agent dispatched with ZERO
 * callable tools. This boots the REAL app (the ADR 0308 registration seam under
 * test) and asserts: (1) every registered id is offerable + the pack allowlists
 * equal exactly the registered set (the missing "agents have tools" pin); (2) the
 * store reads/draft-quote gate on toggle + org RBAC + acting user; (3) the buyer
 * tools are money-safe — build-cart prepares a capped draft and checkout NEVER
 * completes a purchase (fail-closed cap, then an always-parked human sign-off).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createProduct } from '../src/features/commerce/commerceService.js';
import { getQuote } from '../src/features/commerce/quotes.js';
import { getPurchase } from '../src/features/commerce/ucpBuyer/ucpBuyerService.js';
import {
  COMMERCE_STORE_TOOL_IDS,
  COMMERCE_LIST_PRODUCTS_TOOL_ID,
  COMMERCE_CREATE_QUOTE_TOOL_ID,
} from '../src/features/commerce/agentTools.js';
import {
  COMMERCE_BUYER_TOOL_IDS,
  BUYER_LIST_PURCHASES_TOOL_ID,
  BUYER_BUILD_CART_TOOL_ID,
  BUYER_CHECKOUT_TOOL_ID,
} from '../src/features/commerce/ucpBuyer/agentTools.js';

const TENANT = 'default';
let server: http.Server;
let orgId: string;
let productId: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // Demo mode makes `default` a de-facto-owner tenant, which would admit the
  // non-member below and hide the org RBAC check.
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  const org = await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  orgId = org.orgId;
  const product = await createProduct({ tenantId: TENANT, orgId, createdBy: 'u-1', type: 'physical', name: 'Widget', price: 10, currency: 'USD', inventory: 5 });
  productId = product.productId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status }, 'test');
};
function provider(scope: { actingUserId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}
const parse = (content: string): Record<string, unknown> => JSON.parse(content) as Record<string, unknown>;

// Every case starts from the toggle ON; a case that flips it OFF restores in `finally`
// (no case may pass because an earlier one left the toggle in the state it asserts).
beforeEach(async () => { await setToggle('commerce', 'on'); });

describe('CFP-1 — registration + allowlist parity (the missing "agents have tools" pin)', () => {
  it('every registered commerce agent-tool id is offerable to a model', () => {
    const ids = new Set(builtinAgentToolIds());
    for (const id of [...COMMERCE_STORE_TOOL_IDS, ...COMMERCE_BUYER_TOOL_IDS]) expect(ids.has(id)).toBe(true);
  });

  it('the Store Assistant pack allowlist equals exactly the registered ids', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../packs/vendor.openwop-app.commerce.agents/pack.json', import.meta.url), 'utf8')) as { agents: { toolAllowlist: string[] }[] };
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual([...COMMERCE_STORE_TOOL_IDS].sort());
  });

  it('the Procurement Concierge pack allowlist equals exactly the registered ids', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../packs/vendor.openwop-app.commerce.buyer.agents/pack.json', import.meta.url), 'utf8')) as { agents: { toolAllowlist: string[] }[] };
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual([...COMMERCE_BUYER_TOOL_IDS].sort());
  });
});

describe('CFP-1 — Store Assistant reads gate on toggle + acting user', () => {
  it('list-products returns real catalog rows (toggle on, org RBAC held)', async () => {
    await setToggle('commerce', 'on');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: COMMERCE_LIST_PRODUCTS_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    const body = parse(out.content) as { products: { productId: string }[] };
    expect(body.products.some((p) => p.productId === productId)).toBe(true);
  });

  it('list-products fails EMPTY (a note, not an error) without an acting user', async () => {
    const out = await provider().executeTool({ name: COMMERCE_LIST_PRODUCTS_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(parse(out.content)).toEqual({ note: 'No acting user on this turn — commerce access is resolved per signed-in user.' });
  });

  it('list-products fails EMPTY when the toggle is off', async () => {
    await setToggle('commerce', 'off');
    try {
      const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: COMMERCE_LIST_PRODUCTS_TOOL_ID, input: {} });
      expect(out.isError).toBeFalsy();
      expect(parse(out.content)).toEqual({ note: 'E-Commerce is not enabled for this workspace.' });
    } finally {
      await setToggle('commerce', 'on');
    }
  });

  it('list-products refuses a SAME-tenant non-member of the org (org RBAC, typed not_found)', async () => {
    // The org exists in this tenant; `u-stranger` simply holds no membership in it.
    // A cross-tenant caller would be refused by the tenant lookup first, so it could
    // not witness the scope check.
    const out = await provider({ actingUserId: 'u-stranger' }).executeTool({ name: COMMERCE_LIST_PRODUCTS_TOOL_ID, input: {} });
    expect(out.isError).toBe(true);
    expect(parse(out.content)).toEqual({ error: 'not_found', message: 'Organization not found in this workspace.' });
  });
});

describe('CFP-1 — Store Assistant create-quote (draft-grade action)', () => {
  it('requires a human-initiated turn (typed error)', async () => {
    const out = await provider().executeTool({ name: COMMERCE_CREATE_QUOTE_TOOL_ID, input: { lines: [{ productId, quantity: 1 }] } });
    expect(out.isError).toBe(true);
    expect(parse(out.content).error).toBe('acting_user_required');
  });

  it('fails closed (typed) when the toggle is off', async () => {
    await setToggle('commerce', 'off');
    try {
      const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: COMMERCE_CREATE_QUOTE_TOOL_ID, input: { lines: [{ productId, quantity: 1 }] } });
      expect(out.isError).toBe(true);
      expect(parse(out.content).error).toBe('feature_disabled');
    } finally {
      await setToggle('commerce', 'on');
    }
  });

  it('refuses a SAME-tenant non-member of the org (needs workspace:write)', async () => {
    const out = await provider({ actingUserId: 'u-stranger' }).executeTool({ name: COMMERCE_CREATE_QUOTE_TOOL_ID, input: { lines: [{ productId, quantity: 1 }] } });
    expect(out.isError).toBe(true);
    expect(parse(out.content)).toEqual({ error: 'not_found', message: 'Organization not found in this workspace.' });
  });

  it('drafts a quote in `draft` status (no money moves, not sent)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: COMMERCE_CREATE_QUOTE_TOOL_ID, input: { lines: [{ productId, quantity: 2 }] } });
    expect(out.isError).toBeFalsy();
    const body = parse(out.content) as { quoteId: string; status: string };
    expect(body.quoteId).toMatch(/^qte:/);
    expect(body.status).toBe('draft');
    // Persisted as a DRAFT for this org (read back, not the tool's own echo).
    expect(await getQuote(TENANT, orgId, body.quoteId)).toMatchObject({ status: 'draft', createdBy: 'u-1' });
  });

  it('rejects an empty line set with a typed validation error', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: COMMERCE_CREATE_QUOTE_TOOL_ID, input: { lines: [] } });
    expect(out.isError).toBe(true);
    // The TOOL's own refusal: the service (`quotes.ts` priceLines) throws the same
    // `validation_error` code, so only the message tells the two guards apart.
    expect(parse(out.content)).toEqual({ error: 'validation_error', message: 'Pass at least one line as { productId, quantity }.' });
  });
});

describe('CFP-1 — Procurement Concierge is money-safe (prepare + request only)', () => {
  beforeEach(async () => { await setToggle('commerce-ucp-buyer', 'on'); });

  it('list-purchases fails EMPTY without an acting user', async () => {
    const out = await provider().executeTool({ name: BUYER_LIST_PURCHASES_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(parse(out.content)).toEqual({ note: 'No acting user on this turn — purchase access is resolved per signed-in user.' });
  });

  it('build-cart prepares a capped DRAFT (buys nothing)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: BUYER_BUILD_CART_TOOL_ID,
      input: { merchantUrl: 'https://merchant.example', intent: 'buy one widget', maxAmountMinor: 10000, lines: [{ externalProductId: 'ext-1', name: 'Widget', quantity: 1, unitPriceMinor: 5000 }] },
    });
    expect(out.isError).toBeFalsy();
    const body = parse(out.content) as { purchaseId: string; status: string };
    expect(body.purchaseId).toMatch(/^ucpb:/);
    expect(body.status).toBe('draft');
    expect(await getPurchase(TENANT, orgId, body.purchaseId)).toMatchObject({ status: 'draft', cartMandate: { totalMinor: 5000 } });
  });

  it('checkout is fail-closed when the org spend cap is unset (never buys)', async () => {
    delete process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR;
    const prep = parse((await provider({ actingUserId: 'u-1' }).executeTool({
      name: BUYER_BUILD_CART_TOOL_ID,
      input: { merchantUrl: 'https://merchant.example', intent: 'buy one widget', maxAmountMinor: 10000, lines: [{ externalProductId: 'ext-2', name: 'Widget', quantity: 1, unitPriceMinor: 5000 }] },
    })).content) as { purchaseId: string };
    expect(prep.purchaseId).toMatch(/^ucpb:/); // a real draft, so the refusal below is the cap's
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: BUYER_CHECKOUT_TOOL_ID, input: { purchaseId: prep.purchaseId } });
    expect(out.isError).toBe(true); // fail-closed cap — purchasing not enabled
    // TOC2CD-11 (ADR 1000): a service error's text is the fenced `detail` under a host sentence.
    expect(parse(out.content)).toEqual({ error: 'forbidden', message: 'The tool refused this call; the reason it gave is below.', detail: 'Agent purchasing is not enabled — set OPENWOP_UCP_BUYER_ORG_CAP_MINOR to authorize a spend cap.' });
    const after = await getPurchase(TENANT, orgId, prep.purchaseId);
    expect(after?.status).toBe('draft'); // refused BEFORE the approval gate: nothing parked, nothing bought
    expect(after?.approvalId).toBeUndefined();
  });

  it('checkout REQUESTS a human sign-off (parks approval) and never completes the purchase', async () => {
    process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR = '100000';
    try {
      const prep = parse((await provider({ actingUserId: 'u-1' }).executeTool({
        name: BUYER_BUILD_CART_TOOL_ID,
        input: { merchantUrl: 'https://merchant.example', intent: 'buy one widget', maxAmountMinor: 10000, lines: [{ externalProductId: 'ext-3', name: 'Widget', quantity: 1, unitPriceMinor: 5000 }] },
      })).content) as { purchaseId: string };
      const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: BUYER_CHECKOUT_TOOL_ID, input: { purchaseId: prep.purchaseId } });
      expect(out.isError).toBeFalsy();
      expect(parse(out.content).status).toBe('awaiting_approval');
      // The service parked the approval; the purchase is NOT placed by the tool.
      const after = await getPurchase(TENANT, orgId, prep.purchaseId);
      expect(after?.status).toBe('awaiting_approval');
      expect(after?.approvalId).toBeTruthy();
    } finally {
      delete process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR;
    }
  });

  it('checkout requires a human-initiated turn (typed error)', async () => {
    const out = await provider().executeTool({ name: BUYER_CHECKOUT_TOOL_ID, input: { purchaseId: 'ucpb:whatever' } });
    expect(out.isError).toBe(true);
    expect(parse(out.content).error).toBe('acting_user_required');
  });
});
