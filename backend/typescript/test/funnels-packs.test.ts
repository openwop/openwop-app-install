/**
 * Funnels node + agent + chain packs (ADR 0294 Phase 6 / ADR 0058):
 *  - the node manifest declares the expected typeIds, all role:'action', and
 *    index.mjs exports a handler for each;
 *  - handlers delegate to ctx.features.funnels, validate inputs, and fail with
 *    host_capability_missing when the surface is absent;
 *  - the "agent proposes, human disposes" firewall: a surface-created funnel is
 *    a DRAFT (never published) and the surface exposes NO publish verb;
 *  - the agent pack loads with a tool-allowlist scoped to funnels nodes only;
 *  - the optimization chain pack parses, references only published typeIds,
 *    and declares no side-effect capability (proposal-only).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodes as funnelNodes } from '../../../packs/feature.funnels.nodes/index.mjs';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { buildFunnelsSurface } from '../src/features/funnels/surface.js';
import { getFunnel, __resetFunnels } from '../src/features/funnels/funnelsService.js';
import { createPage } from '../src/features/cms/cmsService.js';
import { readPackManifest } from './helpers/readPackManifest.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
interface NodeManifest { name: string; nodes: { typeId: string; role: string }[] }
interface AgentManifest { name: string; agents: { agentId: string; toolAllowlist: string[] }[] }
interface ChainManifest { name: string; kind: string; chains: { chainId: string; capabilities: string[]; dag: { nodes: { typeId: string }[] } }[] }
const read = <T>(rel: string): T => readPackManifest<T>(join(REPO_ROOT, rel));

const EXPECTED_NODE_IDS = [
  'feature.funnels.nodes.list',
  'feature.funnels.nodes.get',
  'feature.funnels.nodes.create',
  'feature.funnels.nodes.set-steps',
  'feature.funnels.nodes.step-stats',
  'feature.funnels.nodes.request-publish',
  // ADR 0948 P2 — pure blueprint plumbing (no surface call), so role:'action'.
  'feature.funnels.nodes.compose-step-page',
  'feature.funnels.nodes.step-result',
  'feature.funnels.nodes.collect-steps',
  // ADR 1023 — the blueprint's offer check and the copy model's one input.
  'feature.funnels.nodes.check-offers',
  'feature.funnels.nodes.offer-context',
];

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('feature.funnels.nodes', () => {
  it('manifest ↔ handlers parity; reads are action, the two draft writers side-effect (ADR 0948 P1)', () => {
    const m = read<NodeManifest>('packs/feature.funnels.nodes/pack.json');
    expect(m.nodes.map((n) => n.typeId).sort()).toEqual([...EXPECTED_NODE_IDS].sort());
    const role = new Map(m.nodes.map((n) => [n.typeId, n.role]));
    for (const w of ['create', 'set-steps', 'request-publish']) expect(role.get(`feature.funnels.nodes.${w}`), w).toBe('side-effect');
    for (const r of ['list', 'get', 'step-stats', 'compose-step-page', 'step-result', 'collect-steps', 'check-offers', 'offer-context']) expect(role.get(`feature.funnels.nodes.${r}`), r).toBe('action');
    expect(Object.keys(funnelNodes).sort()).toEqual([...EXPECTED_NODE_IDS].sort());
  });

  it('handlers fail closed without the surface and validate inputs', async () => {
    await expect(funnelNodes['feature.funnels.nodes.list']({ features: {}, inputs: { orgId: 'o' } }))
      .rejects.toMatchObject({ code: 'host_capability_missing' });
    const surface = { list: async () => ({ funnels: [] }) };
    await expect(funnelNodes['feature.funnels.nodes.list']({ features: { funnels: surface }, inputs: {} }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  it('agent-created funnels are DRAFTS and the surface has no publish verb', async () => {
    await __resetFunnels();
    const tenantId = 'pack-t';
    const orgId = 'pack-org';
    const page = await createPage({ tenantId, orgId, title: 'Pack Landing', createdBy: 'u' });
    const surface = buildFunnelsSurface({ tenantId } as never);
    // ADR 0948 P1b — a node may only REQUEST a publish (a human approves it); the
    // surface has no method that publishes.
    expect(Object.keys(surface).filter((k) => /publish/i.test(k))).toEqual(['requestPublish']);

    const out = await funnelNodes['feature.funnels.nodes.create']({
      features: { funnels: surface },
      inputs: { orgId, name: 'Agent Draft', steps: [{ kind: 'landing', pageId: page.pageId }] },
    });
    expect(out.status).toBe('success');
    expect(out.outputs.status).toBe('draft');
    expect(out.outputs.proposed).toBe(true);
    const stored = await getFunnel(tenantId, orgId, out.outputs.funnelId as string);
    expect(stored?.status).toBe('draft');

    const stats = await funnelNodes['feature.funnels.nodes.step-stats']({
      features: { funnels: surface },
      inputs: { orgId, funnelId: out.outputs.funnelId },
    });
    expect(stats.outputs.steps).toEqual({});
  });

  // ADR 1023 FN72WF-5 — an unknown funnel is a typed failure on BOTH reads, never a
  // recorded `{funnel:null}` / `{steps:{}}` success a model would read as "no traffic".
  // Sabotage-witnessed: `get` returning the null row as success turns this red.
  it('get and step-stats fail not_found for an unknown funnel', async () => {
    const surface = buildFunnelsSurface({ tenantId: 'pack-t' } as never);
    for (const id of ['feature.funnels.nodes.get', 'feature.funnels.nodes.step-stats']) {
      const r = await funnelNodes[id]({ features: { funnels: surface }, inputs: { orgId: 'pack-org', funnelId: 'funnel:missing' } }) as { status: string; error?: { code?: string } };
      expect(r.status, id).toBe('failed');
      expect(r.error?.code, id).toBe('not_found');
    }
  });

  // ADR 1023 D1 — the copy model's ONE input: closed projections, never raw rows.
  // Sabotage-witnessed: returning the raw product row turns the leak check red.
  it('offer-context projects the brief and the ONE active offered product, and refuses anything else', async () => {
    const brief = { brief: { id: 'b1', tenantId: 'ten', orgId: 'o', name: 'Spring launch', objective: 'Sell', productName: 'Course', productDescription: 'A course', industryVertical: 'edu', personaIds: [], channels: [], messaging: { primaryValueProp: 'Learn fast', toneOverride: '', proofPoints: ['p'], ctaStrategy: 'buy' }, budget: { total: 900 }, kernelReview: { runId: 'run-secret', requestedAt: 'x' }, createdBy: 'u', createdAt: 'x', updatedAt: 'y', status: 'confirmed' } };
    const products = { products: [
      { productId: 'p1', orgId: 'o', type: 'digital', name: 'Starter', description: 'Five lessons', price: 7, currency: 'USD', cost: 2, downloadAssetTokens: ['tok'], inventory: 3, tags: ['art'], categories: [], active: true, updatedAt: 'z' },
      { productId: 'p2', orgId: 'o', type: 'digital', name: 'Old', price: 9, currency: 'USD', active: false, tags: [], categories: [] },
    ] };
    const ok = await funnelNodes['feature.funnels.nodes.offer-context']({ inputs: { brief, products, productId: 'p1' } }) as { status: string; outputs: { context: Record<string, Record<string, unknown>> } };
    expect(ok.status).toBe('success');
    expect(ok.outputs.context.brief).toMatchObject({ name: 'Spring launch', objective: 'Sell', messaging: { primaryValueProp: 'Learn fast' } });
    expect(ok.outputs.context.product).toEqual({ name: 'Starter', description: 'Five lessons', type: 'digital', tags: ['art'] });
    const sent = JSON.stringify(ok.outputs);
    for (const leak of ['run-secret', 'tenantId', '"cost"', 'tok', '"price"', '"inventory"', 'updatedAt', 'createdBy', 'budget']) expect(sent, leak).not.toContain(leak);
    const inactive = await funnelNodes['feature.funnels.nodes.offer-context']({ inputs: { brief, products, productId: 'p2' } }) as { status: string; error?: { code?: string } };
    expect(inactive).toMatchObject({ status: 'failed', error: { code: 'offer_not_found' } });
    const foreign = await funnelNodes['feature.funnels.nodes.offer-context']({ inputs: { brief, products, productId: 'p9' } }) as { status: string; error?: { code?: string } };
    expect(foreign).toMatchObject({ status: 'failed', error: { code: 'offer_not_found' } });
    const noBrief = await funnelNodes['feature.funnels.nodes.offer-context']({ inputs: { products, productId: 'p1' } }) as { status: string; error?: { code?: string } };
    expect(noBrief).toMatchObject({ status: 'failed', error: { code: 'brief_not_found' } });
  });
});

describe('vendor.openwop-app.funnels.agents', () => {
  it('loads via the manifest runtime with a funnels tool allowlist (plus the read-before-write reads)', async () => {
    const m = read<AgentManifest>('packs/vendor.openwop-app.funnels.agents/pack.json');
    expect(m.agents).toHaveLength(1);
    const allow = m.agents[0].toolAllowlist;
    // CFP-1: the Funnel Architect now names the REAL registered `openwop:funnels.*`
    // agent tools (list/get/step-stats read + draft action), not the dead
    // `feature.funnels.nodes.*` node typeIds that no provider projected.
    // ADR 0948 D5 — plus the two reads the architect makes before it writes.
    const READ_BEFORE_WRITE = ['openwop:campaign-brief.get-brief', 'openwop:cms.get-page'];
    expect(allow.filter((t) => !READ_BEFORE_WRITE.includes(t)).every((t) => t.startsWith('openwop:funnels.'))).toBe(true);
    const loaded = loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'vendor.openwop-app.funnels.agents'));
    expect(loaded.map((a) => a.agentId)).toContain('vendor.openwop-app.funnels.agents.funnel-architect');
  });
});

describe('core.openwop.workflows.funnels (chain pack)', () => {
  it('is a proposal-only chain over published funnels typeIds', () => {
    const m = read<ChainManifest>('examples/workflow-chain-packs/funnels/pack.json');
    expect(m.kind).toBe('workflow-chain');
    const chain = m.chains.find((c) => c.chainId === 'funnels.optimize-step');
    expect(chain).toBeTruthy();
    expect(chain!.capabilities).toEqual([]); // read-only — no side-effect capability
    const typeIds = chain!.dag.nodes.map((n) => n.typeId);
    expect(typeIds).toContain('feature.funnels.nodes.get');
    expect(typeIds).toContain('feature.funnels.nodes.step-stats');
    // no write node in the proposal chain
    expect(typeIds.some((id) => id.endsWith('.create') || id.endsWith('.set-steps'))).toBe(false);
  });
});
