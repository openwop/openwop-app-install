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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodes as funnelNodes } from '../../../packs/feature.funnels.nodes/index.mjs';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { buildFunnelsSurface } from '../src/features/funnels/surface.js';
import { getFunnel, __resetFunnels } from '../src/features/funnels/funnelsService.js';
import { createPage } from '../src/features/cms/cmsService.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
interface NodeManifest { name: string; nodes: { typeId: string; role: string }[] }
interface AgentManifest { name: string; agents: { agentId: string; toolAllowlist: string[] }[] }
interface ChainManifest { name: string; kind: string; chains: { chainId: string; capabilities: string[]; dag: { nodes: { typeId: string }[] } }[] }
const read = <T>(rel: string): T => JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')) as T;

const EXPECTED_NODE_IDS = [
  'feature.funnels.nodes.list',
  'feature.funnels.nodes.get',
  'feature.funnels.nodes.create',
  'feature.funnels.nodes.set-steps',
  'feature.funnels.nodes.step-stats',
];

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('feature.funnels.nodes', () => {
  it('manifest ↔ handlers parity, all role:action', () => {
    const m = read<NodeManifest>('packs/feature.funnels.nodes/pack.json');
    expect(m.nodes.map((n) => n.typeId).sort()).toEqual([...EXPECTED_NODE_IDS].sort());
    expect(m.nodes.every((n) => n.role === 'action')).toBe(true);
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
    expect(Object.keys(surface)).not.toContain('publish');

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
});

describe('feature.funnels.agents', () => {
  it('loads via the manifest runtime with a funnels-only tool allowlist', async () => {
    const m = read<AgentManifest>('packs/feature.funnels.agents/pack.json');
    expect(m.agents).toHaveLength(1);
    const allow = m.agents[0].toolAllowlist;
    // CFP-1: the Funnel Architect now names the REAL registered `openwop:funnels.*`
    // agent tools (list/get/step-stats read + draft action), not the dead
    // `feature.funnels.nodes.*` node typeIds that no provider projected.
    expect(allow.every((t) => t.startsWith('openwop:funnels.'))).toBe(true);
    const loaded = loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'feature.funnels.agents'));
    expect(loaded.map((a) => a.agentId)).toContain('feature.funnels.agents.funnel-architect');
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
