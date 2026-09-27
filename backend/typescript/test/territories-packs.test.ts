/**
 * Sales Territory Management — P5 pack tests (ADR 0272 / ADR 0014).
 * Validates the node + agent pack manifests and the node→surface wiring.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const NODES_DIR = join(REPO_ROOT, 'packs', 'feature.territories.nodes');
const AGENTS_DIR = join(REPO_ROOT, 'packs', 'feature.territories.agents');

interface NodesManifest { name: string; version: string; nodes: Array<{ typeId: string; role: string; version: string }>; runtime: { entry: string } }
interface AgentsManifest { name: string; agents: Array<{ agentId: string; persona: string; toolAllowlist: string[] }> }

describe('feature.territories.nodes pack', () => {
  const manifest = JSON.parse(readFileSync(join(NODES_DIR, 'pack.json'), 'utf8')) as NodesManifest;

  it('declares 7 read + 2 governed write nodes (v1.2.0), all role:"action"', () => {
    expect(manifest.name).toBe('feature.territories.nodes');
    // R2 TER2-B3/review M3 — bumped when `set-quota`'s advertised inputs changed
    // (`currency` is required above zero, `repSplits` REPLACES). A pack that describes
    // a shape the host refuses is the same lie as a prompt that does.
    expect(manifest.version).toBe('1.2.0');
    expect(manifest.nodes).toHaveLength(9);
    for (const n of manifest.nodes) expect(n.role, n.typeId).toBe('action');
    const ids = manifest.nodes.map((n) => n.typeId).sort();
    expect(ids).toEqual(
      [
        'feature.territories.nodes.active-model',
        'feature.territories.nodes.activate-model',
        'feature.territories.nodes.attainment',
        'feature.territories.nodes.list-models',
        'feature.territories.nodes.list-quotas',
        'feature.territories.nodes.list-rules',
        'feature.territories.nodes.list-territories',
        'feature.territories.nodes.preview',
        'feature.territories.nodes.set-quota',
      ].sort(),
    );
    // A5 — the write nodes are marked side-effectful
    for (const w of ['feature.territories.nodes.activate-model', 'feature.territories.nodes.set-quota']) {
      expect(manifest.nodes.find((n) => n.typeId === w)?.role).toBe('action');
    }
  });

  it('every node handler is exported and passes args through to the surface', async () => {
    const mod = await import(pathToFileURL(join(NODES_DIR, manifest.runtime.entry)).href);
    for (const name of ['listModels', 'activeModel', 'listTerritories', 'listRules', 'listQuotas', 'preview', 'attainment']) {
      expect(typeof mod[name], name).toBe('function');
    }

    // mock surface — capture the args the node forwards
    const calls: Record<string, unknown> = {};
    const surface = {
      listModels: async (a: unknown) => { calls.listModels = a; return { models: [{ modelId: 'm1' }], activeModelId: 'm1' }; },
      attainment: async (a: unknown) => { calls.attainment = a; return { period: '2026-Q1', territories: [{ territoryId: 't1' }], unassigned: { weightedPipeline: 0, won: 0 } }; },
    };
    const ctx = (inputs: unknown) => ({ features: { territories: surface }, inputs, config: {} });

    const models = await mod.listModels(ctx({ orgId: 'org1' }));
    expect(models.status).toBe('success');
    expect(models.outputs.models).toHaveLength(1);
    expect(models.outputs.activeModelId).toBe('m1');
    expect(calls.listModels).toEqual({ orgId: 'org1' });

    const att = await mod.attainment(ctx({ orgId: 'org1', modelId: 'm1', period: '2026-Q1' }));
    expect(att.status).toBe('success');
    expect(att.outputs.territories).toHaveLength(1);
    expect(calls.attainment).toEqual({ orgId: 'org1', modelId: 'm1', period: '2026-Q1' });
  });

  it('throws the canonical host_capability_missing when the surface is absent', async () => {
    const mod = await import(pathToFileURL(join(NODES_DIR, manifest.runtime.entry)).href);
    await expect(mod.listModels({ inputs: { orgId: 'o' }, config: {} })).rejects.toMatchObject({ code: 'host_capability_missing' });
  });
});

describe('feature.territories.agents pack', () => {
  const manifest = JSON.parse(readFileSync(join(AGENTS_DIR, 'pack.json'), 'utf8')) as AgentsManifest;

  it('ships the advisory Territory Planner, tool-allowlisted to READ nodes only', () => {
    expect(manifest.agents).toHaveLength(1);
    const planner = manifest.agents[0];
    expect(planner.agentId).toBe('feature.territories.agents.territory-planner');
    expect(planner.persona).toBe('Territory Planner');
    // allowlist is exactly the 7 read nodes — no write/activate/quota-set tool
    expect(planner.toolAllowlist).toHaveLength(7);
    for (const tool of planner.toolAllowlist) expect(tool).toMatch(/^openwop:territories\./);
    // no MUTATING tool (activate/set-quota/create/delete/archive/move) — reads only
    expect(planner.toolAllowlist.some((t) => /activate|set-quota|create|delete|archive|move|reassign/.test(t))).toBe(false);
  });
});
