/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT #1) — the commerce chat surfaces are now REAL.
 *
 * Before this port both `feature.commerce.agents.store-assistant` and
 * `feature.commerce.buyer.agents.procurement-concierge` allowlisted node typeIds
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createProduct } from '../src/features/commerce/commerceService.js';
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

describe('CFP-1 — registration + allowlist parity (the missing "agents have tools" pin)', () => {
  it('every registered commerce agent-tool id is offerable to a model', () => {
    const ids = new Set(builtinAgentToolIds());
    for (const id of [...COMMERCE_STORE_TOOL_IDS, ...COMMERCE_BUYER_TOOL_IDS]) expect(ids.has(id)).toBe(true);
  });

  it('the Store Assistant pack allowlist equals exactly the registered ids', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../packs/feature.commerce.agents/pack.json', import.meta.url), 'utf8')) as { agents: { toolAllowlist: string[] }[] };
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual([...COMMERCE_STORE_TOOL_IDS].sort());
  });

  it('the Procurement Concierge pack allowlist equals exactly the registered ids', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../packs/feature.commerce.buyer.agents/pack.json', import.meta.url), 'utf8')) as { agents: { toolAllowlist: string[] }[] };
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
    const body = parse(out.content);
    expect(body.products).toBeUndefined();
    expect(typeof body.note).toBe('string');
  });

  it('list-products fails EMPTY when the toggle is off', async () => {
    await setToggle('commerce', 'off');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: COMMERCE_LIST_PRODUCTS_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(parse(out.content).products).toBeUndefined();
    await setToggle('commerce', 'on');
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
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: COMMERCE_CREATE_QUOTE_TOOL_ID, input: { lines: [{ productId, quantity: 1 }] } });
    expect(out.isError).toBe(true);
    expect(parse(out.content).error).toBe('feature_disabled');
    await setToggle('commerce', 'on');
  });

  it('drafts a quote in `draft` status (no money moves, not sent)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: COMMERCE_CREATE_QUOTE_TOOL_ID, input: { lines: [{ productId, quantity: 2 }] } });
    expect(out.isError).toBeFalsy();
    const body = parse(out.content) as { quoteId: string; status: string };
    expect(body.quoteId).toMatch(/^qte:/);
    expect(body.status).toBe('draft');
  });

  it('rejects an empty line set with a typed validation error', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: COMMERCE_CREATE_QUOTE_TOOL_ID, input: { lines: [] } });
    expect(out.isError).toBe(true);
    expect(parse(out.content).error).toBe('validation_error');
  });
});

describe('CFP-1 — Procurement Concierge is money-safe (prepare + request only)', () => {
  beforeAll(async () => { await setToggle('commerce-ucp-buyer', 'on'); });

  it('list-purchases fails EMPTY without an acting user', async () => {
    const out = await provider().executeTool({ name: BUYER_LIST_PURCHASES_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(parse(out.content).purchases).toBeUndefined();
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
  });

  it('checkout is fail-closed when the org spend cap is unset (never buys)', async () => {
    delete process.env.OPENWOP_UCP_BUYER_ORG_CAP_MINOR;
    const prep = parse((await provider({ actingUserId: 'u-1' }).executeTool({
      name: BUYER_BUILD_CART_TOOL_ID,
      input: { merchantUrl: 'https://merchant.example', intent: 'buy one widget', maxAmountMinor: 10000, lines: [{ externalProductId: 'ext-2', name: 'Widget', quantity: 1, unitPriceMinor: 5000 }] },
    })).content) as { purchaseId: string };
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: BUYER_CHECKOUT_TOOL_ID, input: { purchaseId: prep.purchaseId } });
    expect(out.isError).toBe(true); // fail-closed cap — purchasing not enabled
    const after = await getPurchase(TENANT, orgId, prep.purchaseId);
    expect(after?.status).not.toBe('placed');
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
