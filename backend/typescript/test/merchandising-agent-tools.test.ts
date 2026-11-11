/**
 * CFP-1 (CHAT-FIRST-PORT-AUDIT #1, unit E8 / merchandising) — the Discovery
 * Curator, Merchandiser, and Promotions Manager agents now have REAL
 * conversational tools instead of allowlisted node typeIds no provider resolves.
 *
 * The exchange contract under test: each tool registers into the live builtin
 * surface (so dispatch can offer it), shares the routes' access predicate
 * (toggle + org RBAC), fails EMPTY on a read without an acting user / a foreign
 * org, fails TYPED on a write without an acting user, and drives the SAME
 * service the REST routes use. Boots the REAL app — the ADR 0308 D2 registration
 * seam is what's under test.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds, builtinAgentTool } from '../src/host/agentToolProvider.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createProduct } from '../src/features/commerce/commerceService.js';
import { createPromotion } from '../src/features/promotions/promotionsService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import {
  DISCOVERY_SEARCH_TOOL_ID, DISCOVERY_LIST_COLLECTIONS_TOOL_ID, DISCOVERY_LIST_RULES_TOOL_ID,
  DISCOVERY_CREATE_COLLECTION_TOOL_ID, DISCOVERY_CREATE_RULE_TOOL_ID,
} from '../src/features/discovery/agentTools.js';
import {
  RECOMMENDATIONS_RESOLVE_TOOL_ID, RECOMMENDATIONS_LIST_PLACEMENTS_TOOL_ID, RECOMMENDATIONS_CREATE_PLACEMENT_TOOL_ID,
} from '../src/features/recommendations/agentTools.js';
import {
  PROMOTIONS_LIST_TOOL_ID, PROMOTIONS_APPLY_PREVIEW_TOOL_ID, PROMOTIONS_DRAFT_TOOL_ID,
} from '../src/features/promotions/agentTools.js';

const TENANT = 'default';
let ORG = '';
let seq = 0;

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  // The sole org auto-resolves; its owner (`u-1`) holds workspace:write.
  ORG = (await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' })).orgId;
});

// Every case starts with every feature it touches ON — cases used to inherit a
// toggle another case had switched, which made them order-dependent.
beforeEach(async () => {
  for (const id of ['discovery', 'recommendations', 'promotions', 'commerce']) await setFeature(id, 'on');
});

/** A product only this case created, so a non-empty read is this case's own row. */
const seedProduct = async (): Promise<string> =>
  (await createProduct({ tenantId: TENANT, orgId: ORG, createdBy: 'u-1', type: 'physical', name: `Seeded camera ${seq++}`, price: 120, currency: 'USD', categories: ['camera'] })).productId;
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setFeature = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status }, 'test');
};
function provider(scope: { actingUserId?: string; agentProfileId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}
const parse = (out: { content: string }) => JSON.parse(out.content) as Record<string, unknown>;

const ALL_IDS = [
  DISCOVERY_SEARCH_TOOL_ID, DISCOVERY_LIST_COLLECTIONS_TOOL_ID, DISCOVERY_LIST_RULES_TOOL_ID,
  DISCOVERY_CREATE_COLLECTION_TOOL_ID, DISCOVERY_CREATE_RULE_TOOL_ID,
  RECOMMENDATIONS_RESOLVE_TOOL_ID, RECOMMENDATIONS_LIST_PLACEMENTS_TOOL_ID, RECOMMENDATIONS_CREATE_PLACEMENT_TOOL_ID,
  PROMOTIONS_LIST_TOOL_ID, PROMOTIONS_APPLY_PREVIEW_TOOL_ID, PROMOTIONS_DRAFT_TOOL_ID,
];

describe('merchandising agent tools — registration + pack allowlist parity', () => {
  it('every tool registers into the builtin surface (dispatch can offer it)', () => {
    const ids = new Set(builtinAgentToolIds());
    for (const id of ALL_IDS) expect(ids).toContain(id);
  });

  const packAllowlist = (dir: string): string[] => {
    const manifest = JSON.parse(readFileSync(new URL(`../../../packs/${dir}/pack.json`, import.meta.url), 'utf8')) as { agents: { toolAllowlist: string[] }[] };
    return manifest.agents[0]!.toolAllowlist;
  };

  it('each pack allowlist is EXACTLY the registered tool ids (no phantom entries)', () => {
    expect([...packAllowlist('vendor.openwop-app.discovery.agents')].sort()).toEqual(
      [DISCOVERY_SEARCH_TOOL_ID, DISCOVERY_LIST_COLLECTIONS_TOOL_ID, DISCOVERY_LIST_RULES_TOOL_ID, DISCOVERY_CREATE_COLLECTION_TOOL_ID, DISCOVERY_CREATE_RULE_TOOL_ID].sort(),
    );
    expect([...packAllowlist('vendor.openwop-app.recommendations.agents')].sort()).toEqual(
      [RECOMMENDATIONS_RESOLVE_TOOL_ID, RECOMMENDATIONS_LIST_PLACEMENTS_TOOL_ID, RECOMMENDATIONS_CREATE_PLACEMENT_TOOL_ID].sort(),
    );
    expect([...packAllowlist('vendor.openwop-app.promotions.agents')].sort()).toEqual(
      [PROMOTIONS_LIST_TOOL_ID, PROMOTIONS_APPLY_PREVIEW_TOOL_ID, PROMOTIONS_DRAFT_TOOL_ID].sort(),
    );
  });
});

describe('discovery curator tools', () => {
  it('search: read fails EMPTY without an acting user (no system-turn enumeration)', async () => {
    const pid = await seedProduct();
    // Positive control: the same read WITH the acting user sees the product, so
    // the empty answer below is the gate, not an empty catalog.
    const withUser = await provider({ actingUserId: 'u-1' }).executeTool({ name: DISCOVERY_SEARCH_TOOL_ID, input: {} });
    expect(parse(withUser).productIds).toContain(pid);
    const out = await provider().executeTool({ name: DISCOVERY_SEARCH_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(parse(out)).toEqual({ productIds: [], facets: [] });
  });

  it('search: a FOREIGN org is an EMPTY read, not an error or a leak', async () => {
    const pid = await seedProduct();
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: DISCOVERY_SEARCH_TOOL_ID, input: { orgId: 'org-not-in-this-workspace' } });
    expect(out.isError).toBeFalsy();
    expect(parse(out)).toEqual({ productIds: [], facets: [] });
    // Control: the caller's own org sees it.
    const own = await provider({ actingUserId: 'u-1' }).executeTool({ name: DISCOVERY_SEARCH_TOOL_ID, input: { orgId: ORG } });
    expect(parse(own).productIds).toContain(pid);
  });

  it('search: toggle-off is a toggle-honest EMPTY read, not an error', async () => {
    const pid = await seedProduct();
    const on = await provider({ actingUserId: 'u-1' }).executeTool({ name: DISCOVERY_SEARCH_TOOL_ID, input: {} });
    expect(parse(on).productIds).toContain(pid); // the catalog is NOT empty
    await setFeature('discovery', 'off');
    try {
      const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: DISCOVERY_SEARCH_TOOL_ID, input: {} });
      expect(out.isError).toBeFalsy();
      expect(parse(out)).toEqual({ productIds: [], facets: [] });
    } finally {
      await setFeature('discovery', 'on');
    }
  });

  it('create-collection: write fails TYPED without an acting user', async () => {
    const out = await provider().executeTool({ name: DISCOVERY_CREATE_COLLECTION_TOOL_ID, input: { name: 'Cameras', type: 'dynamic', rule: { categories: ['camera'] } } });
    expect(out.isError).toBe(true);
    expect(parse(out)).toMatchObject({ error: 'acting_user_required' });
  });

  it('create-collection: authors through the service; list-collections then reads it back', async () => {
    const p = provider({ actingUserId: 'u-1', agentProfileId: 'vendor.openwop-app.discovery.agents.curator' });
    const created = await p.executeTool({ name: DISCOVERY_CREATE_COLLECTION_TOOL_ID, input: { name: 'Cameras', type: 'dynamic', rule: { categories: ['camera'] } } });
    expect(created.isError).toBeFalsy();
    const cid = parse(created).collectionId as string;
    expect(cid).toBeTruthy();
    const list = await p.executeTool({ name: DISCOVERY_LIST_COLLECTIONS_TOOL_ID, input: {} });
    const collections = parse(list).collections as { collectionId: string }[];
    expect(collections.some((c) => c.collectionId === cid)).toBe(true);
  });

  it('create-collection: invalid input is a TYPED validation error (the repair signal), never success-empty', async () => {
    // A dynamic collection with no rule is rejected by the service's closed-world validation.
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: DISCOVERY_CREATE_COLLECTION_TOOL_ID, input: { name: 'Bad', type: 'dynamic' } });
    expect(out.isError).toBe(true);
    expect(parse(out)).toMatchObject({ error: 'validation_error' });
  });

  it('create-rule: lands as a PROPOSAL (inactive) — a model turn never hides inventory live (ADR 1025 D5)', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const out = await p.executeTool({ name: DISCOVERY_CREATE_RULE_TOOL_ID, input: { name: `Hide clearance ${seq++}`, actions: [{ kind: 'hide', predicate: { categories: ['clearance'] } }] } });
    expect(out.isError).toBeFalsy();
    expect(parse(out)).toMatchObject({ active: false, proposed: true });
    const rules = parse(await p.executeTool({ name: DISCOVERY_LIST_RULES_TOOL_ID, input: {} })).rules as { ruleId: string; active: boolean }[];
    expect(rules.find((r) => r.ruleId === parse(out).ruleId)?.active).toBe(false);
  });

  it('create-rule: a rule with no actions is a TYPED validation error', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: DISCOVERY_CREATE_RULE_TOOL_ID, input: { name: 'Empty', actions: [] } });
    expect(out.isError).toBe(true);
    expect(parse(out)).toMatchObject({ error: 'validation_error' });
    // And list-rules reads (empty is fine).
    const list = await provider({ actingUserId: 'u-1' }).executeTool({ name: DISCOVERY_LIST_RULES_TOOL_ID, input: {} });
    expect(list.isError).toBeFalsy();
  });
});

