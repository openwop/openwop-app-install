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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
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

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  // The sole org auto-resolves; its owner (`u-1`) holds workspace:write.
  await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
});
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
    expect([...packAllowlist('feature.discovery.agents')].sort()).toEqual(
      [DISCOVERY_SEARCH_TOOL_ID, DISCOVERY_LIST_COLLECTIONS_TOOL_ID, DISCOVERY_LIST_RULES_TOOL_ID, DISCOVERY_CREATE_COLLECTION_TOOL_ID, DISCOVERY_CREATE_RULE_TOOL_ID].sort(),
    );
    expect([...packAllowlist('feature.recommendations.agents')].sort()).toEqual(
      [RECOMMENDATIONS_RESOLVE_TOOL_ID, RECOMMENDATIONS_LIST_PLACEMENTS_TOOL_ID, RECOMMENDATIONS_CREATE_PLACEMENT_TOOL_ID].sort(),
    );
    expect([...packAllowlist('feature.promotions.agents')].sort()).toEqual(
      [PROMOTIONS_LIST_TOOL_ID, PROMOTIONS_APPLY_PREVIEW_TOOL_ID, PROMOTIONS_DRAFT_TOOL_ID].sort(),
    );
  });
});

describe('discovery curator tools', () => {
  it('search: read fails EMPTY without an acting user (no system-turn enumeration)', async () => {
    await setFeature('discovery', 'on');
    const out = await provider().executeTool({ name: DISCOVERY_SEARCH_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(parse(out)).toEqual({ productIds: [], facets: [] });
  });

  it('search: toggle-off is a toggle-honest EMPTY read, not an error', async () => {
    await setFeature('discovery', 'off');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: DISCOVERY_SEARCH_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(parse(out)).toEqual({ productIds: [], facets: [] });
    await setFeature('discovery', 'on');
  });

  it('create-collection: write fails TYPED without an acting user', async () => {
    const out = await provider().executeTool({ name: DISCOVERY_CREATE_COLLECTION_TOOL_ID, input: { name: 'Cameras', type: 'dynamic', rule: { categories: ['camera'] } } });
    expect(out.isError).toBe(true);
    expect(parse(out)).toMatchObject({ error: 'acting_user_required' });
  });

  it('create-collection: authors through the service; list-collections then reads it back', async () => {
    const p = provider({ actingUserId: 'u-1', agentProfileId: 'feature.discovery.agents.curator' });
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
    await setFeature('recommendations', 'on');
    const out = await provider().executeTool({ name: RECOMMENDATIONS_RESOLVE_TOOL_ID, input: { slot: 'pdp' } });
    expect(out.isError).toBeFalsy();
    expect(parse(out)).toMatchObject({ products: [], placementId: null });
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
    await setFeature('promotions', 'on');
    const out = await provider().executeTool({ name: PROMOTIONS_LIST_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    expect(parse(out)).toEqual({ promotions: [] });
  });

  it('draft: lands PROPOSED (active:false) — the money-moving firewall', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const out = await p.executeTool({
      name: PROMOTIONS_DRAFT_TOOL_ID,
      input: { name: 'AOV nudge', type: 'cart_threshold', reward: { kind: 'percentage', value: 10 }, minSpend: 100 },
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
    const out = await provider().executeTool({ name: PROMOTIONS_APPLY_PREVIEW_TOOL_ID, input: { items: [{ productId: 'p1', unitPrice: 50, quantity: 3 }] } });
    expect(out.isError).toBeFalsy();
    expect(parse(out)).toEqual({ discount: 0, appliedPromotions: [] });
  });
});
