/**
 * Merchandising node + agent packs (ADR 0273/0274/0275 + ADR 0058 chat-drivability, PR 1):
 *   - node manifests declare the expected typeIds, all role:'action' (recorded → replay-safe
 *     over the mutable recs cache / catalog, per the /architect review);
 *   - each node handler delegates to the ctx.features.<id> surface (pass-through), validates
 *     its inputs, and fails with host_capability_missing when the surface is absent;
 *   - the /architect finding-1 invariant: an AGENT-authored promotion lands PROPOSED
 *     (active:false) — money-moving, so never auto-live;
 *   - the three agent packs load with tool-allowlists scoped to their own feature nodes.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodes as recoNodes } from '../../../packs/feature.recommendations.nodes/index.mjs';
import { nodes as promoNodes } from '../../../packs/feature.promotions.nodes/index.mjs';
import { nodes as discNodes } from '../../../packs/feature.discovery.nodes/index.mjs';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { buildPromotionsSurface } from '../src/features/promotions/surface.js';
import { getPromotion, __resetPromotions } from '../src/features/promotions/promotionsService.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const packDir = (n: string): string => join(REPO_ROOT, 'packs', n);
interface Manifest { name: string; version: string; nodes: { typeId: string; role: string }[] }
const manifest = (n: string): Manifest => JSON.parse(readFileSync(join(packDir(n), 'pack.json'), 'utf8')) as Manifest;

describe('merchandising node pack manifests', () => {
  it('declare the expected nodes, all role:action (recorded → replay-safe)', () => {
    const cases: [string, string[]][] = [
      ['feature.recommendations.nodes', ['feature.recommendations.nodes.resolve', 'feature.recommendations.nodes.placement-upsert']],
      ['feature.promotions.nodes', ['feature.promotions.nodes.list-active', 'feature.promotions.nodes.apply-preview', 'feature.promotions.nodes.create']],
      ['feature.discovery.nodes', ['feature.discovery.nodes.search', 'feature.discovery.nodes.collection-upsert', 'feature.discovery.nodes.merch-rule-upsert']],
    ];
    for (const [name, ids] of cases) {
      const m = manifest(name);
      expect(m.name).toBe(name);
      expect(m.nodes.map((n) => n.typeId).sort()).toEqual([...ids].sort());
      expect(m.nodes.every((n) => n.role === 'action')).toBe(true);
    }
  });
  it('index.mjs exports a handler for every declared typeId', () => {
    expect(Object.keys(recoNodes).sort()).toEqual(manifest('feature.recommendations.nodes').nodes.map((n) => n.typeId).sort());
    expect(Object.keys(promoNodes).sort()).toEqual(manifest('feature.promotions.nodes').nodes.map((n) => n.typeId).sort());
    expect(Object.keys(discNodes).sort()).toEqual(manifest('feature.discovery.nodes').nodes.map((n) => n.typeId).sort());
  });
});

describe('merchandising node handlers — delegate to the ctx surface', () => {
  it('reco resolve/placement-upsert pass merged inputs through', async () => {
    const recommendations = {
      resolve: async (a: any) => ({ productIds: ['p2'], source: a.source ?? null, slot: a.slot }),
      upsertPlacement: async (a: any) => ({ placementId: 'rpl:1', slot: a.slot, source: a.source }),
    };
    expect(await recoNodes['feature.recommendations.nodes.resolve']({ features: { recommendations }, inputs: { orgId: 'o', slot: 'pdp' } }))
      .toEqual({ status: 'success', outputs: { productIds: ['p2'], source: null, slot: 'pdp' } });
    expect(await recoNodes['feature.recommendations.nodes.placement-upsert']({ features: { recommendations }, inputs: { orgId: 'o', slot: 'cart', source: 'cross_sell' } }))
      .toEqual({ status: 'success', outputs: { placementId: 'rpl:1', slot: 'cart', source: 'cross_sell' } });
  });
  it('validates inputs and fails host_capability_missing when the surface is absent', async () => {
    await expect(recoNodes['feature.recommendations.nodes.resolve']({ features: { recommendations: { resolve: async () => ({}) } }, inputs: {} })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(recoNodes['feature.recommendations.nodes.resolve']({ features: {} })).rejects.toMatchObject({ code: 'host_capability_missing' });
    await expect(discNodes['feature.discovery.nodes.merch-rule-upsert']({ features: { discovery: { search: async () => ({}), createMerchRule: async () => ({}) } }, inputs: { orgId: 'o', name: 'r' } })).rejects.toMatchObject({ code: 'validation_error' }); // no actions
  });
});

describe('promotions surface — agent-authored promotions land PROPOSED (architect finding 1)', () => {
  beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
  it('create() forces active:false so a run never makes a promotion live', async () => {
    await __resetPromotions();
    const surface = buildPromotionsSurface({ tenantId: 'default' });
    const out = await surface.create!({ orgId: 'o', name: 'Agent sale', type: 'product_discount', reward: { kind: 'percentage', value: 20 }, scope: { all: true } });
    expect(out.active).toBe(false);
    expect(out.proposed).toBe(true);
    const p = await getPromotion('default', 'o', String(out.promotionId));
    expect(p?.active).toBe(false); // persisted inactive
  });
});

describe('merchandising agent packs — tool-allowlisted to their own feature', () => {
  // CFP-1: the allowlists now name REGISTERED chat tools (openwop:<feature>.<verb>),
  // not node typeIds no provider projects (that RESOLUTION is enforced by
  // agent-allowlist-resolution.test.ts; the tools themselves by
  // merchandising-agent-tools.test.ts).
  it('load with the expected agentId + scoped tools', () => {
    const merch = loadAgentsFromManifest(packDir('feature.recommendations.agents'));
    expect(merch[0]?.agentId).toBe('feature.recommendations.agents.merchandiser');
    expect(merch[0]?.toolAllowlist).toContain('openwop:recommendations.create-placement');
    const pm = loadAgentsFromManifest(packDir('feature.promotions.agents'));
    expect(pm[0]?.agentId).toBe('feature.promotions.agents.promotions-manager');
    expect(pm[0]?.toolAllowlist).toContain('openwop:promotions.draft');
    const cur = loadAgentsFromManifest(packDir('feature.discovery.agents'));
    expect(cur[0]?.agentId).toBe('feature.discovery.agents.curator');
    expect(cur[0]?.toolAllowlist).toContain('openwop:discovery.create-collection');
  });
});