describe('recommendations merchandiser tools', () => {
  it('resolve: read fails EMPTY without an acting user', async () => {
    // Positive control: a configured slot resolves to its placement for u-1.
    const created = await provider({ actingUserId: 'u-1' }).executeTool({ name: RECOMMENDATIONS_CREATE_PLACEMENT_TOOL_ID, input: { slot: 'pdp', source: 'upsell' } });
    expect(created.isError).toBeFalsy();
    const withUser = await provider({ actingUserId: 'u-1' }).executeTool({ name: RECOMMENDATIONS_RESOLVE_TOOL_ID, input: { slot: 'pdp' } });
    expect(parse(withUser).placementId).toBeTruthy();
    const out = await provider().executeTool({ name: RECOMMENDATIONS_RESOLVE_TOOL_ID, input: { slot: 'pdp' } });
    expect(out.isError).toBeFalsy();
    expect(parse(out)).toEqual({ products: [], placementId: null });
  });

  it('resolve: an invalid slot is a TYPED validation error', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: RECOMMENDATIONS_RESOLVE_TOOL_ID, input: { slot: 'nowhere' } });
    expect(out.isError).toBe(true);
    expect(parse(out)).toMatchObject({ error: 'validation_error' });
  });

  it('create-placement: authors through the service; list-placements reads it back', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = await p.executeTool({ name: RECOMMENDATIONS_CREATE_PLACEMENT_TOOL_ID, input: { slot: 'cart', source: 'cross_sell', holdoutPct: 10 } });
    expect(created.isError).toBeFalsy();
    const pid = parse(created).placementId as string;
    const list = await p.executeTool({ name: RECOMMENDATIONS_LIST_PLACEMENTS_TOOL_ID, input: {} });
    const placements = parse(list).placements as { placementId: string; slot: string; source: string }[];
    expect(placements.some((x) => x.placementId === pid && x.slot === 'cart' && x.source === 'cross_sell')).toBe(true);
  });

  it('create-placement: an invalid source is a TYPED validation error', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: RECOMMENDATIONS_CREATE_PLACEMENT_TOOL_ID, input: { slot: 'cart', source: 'bogus' } });
    expect(out.isError).toBe(true);
    expect(parse(out)).toMatchObject({ error: 'validation_error' });
  });
});

describe('promotions manager tools', () => {
  it('list: read fails EMPTY without an acting user', async () => {
    const drafted = await provider({ actingUserId: 'u-1' }).executeTool({
      name: PROMOTIONS_DRAFT_TOOL_ID,
      input: { name: `Seeded ${seq++}`, type: 'cart_threshold', reward: { kind: 'percentage', value: 5 }, minSpend: 10, currency: 'USD' },
    });
    expect(drafted.isError).toBeFalsy();
    // Positive control: u-1 sees the draft, so EMPTY below is the gate.
    const withUser = await provider({ actingUserId: 'u-1' }).executeTool({ name: PROMOTIONS_LIST_TOOL_ID, input: {} });
    expect((parse(withUser).promotions as { promotionId: string }[]).map((x) => x.promotionId)).toContain(parse(drafted).promotionId);
    const out = await provider().executeTool({ name: PROMOTIONS_LIST_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(parse(out)).toEqual({ promotions: [] });
  });

  it('draft: lands PROPOSED (active:false) — the money-moving firewall', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const out = await p.executeTool({
      name: PROMOTIONS_DRAFT_TOOL_ID,
      input: { name: 'AOV nudge', type: 'cart_threshold', reward: { kind: 'percentage', value: 10 }, minSpend: 100, currency: 'USD' },
    });
    expect(out.isError).toBeFalsy();
    const res = parse(out);
    expect(res.active).toBe(false);
    expect(res.proposed).toBe(true);
    // It appears in list — and it is NOT active (no chat path activates it).
    const list = await p.executeTool({ name: PROMOTIONS_LIST_TOOL_ID, input: {} });
    const promos = parse(list).promotions as { promotionId: string; active: boolean }[];
    const drafted = promos.find((x) => x.promotionId === res.promotionId);
    expect(drafted?.active).toBe(false);
  });

  it('draft: the schema carries `currency`, and a denominated draft without one is a TYPED refusal (ADR 1025 D4)', async () => {
    const props = (builtinAgentTool(PROMOTIONS_DRAFT_TOOL_ID)?.def.inputSchema as { properties?: Record<string, { enum?: string[] }> } | undefined)?.properties ?? {};
    expect(props.currency?.enum).toContain('USD');
    const p = provider({ actingUserId: 'u-1' });
    const refused = await p.executeTool({ name: PROMOTIONS_DRAFT_TOOL_ID, input: { name: `Ten off ${seq++}`, type: 'cart_threshold', reward: { kind: 'fixed', value: 10 }, minSpend: 50 } });
    expect(refused.isError).toBe(true);
    expect(parse(refused)).toMatchObject({ error: 'validation_error' });
    // The service's own refusal text (field `currency`), not any message mentioning money.
    expect(JSON.stringify(parse(refused))).toMatch(/so it needs a `currency`/);
    const ok = await p.executeTool({ name: PROMOTIONS_DRAFT_TOOL_ID, input: { name: `Ten off ${seq++}`, type: 'cart_threshold', reward: { kind: 'fixed', value: 10 }, minSpend: 50, currency: 'EUR' } });
    expect(ok.isError).toBeFalsy();
    const listed = parse(await p.executeTool({ name: PROMOTIONS_LIST_TOOL_ID, input: {} })).promotions as { promotionId: string; currency?: string; needsCurrency?: true }[];
    expect(listed.find((x) => x.promotionId === parse(ok).promotionId)?.currency).toBe('EUR');
    // A legacy currency-less row (planted: intake now refuses it) is flagged to the model.
    const raw = new DurableCollection<Record<string, unknown> & { promotionId: string; tenantId: string }>('promotions:promo', (r) => r.promotionId, undefined, (r) => r.tenantId);
    const now = new Date().toISOString();
    await raw.put({ promotionId: `promo:legacy-chat-${seq++}`, tenantId: TENANT, orgId: ORG, name: 'Legacy', type: 'cart_threshold', reward: { kind: 'fixed', value: 10 }, minSpend: 60, priority: 0, stackable: true, active: true, createdBy: 'demo:merch', createdAt: now, updatedAt: now });
    const again = parse(await p.executeTool({ name: PROMOTIONS_LIST_TOOL_ID, input: {} })).promotions as { name: string; needsCurrency?: true }[];
    expect(again.find((x) => x.name === 'Legacy')?.needsCurrency).toBe(true);
    expect(again.find((x) => x.name !== 'Legacy' && x.needsCurrency)).toBeUndefined();
  });

  it('draft: a loss_leader without a budget cap is a TYPED validation error', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: PROMOTIONS_DRAFT_TOOL_ID,
      input: { name: 'Below cost', type: 'loss_leader', reward: { kind: 'percentage', value: 90 } },
    });
    expect(out.isError).toBe(true);
    expect(parse(out)).toMatchObject({ error: 'validation_error' });
  });

  it('draft: write fails TYPED without an acting user', async () => {
    const out = await provider().executeTool({ name: PROMOTIONS_DRAFT_TOOL_ID, input: { name: 'X', type: 'cart_threshold', reward: { kind: 'percentage', value: 5 } } });
    expect(out.isError).toBe(true);
    expect(parse(out)).toMatchObject({ error: 'acting_user_required' });
  });

  it('apply-preview: read fails EMPTY without an acting user', async () => {
    // An ACTIVE promotion that fires on this cart (150 ≥ 100 → 10%), so u-1's
    // preview is non-zero and the user-less zero below is the gate.
    await createPromotion({ tenantId: TENANT, orgId: ORG, createdBy: 'u-1', name: `Live ${seq++}`, type: 'cart_threshold', reward: { kind: 'percentage', value: 10 }, minSpend: 100, currency: 'USD', active: true });
    const items = [{ productId: 'p1', unitPrice: 50, quantity: 3 }];
    const withUser = await provider({ actingUserId: 'u-1' }).executeTool({ name: PROMOTIONS_APPLY_PREVIEW_TOOL_ID, input: { items } });
    expect(parse(withUser).discount).toBeGreaterThan(0);
    const out = await provider().executeTool({ name: PROMOTIONS_APPLY_PREVIEW_TOOL_ID, input: { items } });
    expect(out.isError).toBeFalsy();
    expect(parse(out)).toEqual({ discount: 0, appliedPromotions: [] });
  });
});
